// The model endpoint. This is the one listener that anything outside this
// machine ever speaks to, so it is deliberately dull: a fixed table of the
// endpoints Tern actually uses, a bearer token on every one of them, and a
// straight pipe to Ollama for anything that passes.
//
// It is a pipe, not a parser. Request and response bodies are streamed
// through untouched, which is what keeps `/api/chat` answering token by token
// instead of arriving in one lump at the end — and it means perch never has
// the whole of anyone's email in memory, let alone on disk.
import http from 'node:http';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { type ServiceDef, type Route } from './services.js';
import { authenticate, isBlocked, noteAuthFailure, noteAuthSuccess, noteTokenUse, type Scope } from './auth.js';
import { loadState } from './state.js';
import { record } from './activity.js';
import { recordGeneration, recordTokens } from './metrics.js';
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
  const upstream = new URL(service.upstream);
  const log = logger(`proxy:${service.id}`);

  const server = http.createServer((req, res) => {
    const started = Date.now();
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
