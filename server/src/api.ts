// The console's API. Everything the browser can ask for, in one place.
//
// Access rules, in short: if a console password is set you need a session; if
// one is not, you have to be on this machine. There is no third option where
// the console is reachable and open.
import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { config } from './config.js';
import {
  checkConsolePassword, consolePasswordSet, createSession, deleteToken, endSession,
  mintToken, revokeToken, setConsolePassword, validSession, type Scope,
} from './auth.js';
import { loadState, updateState } from './state.js';
import * as ollama from './ollama.js';
import { hostAvailable, readHostStatus, runHostAction, HostUnavailable, type HostAction } from './host.js';
import { sizing, MODELS, EMBED_MODELS, human } from './system.js';
import { proxyInFlight, routeTable } from './proxy.js';
import { throughput } from './metrics.js';
import { recent, summary } from './activity.js';
import * as tunnel from './tunnel.js';
import {
  badRequest, forbidden, HttpError, notFound, openEventStream, parseCookies,
  readJson, Router, sendJson, type Ctx,
} from './http.js';
import { logger } from './log.js';

const log = logger('api');

const SESSION_COOKIE = 'perch_session';

/**
 * "Is this request from the machine perch runs on?"
 *
 * Outside a container this is a real question with a real answer: the peer is
 * loopback or it is not.
 *
 * Inside one it is neither. Whatever forwards a published port rewrites the
 * source address on the way through — rootful podman makes it the network
 * gateway, rootless podman makes it the container's own address — and in
 * neither case does the result say anything about whether the original client
 * was the host or a laptop across the room. An address test there is not a
 * weak control, it is a control that does nothing while looking like one.
 *
 * So perch does not pretend. In a container the boundary is the port publish:
 * compose.yml offers the console on 127.0.0.1 only, and that — not this
 * function — is what keeps it to the machine. This says so at startup, and
 * the console shows a standing banner until a password is set, because with
 * one the protection is real again and does not depend on a compose file
 * nobody re-reads.
 */
const CONTAINER = fs.existsSync('/run/.containerenv') || fs.existsSync('/.dockerenv');

/** Every address this host answers on, so a rewritten source is recognised. */
function ownAddresses(): Set<string> {
  const out = new Set<string>(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) out.add(iface.address);
  }
  return out;
}

function defaultGateway(): string | null {
  try {
    // /proc/net/route, little-endian hex; the default route has destination 0.
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 2 && f[1] === '00000000' && f[2]) {
        const hex = f[2]!;
        const octets = [6, 4, 2, 0].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
        if (octets.every((n) => Number.isFinite(n))) return octets.join('.');
      }
    }
  } catch { /* not Linux, or no /proc */ }
  return null;
}

const GATEWAY = CONTAINER ? defaultGateway() : null;
const LOCAL_ADDRESSES = CONTAINER ? ownAddresses() : new Set(['127.0.0.1', '::1']);
if (GATEWAY) LOCAL_ADDRESSES.add(GATEWAY);

function isLoopback(req: http.IncomingMessage): boolean {
  const raw = req.socket.remoteAddress || '';
  const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return LOCAL_ADDRESSES.has(ip);
}

/** For the startup warning and the console's banner. */
export function localReachSummary(): { container: boolean; gateway: string | null } {
  return { container: CONTAINER, gateway: GATEWAY };
}

/**
 * The console's gate. A password beats everything. Without one, the credential
 * is being on the machine — genuinely checked outside a container, and inside
 * one delegated to the port publish for the reasons above.
 */
function requireConsole(ctx: Ctx): void {
  if (consolePasswordSet()) {
    const cookie = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
    if (!validSession(cookie)) throw new HttpError(401, 'sign in to the perch console');
    return;
  }
  if (!isLoopback(ctx.req)) {
    throw forbidden(
      'This console has no password, so it only answers on the machine it runs on. '
      + 'Set one with `./bin/perch console-password` to reach it from elsewhere.',
    );
  }
}

async function hostAction(action: HostAction, arg = '', timeoutMs?: number): Promise<{ ok: boolean; output: string }> {
  try {
    const r = await runHostAction(action, arg, timeoutMs);
    return { ok: r.ok, output: r.output };
  } catch (e) {
    if (e instanceof HostUnavailable) throw new HttpError(503, e.message);
    throw new HttpError(500, (e as Error).message);
  }
}

