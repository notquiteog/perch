// The model endpoint. This is the one listener that anything outside this
// machine ever speaks to, so it is deliberately dull: a fixed table of the
// endpoints Tern actually uses, a bearer token on every one of them, and a
// straight pipe to Ollama for anything that passes.
//
// It is a pipe, not a parser. Request and response bodies are streamed
// through untouched, which is what keeps `/api/chat` answering token by token
// instead of arriving in one lump at the end — and it means perch never has
// the whole of anyone's email in memory, let alone on disk.
//
// The exceptions are marked `translated` in the route table, naming the
// handler, so they cannot be a thing somebody has to remember. There are two
// backends being translated for: Anthropic's `/v1/messages` is a shape Ollama
// does not serve, so `anthropic.ts` rewrites it, and OpenAI's
// `/v1/images/generations` is a shape ComfyUI does not serve, so `images.ts`
// turns it into a workflow graph and back.
//
// Everything before the dispatch below — the token, the scope, the block list,
// the size ceiling, the concurrency backstop, the activity ring — runs for a
// translated route exactly as it does for a piped one. What differs is only
// what happens after, and both translators open by saying precisely which part
// of the promise above they cannot keep.
import http from 'node:http';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { type ServiceDef, type Route } from './services.js';
import { authenticate, isBlocked, noteAuthFailure, noteAuthSuccess, noteTokenUse, type Scope } from './auth.js';
import { loadState } from './state.js';
import { record } from './activity.js';
import { recordGeneration, recordTokens } from './metrics.js';
import { handleCountTokens, handleMessages } from './anthropic.js';
import { upstreamFor } from './upstream.js';
import { handleImageModels, handleImages } from './images.js';
import { logger } from './log.js';

const log = logger('proxy');

// Shared across every service, because they share one GPU: two image
// generations and a chat completion at once is the same card three times over.
let inFlight = 0;