export function buildApi(): Router {
  const r = new Router();

  // ---------- session ----------

  r.get('/api/session', (ctx) => {
    sendJson(ctx.res, 200, {
      passwordSet: consolePasswordSet(),
      authenticated: consolePasswordSet()
        ? validSession(parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE])
        : isLoopback(ctx.req),
      loopback: isLoopback(ctx.req),
      // The console shows a standing warning when this is true and no
      // password is set: in a container, nothing but the port publish is
      // keeping other people out.
      containerised: localReachSummary().container,
      version: config.version,
    });
  });

  r.post('/api/session', async (ctx) => {
    const body = await readJson<{ password?: string }>(ctx.req);
    if (!consolePasswordSet()) throw badRequest('this console has no password set');
    if (!body.password || !checkConsolePassword(body.password)) {
      // A deliberate pause, so guessing at the password is slow even from
      // this machine.
      await new Promise((res) => setTimeout(res, 750));
      throw new HttpError(401, 'that password is not right');
    }
    const id = createSession();
    sendJson(ctx.res, 200, { ok: true }, {
      'Set-Cookie': `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    });
  });

  r.delete('/api/session', (ctx) => {
    endSession(parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE]);
    sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  });

  r.post('/api/console-password', async (ctx) => {
    requireConsole(ctx);
    const body = await readJson<{ password?: string | null }>(ctx.req);
    if (body.password === null || body.password === '') {
      if (!isLoopback(ctx.req)) throw forbidden('remove the password from the machine itself');
      setConsolePassword(null);
      sendJson(ctx.res, 200, { ok: true, passwordSet: false });
      return;
    }
    if (!body.password || body.password.length < 10) throw badRequest('use at least 10 characters');
    setConsolePassword(body.password);
    sendJson(ctx.res, 200, { ok: true, passwordSet: true });
  });

  // ---------- the status page ----------

  r.get('/api/overview', async (ctx) => {
    requireConsole(ctx);
    const [health, loaded, models] = await Promise.all([
      ollama.health(),
      ollama.loadedModels().catch(() => []),
      ollama.listModels().catch(() => []),
    ]);
    const hostInfo = readHostStatus();
    const s = loadState();
    sendJson(ctx.res, 200, {
      version: config.version,
      ollama: health,
      loaded,
      modelCount: models.length,
      modelBytes: models.reduce((n, m) => n + (m.size || 0), 0),
      host: hostInfo.status,
      hostPresent: hostInfo.present,
      hostStale: hostInfo.stale,
      sizing: sizing(),
      tunnel: await tunnel.tunnelStatus(),
      tern: {
        baseUrl: tunnel.ternBaseUrl(s.tunnel),
        baseUrlLiteral: tunnel.ternBaseUrlLiteral(s.tunnel),
        model: loaded[0]?.name || sizing().recommended.name,
      },
      settings: s.settings,
      tokens: s.tokens.filter((t) => !t.revokedAt).length,
      activity: summary(),
      throughput: throughput(),
      inFlight: proxyInFlight(),
      endpoint: { port: config.proxyPort, bind: config.proxyBind },
    });
  });

  // The live monitors. One event a second: cheap to produce, and the browser
  // draws from it rather than polling six endpoints.
  r.get('/api/stream', (ctx) => {
    requireConsole(ctx);
    const stream = openEventStream(ctx.res);
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      const hostInfo = readHostStatus();
      let loaded: ollama.LoadedModel[] = [];
      try { loaded = await ollama.loadedModels(); } catch { /* Ollama restarting; the gauges hold */ }
      stream.send('tick', {
        at: new Date().toISOString(),
        host: hostInfo.status,
        hostStale: hostInfo.stale,
        loaded,
        throughput: throughput(),
        inFlight: proxyInFlight(),
      });
    };

    const timer = setInterval(() => { void tick(); }, 1000);
    void tick();
    ctx.res.on('close', () => { stopped = true; clearInterval(timer); stream.close(); });
  });

  // ---------- models ----------

  r.get('/api/models', async (ctx) => {
    requireConsole(ctx);
    const [installed, loaded] = await Promise.all([
      ollama.listModels().catch(() => []),
      ollama.loadedModels().catch(() => []),
    ]);
    sendJson(ctx.res, 200, {
      installed,
      loaded,
      catalog: MODELS,
      embedCatalog: EMBED_MODELS,
      sizing: sizing(),
      totalBytes: installed.reduce((n, m) => n + (m.size || 0), 0),
      totalHuman: human(installed.reduce((n, m) => n + (m.size || 0), 0)),
    });
  });

  // Downloads stream their progress: a 20 GB model is a long wait, and a
  // progress bar that moves is the difference between "working" and "stuck".
  r.get('/api/models/pull', async (ctx) => {
    requireConsole(ctx);
    const name = ctx.url.searchParams.get('name') || '';
    if (!/^[A-Za-z0-9._\/:-]{1,120}$/.test(name)) throw badRequest('that is not a model name');
    const stream = openEventStream(ctx.res);
    const abort = new AbortController();
    ctx.res.on('close', () => abort.abort());
    try {
      await ollama.pullModel(name, (p) => stream.send('progress', p), abort.signal);
      stream.send('done', { name });
    } catch (e) {
      if (!abort.signal.aborted) stream.send('failed', { error: (e as Error).message });
    } finally {
      stream.close();
    }
  });

  r.post('/api/models/delete', async (ctx) => {
    requireConsole(ctx);
    const { name } = await readJson<{ name?: string }>(ctx.req);
    if (!name) throw badRequest('which model?');
    await ollama.deleteModel(name);
    sendJson(ctx.res, 200, { ok: true });
  });

  r.post('/api/models/load', async (ctx) => {
    requireConsole(ctx);
    const { name } = await readJson<{ name?: string }>(ctx.req);
    if (!name) throw badRequest('which model?');
    await ollama.loadModel(name);
    sendJson(ctx.res, 200, { ok: true });
  });

  r.post('/api/models/unload', async (ctx) => {
    requireConsole(ctx);
    const { name } = await readJson<{ name?: string }>(ctx.req);
    if (!name) throw badRequest('which model?');
    await ollama.unloadModel(name);
    sendJson(ctx.res, 200, { ok: true });
  });

  r.get('/api/models/show', async (ctx) => {
    requireConsole(ctx);
    const name = ctx.url.searchParams.get('name') || '';
    if (!name) throw badRequest('which model?');
    sendJson(ctx.res, 200, await ollama.showModel(name));
  });

  // ---------- tokens ----------

  r.get('/api/tokens', (ctx) => {
    requireConsole(ctx);
    // Hashes never leave the server, not even to the console.
    const tokens = loadState().tokens.map(({ hash, ...rest }) => rest);
    sendJson(ctx.res, 200, { tokens });
  });

  r.post('/api/tokens', async (ctx) => {
    requireConsole(ctx);
    const body = await readJson<{ name?: string; scopes?: Scope[] }>(ctx.req);
    const scopes = (body.scopes ?? ['use']).filter((s): s is Scope => s === 'use' || s === 'manage');
    const { token, record } = mintToken(body.name ?? 'Tern', scopes.length ? scopes : ['use']);
    const { hash, ...safe } = record;
    // The only time the token itself is ever sent anywhere.
    sendJson(ctx.res, 201, { token, record: safe });
  });

  r.post('/api/tokens/:id/revoke', (ctx) => {
    requireConsole(ctx);
    if (!revokeToken(ctx.params.id!)) throw notFound('no such token');
    sendJson(ctx.res, 200, { ok: true });
  });

  r.delete('/api/tokens/:id', (ctx) => {
    requireConsole(ctx);
    if (!deleteToken(ctx.params.id!)) throw notFound('no such token');
    sendJson(ctx.res, 200, { ok: true });
  });

  // ---------- the tunnel ----------

  r.get('/api/tunnel', async (ctx) => {
    requireConsole(ctx);
    const t = loadState().tunnel;
    sendJson(ctx.res, 200, {
      config: t,
      status: await tunnel.tunnelStatus(),
      publicKey: tunnel.publicKey(),
      ternBaseUrl: tunnel.ternBaseUrl(t),
      ternBaseUrlLiteral: tunnel.ternBaseUrlLiteral(t),
      setupCommand: tunnel.ternSetupCommand(t),
      setupManual: tunnel.ternSetupManual(t),
      sshCommand: tunnel.sshCommandPreview(t),
      localPort: config.proxyPort,
    });
  });

  r.put('/api/tunnel', async (ctx) => {
    requireConsole(ctx);
    const body = await readJson<Record<string, unknown>>(ctx.req);
    const next = await tunnel.saveTunnel({
      host: typeof body.host === 'string' ? body.host.trim() : undefined,
      user: typeof body.user === 'string' ? body.user.trim() : undefined,
      sshPort: typeof body.sshPort === 'number' ? body.sshPort : undefined,
      remoteBind: typeof body.remoteBind === 'string' ? body.remoteBind.trim() : undefined,
      remotePort: typeof body.remotePort === 'number' ? body.remotePort : undefined,
      torProxy: typeof body.torProxy === 'string' ? body.torProxy.trim() : undefined,
    });
    // Rendering the unit needs root, so it happens on the host side.
    const applied = await hostAction('tunnel.configure', '', 30_000).catch((e: HttpError) => ({ ok: false, output: e.message }));
    sendJson(ctx.res, 200, { config: next, applied });
  });

  // One paste, and the rest of the setup happens: save the address, rewrite
  // the unit, start the tunnel, make a token if there is not one, and hand
  // back the two values Tern needs. This is the step that used to be "read an
  // IP off a terminal and retype it into five form fields".
  r.post('/api/tunnel/pair', async (ctx) => {
    requireConsole(ctx);
    const body = await readJson<{ text?: string }>(ctx.req);
    const before = loadState().tunnel;
    if (!before.host) throw badRequest('Say where Tern runs first — perch needs the SSH host before it can pair.');

    const { bind, port } = tunnel.parsePairing(body.text ?? '');
    const config = await tunnel.saveTunnel({ remoteBind: bind, remotePort: port });

    // Render the unit from the new settings, then bring it up. Already
    // running means the address changed, so it is a restart rather than a
    // start.
    //
    // None of these three is allowed to fail the pairing. The address has
    // already been saved and is the hard-won part; if the helper is missing
    // or systemd refuses, the right answer is to say which step failed and
    // leave the rest in place, not to throw the address away and make
    // somebody fetch it from the other machine again.
    const attempt = async (a: HostAction, ms: number): Promise<{ ok: boolean; output: string }> =>
      hostAction(a, '', ms).catch((e) => ({ ok: false, output: (e as Error).message }));

    const configured = await attempt('tunnel.configure', 30_000);
    const wasActive = (await tunnel.tunnelStatus()).active === 'active';
    const started = await attempt(wasActive ? 'tunnel.restart' : 'tunnel.start', 60_000);
    // A tunnel that does not come back after a reboot is the most common way
    // this quietly stops working, so it is switched on as part of pairing.
    const atBoot = await attempt('tunnel.enable', 30_000);

    // Every install needs at least one token, and asking for it as a separate
    // step is a step nobody would ever want to skip.
    const existing = loadState().tokens.filter((t) => !t.revokedAt);
    let token: string | null = null;
    if (existing.length === 0) {
      token = mintToken('Tern', ['use', 'manage']).token;
    }

    sendJson(ctx.res, 200, {
      config,
      baseUrl: tunnel.ternBaseUrl(config),
      baseUrlLiteral: tunnel.ternBaseUrlLiteral(config),
      token,
      hasExistingToken: existing.length > 0,
      status: await tunnel.tunnelStatus(),
      steps: { configured, started, atBoot },
    });
  });

  r.post('/api/tunnel/key', async (ctx) => {
    requireConsole(ctx);
    sendJson(ctx.res, 200, { publicKey: await tunnel.generateKey() });
  });

  r.post('/api/tunnel/:action', async (ctx) => {
    requireConsole(ctx);
    const a = ctx.params.action!;
    const allowed = ['start', 'stop', 'restart', 'enable', 'disable', 'logs'];
    if (!allowed.includes(a)) throw notFound('no such tunnel action');
    const result = await hostAction(`tunnel.${a}` as HostAction, '', 60_000);
    sendJson(ctx.res, 200, result);
  });

  // ---------- containers, boot, logs ----------

  r.post('/api/containers/:action', async (ctx) => {
    requireConsole(ctx);
    const a = ctx.params.action!;
    const map: Record<string, HostAction> = {
      start: 'containers.start', stop: 'containers.stop',
      restart: 'containers.restart', pull: 'containers.pull',
    };
    const action = map[a];
    if (!action) throw notFound('no such action');
    const body = await readJson<{ service?: string }>(ctx.req).catch(() => ({} as { service?: string }));
    const service = body.service === 'perch' || body.service === 'ollama' ? body.service : '';
    // Pulling images and starting containers are minutes-long jobs on a slow
    // line, so they get a long leash.
    sendJson(ctx.res, 200, await hostAction(action, service, 15 * 60_000));
  });

  r.post('/api/boot/:state', async (ctx) => {
    requireConsole(ctx);
    const s = ctx.params.state!;
    if (s !== 'enable' && s !== 'disable') throw notFound('enable or disable');
    sendJson(ctx.res, 200, await hostAction(`boot.${s}` as HostAction, '', 30_000));
  });

  r.get('/api/logs/:service', async (ctx) => {
    requireConsole(ctx);
    const s = ctx.params.service!;
    if (s === 'tunnel') { sendJson(ctx.res, 200, await hostAction('tunnel.logs', '', 20_000)); return; }
    if (s !== 'perch' && s !== 'ollama') throw notFound('no such service');
    sendJson(ctx.res, 200, await hostAction('logs', s, 30_000));
  });

  // ---------- settings ----------

  r.get('/api/settings', (ctx) => {
    requireConsole(ctx);
    sendJson(ctx.res, 200, {
      settings: loadState().settings,
      proxy: { routes: routeTable(), maxConcurrent: config.maxConcurrent, port: config.proxyPort },
      hostAvailable: hostAvailable(),
    });
  });

  r.put('/api/settings', async (ctx) => {
    requireConsole(ctx);
    const body = await readJson<{ allowManage?: boolean; keepAlive?: string; unloadWhenIdle?: boolean }>(ctx.req);
    if (body.keepAlive !== undefined && !/^-?\d+[smh]?$/.test(body.keepAlive)) {
      throw badRequest('Keep loaded wants a duration such as 30s, 10m or 1h — or -1 to never unload.');
    }
    const next = updateState((s) => {
      if (body.allowManage !== undefined) s.settings.allowManage = Boolean(body.allowManage);
      if (body.keepAlive !== undefined) s.settings.keepAlive = body.keepAlive;
      if (body.unloadWhenIdle !== undefined) s.settings.unloadWhenIdle = Boolean(body.unloadWhenIdle);
    }).settings;
    sendJson(ctx.res, 200, { settings: next });
  });

  // Ollama's own knobs live in .env, because Ollama reads them at startup.
  // Changing one writes the file and says so; it takes effect on restart.
  r.put('/api/ollama-env', async (ctx) => {
    requireConsole(ctx);
    const body = await readJson<{ key?: string; value?: string }>(ctx.req);
    const allowed = [
      'OLLAMA_NUM_PARALLEL', 'OLLAMA_MAX_LOADED_MODELS', 'OLLAMA_MAX_QUEUE',
      'OLLAMA_KV_CACHE_TYPE', 'OLLAMA_FLASH_ATTENTION', 'OLLAMA_KEEP_ALIVE',
      'OLLAMA_MEM_LIMIT', 'PERCH_MAX_CONCURRENT',
    ];
    if (!body.key || !allowed.includes(body.key)) throw badRequest('that is not a settable key');
    if (!body.value || !/^[A-Za-z0-9_.-]{1,32}$/.test(body.value)) throw badRequest('that value is not allowed');
    sendJson(ctx.res, 200, await hostAction('env.set', `${body.key}=${body.value}`, 20_000));
  });

  // ---------- activity ----------

  r.get('/api/activity', (ctx) => {
    requireConsole(ctx);
    const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 100, config.activityLimit);
    sendJson(ctx.res, 200, { entries: recent(limit), summary: summary() });
  });

  return r;
}

export function apiErrorHandler(res: http.ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  log.error('unhandled', (err as Error)?.message ?? String(err));
  sendJson(res, 500, { error: 'something went wrong on this end' });
}