/** Headers that describe one hop and must not be copied to the next. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
  // Ollama has no use for the caller's credentials, and forwarding them would
  // put the token in a second process's memory for no reason.
  'authorization',
]);

function clientIp(req: http.IncomingMessage): string {
  // Deliberately the real peer address and never X-Forwarded-For: through the
  // tunnel the peer is always loopback, and a header any caller can set is
  // worse than useless for blocking.
  return req.socket.remoteAddress || 'unknown';
}

function send(res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...extra });
  res.end(payload);
}

export function createProxyServer(service: ServiceDef): http.Server {
  const log = logger(`proxy:${service.id}`);

  const server = http.createServer((req, res) => {
    const started = Date.now();
    // Resolved per request rather than once at startup, so changing a
    // service's proxy in the console takes effect on the next call instead of
    // on the next restart — which matters most for exactly this setting,
    // because a wrong proxy is a service that has stopped answering.
    let upstream: URL;
    let agent: http.Agent | undefined;
    try {
      const resolved = upstreamFor(service.upstream, loadState().settings.proxies?.[service.id]);
      upstream = resolved.url;
      agent = resolved.agent;
    } catch (e) {
      // A proxy that will not parse is refused rather than ignored. Falling
      // back to a direct connection would send the traffic somewhere the
      // operator specifically said not to, and say nothing about it.
      send(res, 502, { error: `this service's proxy setting is not usable: ${(e as Error).message}` });
      record({
        at: new Date().toISOString(), service: service.id, method: (req.method || 'GET').toUpperCase(),
        path: (req.url || '/').split('?')[0] || '/', status: 502, ms: 0, bytes: 0,
        token: null, ip: clientIp(req), note: 'bad proxy setting',
      });
      return;
    }
    const ip = clientIp(req);
    const path = (req.url || '/').split('?')[0] || '/';
    const method = (req.method || 'GET').toUpperCase();
    let tokenName: string | null = null;

    const finish = (status: number, note?: string, bytes = 0): void => {
      record({ at: new Date().toISOString(), service: service.id, method, path, status, ms: Date.now() - started, bytes, token: tokenName, ip, note });
    };

    // A reachability check for the console and for whoever is debugging the
    // tunnel at the far end. It says that perch is listening and nothing else:
    // no version, no models, no token required.
    // Reachability, for the console and for whoever is debugging the tunnel at
    // the far end. It says perch is listening and which service this port is,
    // and nothing else: no version, no models, no token required.
    if (method === 'GET' && path === '/healthz') {
      send(res, 200, { ok: true, service: 'perch', endpoint: service.id });
      finish(200);
      return;
    }

    const route: Route | undefined = service.routes.find((r) => r.method === method && r.path === path);
    if (!route) {
      // Same answer whether the path is unknown to Ollama or simply not
      // allowed here — there is nothing to gain by helping a scanner map the
      // difference.
      send(res, 404, { error: 'not found' });
      finish(404, 'no route');
      return;
    }

    // The token is checked before the block is consulted, and this order
    // matters more than it looks.
    //
    // Everything arrives here through the tunnel, so every request has the
    // same peer address — loopback. Blocking by address is therefore blocking
    // everything: one client with an empty API key field trips the counter and
    // locks out the correctly configured ones too, and, worse, refuses the
    // right token afterwards. Somebody who fixes their settings then waits
    // fifteen minutes for a block they can no longer trigger.
    //
    // A valid token is proof this is not a guess, so it is honoured whatever
    // the counter says and clears it. A guesser never has one, so they still
    // collect failures and are still refused. The cost of checking first is a
    // hash and a constant-time compare.
    const need: Scope = route.manage ? 'manage' : 'use';
    const auth = authenticate(req.headers.authorization, need);

    if (!auth.ok) {
      if (isBlocked(ip)) {
        send(res, 429, { error: 'too many failed authentications from this address' }, { 'Retry-After': '900' });
        finish(429, 'blocked');
        return;
      }
      if (auth.reason === 'scope') {
        // A real token that is not allowed this operation: worth saying so
        // plainly, because the fix is a scope, not a new token.
        tokenName = auth.token?.name ?? null;
        send(res, 403, { error: `this token may not ${route.path.includes('pull') ? 'pull' : 'delete'} models` });
        finish(403, 'scope');
        return;
      }
      noteAuthFailure(ip);
      send(res, 401, {
        error: auth.reason === 'missing'
          ? 'no API key was sent. In Tern this is Admin → AI model → API key; perch issues one under Settings → API tokens.'
          : 'that API key is not valid here. Make a new one under Settings → API tokens in perch.',
      }, { 'WWW-Authenticate': 'Bearer realm="perch"' });
      finish(401, auth.reason);
      return;
    }

    tokenName = auth.token!.name;
    noteAuthSuccess(ip);

    if (route.manage && !loadState().settings.allowManage) {
      send(res, 403, { error: 'model management is switched off on this perch' });
      finish(403, 'manage off');
      return;
    }

    const len = Number.parseInt(String(req.headers['content-length'] ?? '0'), 10);
    if (Number.isFinite(len) && len > config.maxBodyBytes) {
      send(res, 413, { error: 'request too large' });
      finish(413, 'too large');
      return;
    }

    if (route.generating && inFlight >= config.maxConcurrent) {
      send(res, 503, { error: 'busy: too many generations in flight' }, { 'Retry-After': '5' });
      finish(503, 'busy');
      return;
    }

    // Recording the use writes the state file, so it happens once per accepted
    // request rather than per chunk.
    noteTokenUse(auth.token!.id, ip);

    // The translated shapes. Everything above this line has already run, so
    // these paths are authenticated, scoped, size-capped and blocked exactly
    // like a piped one; only the body handling below differs.
    if (route.translated) {
      if (route.generating) inFlight += 1;
      const finished = (r: { status: number; bytes: number; tokens: number; ttftMs: number | null }): void => {
        if (route.generating) {
          inFlight -= 1;
          if (r.tokens) recordTokens(r.tokens);
          recordGeneration(r.tokens, Date.now() - started, r.ttftMs);
        }
        finish(r.status, undefined, r.bytes);
      };
      // Dispatched on the name in the route table rather than on the path, so
      // adding a translated route is one line there and not two places here.
      const nothing = { bytes: 0, tokens: 0, ttftMs: null };
      const work = (() => {
        switch (route.translated) {
          // Each carries the agent. A translator left without one would reach
          // the upstream directly while every piped route on the same service
          // went through the operator's proxy — succeeding, and saying nothing
          // about the difference.
          case 'messages': return handleMessages(req, res, service.upstream, started, agent);
          case 'count_tokens': return handleCountTokens(req, res).then((status) => ({ status, ...nothing }));
          case 'images': return handleImages(req, res, service.upstream, started, agent);
          case 'image_models': return handleImageModels(res, service.upstream, agent).then((status) => ({ status, ...nothing }));
        }
      })();
      void work.then(finished, (err: Error) => {
        // The handler owns its own error responses; reaching here means it
        // threw before sending one, which must not leave the socket open.
        log.warn(`translated ${method} ${path} failed`, err.message);
        if (!res.headersSent) send(res, 500, { error: 'the request could not be translated' });
        else res.end();
        finished({ status: 500, bytes: 0, tokens: 0, ttftMs: null });
      });
      return;
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    }
    headers.host = upstream.host;

    if (route.generating) inFlight += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (route.generating) inFlight -= 1;
    };

    let bytes = 0;
    // Token accounting for the console's monitors. Newlines only: see
    // metrics.ts for why counting them is enough and why nothing else about
    // the body is looked at.
    let tokens = 0;
    let firstByteAt: number | null = null;
    const upstreamReq = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || 80,
        method,
        path: req.url,
        headers,
        ...(agent ? { agent } : {}),
      },
      (upstreamRes) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
        }
        res.writeHead(upstreamRes.statusCode || 502, out);
        upstreamRes.on('data', (c: Buffer) => {
          bytes += c.length;
          if (firstByteAt === null) firstByteAt = Date.now();
          if (route.generating) {
            let n = 0;
            for (let i = 0; i < c.length; i += 1) if (c[i] === 0x0a) n += 1;
            if (n) { tokens += n; recordTokens(n); }
          }
        });
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => {
          release();
          if (route.generating) {
            recordGeneration(tokens, Date.now() - started, firstByteAt === null ? null : firstByteAt - started);
          }
          finish(upstreamRes.statusCode || 0, undefined, bytes);
        });
        upstreamRes.on('error', () => { release(); res.destroy(); finish(502, 'upstream stream error', bytes); });
      },
    );

    // Long generations are normal; a socket with nothing on it for a quarter
    // of an hour is not.
    upstreamReq.setTimeout(config.upstreamIdleMs, () => {
      upstreamReq.destroy(new Error('upstream idle timeout'));
    });

    upstreamReq.on('error', (err) => {
      release();
      log.warn(`upstream ${method} ${path} failed`, (err as Error).message);
      if (!res.headersSent) send(res, 502, { error: 'the model server is not answering', detail: (err as Error).message });
      else res.destroy();
      finish(502, 'upstream error', bytes);
    });

    // If the caller hangs up mid-generation, tear the upstream request down
    // too. Without this Ollama keeps generating into a socket nobody is
    // reading, and the GPU stays busy on an answer no one will ever see.
    res.on('close', () => {
      if (!res.writableFinished) {
        upstreamReq.destroy();
        release();
      }
    });

    req.pipe(upstreamReq);
    req.on('error', () => { upstreamReq.destroy(); release(); });
  });

  // Slowloris and friends: a caller that opens a socket and dawdles over the
  // headers should not be able to hold one open indefinitely.
  server.headersTimeout = 30_000;
  server.requestTimeout = 0; // a long upload of a multimodal prompt is legitimate
  server.keepAliveTimeout = 65_000;

  return server;
}

/** For the console's status panel. Shared across services. */
export function proxyInFlight(): number {
  return inFlight;
}

/** What a service will answer, for the console to show. */
export function routeTable(service: ServiceDef): Array<{ method: string; path: string; scope: Scope }> {
  return service.routes.map(({ method, path, manage }) => ({ method, path, scope: manage ? 'manage' : 'use' }));
}

/** Node's Readable, for tests that want to drive the server without a socket. */
export type { Readable };
