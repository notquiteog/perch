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
import { cancelPull, listPulls, startPull, watchPull } from './pulls.js';
import { configuredSpeechModel, currentSpeechModel, validSpeechModel, voiceStatus } from './voice.js';
import { hostAvailable, readHostStatus, runHostAction, HostUnavailable, type HostAction } from './host.js';
import { sizing, MODELS, EMBED_MODELS, UNCENSORED_MODELS, human } from './system.js';
import { mediaOverview, mediaModel, MODEL_VOLUMES } from './media.js';
import { containerDef, containerForTuningKey, containerSizes, floorFor, memBytes, tuningReport, validCpus, validMem } from './containers.js';
import { proxyInFlight, routeTable } from './proxy.js';
import { SERVICES, SERVICE_VRAM_HINT, isServiceId } from './services.js';
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
      connections: s.connections.map((c) => ({
        ...c,
        status: tunnel.statusOf(c),
        ternBaseUrl: tunnel.ternBaseUrl(c),
      })),
      endpointUp: await tunnel.localEndpointUp(),
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

  // Asked of Ollama on every call, and honest when it cannot be.
  //
  // The two lists used to be caught into empty arrays, which made an Ollama
  // that was down indistinguishable from one holding nothing. On the machine
  // whose whole job is holding models, that is the one mistake this page must
  // not make quietly.
  r.get('/api/models', async (ctx) => {
    requireConsole(ctx);
    const live = await ollama.liveModels();
    const bytes = live.installed.reduce((n, m) => n + (m.size || 0), 0);
    sendJson(ctx.res, 200, {
      ok: live.ok,
      error: live.error,
      at: live.at,
      installed: live.installed,
      loaded: live.loaded,
      pulls: listPulls(),
      catalog: MODELS,
      embedCatalog: EMBED_MODELS,
      uncensoredCatalog: UNCENSORED_MODELS,
      sizing: sizing(),
      totalBytes: bytes,
      totalHuman: human(bytes),
    });
  });

  const MODEL_NAME = /^[A-Za-z0-9._\/:-]{1,120}$/;

  /**
   * Ollama's own reasons, kept.
   *
   * The catch-all below answers "something went wrong on this end" and hides
   * the message, which is right for a bug here and wrong for every failure in
   * this section: "ollama has no model called X", "this model is still on the
   * machine after the delete was accepted" and "does not support generate"
   * are the whole answer, and a console that swallows them leaves the
   * operator with a button that does nothing and no way to find out why.
   */
  const relaying = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, (e as Error)?.message ?? String(e));
    }
  };

  // Downloads stream their progress: a 20 GB model is a long wait, and a
  // progress bar that moves is the difference between "working" and "stuck".
  //
  // The download is a job, not this request. Closing the console, switching
  // tab or reloading detaches the stream and leaves the download running —
  // the page picks it back up from the `pulls` list above — and the only
  // thing that stops one is /api/models/cancel.
  r.get('/api/models/pull', async (ctx) => {
    requireConsole(ctx);
    const name = ctx.url.searchParams.get('name') || '';
    if (!MODEL_NAME.test(name)) throw badRequest('that is not a model name');
    startPull(name, async (emit, signal) => {
      await ollama.pullModel(name, emit, signal);
    });
    const stream = openEventStream(ctx.res);
    await new Promise<void>((resolve) => {
      let done = false;
      let detach: (() => void) | null = null;
      const stop = (): void => { if (done) return; done = true; detach?.(); resolve(); };
      detach = watchPull(name, (view) => {
        stream.send('progress', view);
        if (view.state === 'done') { stream.send('done', view); stop(); }
        else if (view.state !== 'running') { stream.send('failed', { error: view.error ?? view.state, ...view }); stop(); }
      });
      if (!detach) { stream.send('failed', { error: 'that download is no longer running' }); resolve(); return; }
      // The console going away detaches the watcher and nothing else.
      ctx.res.on('close', stop);
    });
    stream.close();
  });

  r.post('/api/models/cancel', async (ctx) => {
    requireConsole(ctx);
    const { name } = await readJson<{ name?: string }>(ctx.req);
    if (!name) throw badRequest('which model?');
    sendJson(ctx.res, 200, { cancelled: cancelPull(name) });
  });

  // The answer is the list, so the page redraws from what is actually on the
  // machine rather than from the assumption that the row it asked about is
  // gone. See ollama.deleteModel for why a 200 is not enough on its own.
  r.post('/api/models/delete', async (ctx) => {
    requireConsole(ctx);
    const { name } = await readJson<{ name?: string }>(ctx.req);
    if (!name) throw badRequest('which model?');
    if (!MODEL_NAME.test(name)) throw badRequest('that is not a model name');
    const installed = await relaying(() => ollama.deleteModel(name));
    const loaded = await ollama.loadedModels().catch(() => []);
    sendJson(ctx.res, 200, { ok: true, deleted: name, installed, loaded });
  });

  r.post('/api/models/load', async (ctx) => {
    requireConsole(ctx);
    const { name } = await readJson<{ name?: string }>(ctx.req);
    if (!name) throw badRequest('which model?');
    await relaying(() => ollama.loadModel(name));
    sendJson(ctx.res, 200, { ok: true });
  });

  r.post('/api/models/unload', async (ctx) => {
    requireConsole(ctx);
    const { name } = await readJson<{ name?: string }>(ctx.req);
    if (!name) throw badRequest('which model?');
    await relaying(() => ollama.unloadModel(name));
    sendJson(ctx.res, 200, { ok: true });
  });

  r.get('/api/models/show', async (ctx) => {
    requireConsole(ctx);
    const name = ctx.url.searchParams.get('name') || '';
    if (!name) throw badRequest('which model?');
    sendJson(ctx.res, 200, await relaying(() => ollama.showModel(name)));
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

  // ---------- connections ----------
  //
  // Several machines can use this one GPU, so each gets its own account on the
  // far side, its own key and its own systemd unit. Nothing is shared, which
  // is what makes removing one safe for the others.

  const shape = (c: ReturnType<typeof tunnel.getConnection>): Record<string, unknown> => ({
    ...c,
    status: tunnel.statusOf(c),
    publicKey: tunnel.publicKeyOf(c),
    ternBaseUrl: tunnel.ternBaseUrl(c),
    ternBaseUrlLiteral: tunnel.ternBaseUrlLiteral(c),
    forwards: tunnel.forwardsFor(c),
    ternUrls: tunnel.ternUrls(c),
    setupCommand: tunnel.setupCommand(c),
    setupManual: tunnel.setupManual(c),
    uninstallCommand: tunnel.uninstallCommand(c),
    sshCommand: tunnel.sshCommandPreview(c),
  });

  r.get('/api/connections', async (ctx) => {
    requireConsole(ctx);
    sendJson(ctx.res, 200, {
      connections: tunnel.listConnections().map(shape),
      endpointUp: await tunnel.localEndpointUp(),
      localPort: config.proxyPort,
    });
  });

  r.post('/api/connections', async (ctx) => {
    requireConsole(ctx);
    const b = await readJson<Record<string, unknown>>(ctx.req);
    const conn = await tunnel.createConnection({
      name: typeof b.name === 'string' ? b.name.trim() : undefined,
      host: typeof b.host === 'string' ? b.host.trim() : undefined,
      user: typeof b.user === 'string' ? b.user.trim() : undefined,
      sshPort: typeof b.sshPort === 'number' ? b.sshPort : undefined,
      remotePort: typeof b.remotePort === 'number' ? b.remotePort : undefined,
      torProxy: typeof b.torProxy === 'string' ? b.torProxy.trim() : undefined,
      services: Array.isArray(b.services) ? (b.services as string[]).filter(isServiceId) : undefined,
    });
    sendJson(ctx.res, 201, { connection: shape(conn) });
  });

  r.get('/api/connections/:id', (ctx) => {
    requireConsole(ctx);
    sendJson(ctx.res, 200, { connection: shape(tunnel.getConnection(ctx.params.id!)) });
  });

  r.put('/api/connections/:id', async (ctx) => {
    requireConsole(ctx);
    const b = await readJson<Record<string, unknown>>(ctx.req);
    const conn = await tunnel.updateConnection(ctx.params.id!, {
      name: typeof b.name === 'string' ? b.name.trim() : undefined,
      host: typeof b.host === 'string' ? b.host.trim() : undefined,
      user: typeof b.user === 'string' ? b.user.trim() : undefined,
      sshPort: typeof b.sshPort === 'number' ? b.sshPort : undefined,
      remoteBind: typeof b.remoteBind === 'string' ? b.remoteBind.trim() : undefined,
      remotePort: typeof b.remotePort === 'number' ? b.remotePort : undefined,
      torProxy: typeof b.torProxy === 'string' ? b.torProxy.trim() : undefined,
      services: Array.isArray(b.services) ? (b.services as string[]).filter(isServiceId) : undefined,
    });
    const applied = await hostAction('tunnel.configure', conn.id, 30_000).catch((e: HttpError) => ({ ok: false, output: e.message }));
    sendJson(ctx.res, 200, { connection: shape(tunnel.getConnection(conn.id)), applied });
  });

  r.post('/api/connections/:id/key', async (ctx) => {
    requireConsole(ctx);
    sendJson(ctx.res, 200, { publicKey: await tunnel.generateKey(ctx.params.id!) });
  });

  // Reading the far side's host key is a GET because it changes nothing here;
  // accepting it is a POST because it does. Two calls rather than one so the
  // fingerprints can be looked at before anything is written.
  r.get('/api/connections/:id/hostkey', async (ctx) => {
    requireConsole(ctx);
    sendJson(ctx.res, 200, { hostKeys: await tunnel.hostKeys(ctx.params.id!) });
  });

  r.post('/api/connections/:id/hostkey', async (ctx) => {
    requireConsole(ctx);
    const output = await tunnel.acceptNewHostKey(ctx.params.id!);
    sendJson(ctx.res, 200, { connection: shape(tunnel.getConnection(ctx.params.id!)), output });
  });

  // One paste and the rest happens: save the address, render the unit, start
  // the tunnel, enable it at boot, and make a token if there is not one.
  r.post('/api/connections/:id/pair', async (ctx) => {
    requireConsole(ctx);
    const id = ctx.params.id!;
    const body = await readJson<{ text?: string }>(ctx.req);
    const before = tunnel.getConnection(id);
    if (!before.host) throw badRequest('Say where Tern runs first — perch needs the SSH host before it can pair.');

    const { bind, port } = tunnel.parsePairing(body.text ?? '');
    await tunnel.updateConnection(id, { remoteBind: bind, remotePort: port });

    // None of these may fail the pairing: the address is the hard-won part,
    // and losing it on a failed unit write would mean fetching it from the
    // other machine again.
    const attempt = async (a: HostAction, ms: number): Promise<{ ok: boolean; output: string }> =>
      hostAction(a, id, ms).catch((e) => ({ ok: false, output: (e as Error).message }));

    const configured = await attempt('tunnel.configure', 30_000);
    const wasActive = tunnel.statusOf(tunnel.getConnection(id)).active === 'active';
    const started = await attempt(wasActive ? 'tunnel.restart' : 'tunnel.start', 60_000);
    const atBoot = await attempt('tunnel.enable', 30_000);

    const existing = loadState().tokens.filter((t) => !t.revokedAt);
    const token = existing.length === 0 ? mintToken('Tern', ['use', 'manage']).token : null;

    sendJson(ctx.res, 200, {
      connection: shape(tunnel.getConnection(id)),
      token,
      hasExistingToken: existing.length > 0,
      steps: { configured, started, atBoot },
    });
  });

  /** Drop a retired record once the far side has been dealt with. */
  r.post('/api/connections/:id/forget', (ctx) => {
    requireConsole(ctx);
    const c = tunnel.getConnection(ctx.params.id!);
    if (!c.retiredAt) throw badRequest('Remove the connection before forgetting it.');
    tunnel.forgetConnection(c.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  r.post('/api/connections/:id/:action', async (ctx) => {
    requireConsole(ctx);
    const id = ctx.params.id!;
    const a = ctx.params.action!;
    if (!['start', 'stop', 'restart', 'enable', 'disable', 'logs'].includes(a)) throw notFound('no such action');
    tunnel.getConnection(id); // 404 rather than asking the helper about nothing
    sendJson(ctx.res, 200, await hostAction(`tunnel.${a}` as HostAction, id, 60_000));
  });

  /**
   * Remove a connection. Everything on this machine goes: the unit is stopped
   * and disabled, the unit file, the key and the config are deleted.
   *
   * The account on the far side is not touched, and cannot be. The tunnel key
   * is restricted with command="/usr/sbin/nologin" precisely so that it cannot
   * run anything over there — giving perch the ability to clean up remotely
   * would mean keeping a credential here that could also do everything else.
   * So the record survives, without its key or its unit, carrying the exact
   * command to run on that server. It is scoped to this connection's key and
   * safe to run twice.
   */
  r.delete('/api/connections/:id', async (ctx) => {
    requireConsole(ctx);
    const { connection, teardown } = await tunnel.retireConnection(ctx.params.id!);
    sendJson(ctx.res, 200, {
      connection: shape(connection),
      teardown,
      uninstallCommand: tunnel.uninstallCommand(connection),
    });
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
    // A named container has to be one perch runs; anything else is refused
    // here rather than handed to the helper to refuse.
    const service = body.service && containerDef(body.service) ? body.service : '';
    // Pulling images and starting containers are minutes-long jobs on a slow
    // line, so they get a long leash.
    sendJson(ctx.res, 200, await hostAction(action, service, 15 * 60_000));
  });

  // ---------- how big each container may be ----------
  //
  // The limits live in .env because compose reads them when it *creates* a
  // container, which is also why applying one is a recreate. See
  // containers.ts for why both the configured and the running value are
  // reported rather than just the one perch wrote.

  r.get('/api/containers', (ctx) => {
    requireConsole(ctx);
    sendJson(ctx.res, 200, {
      containers: containerSizes(),
      hostAvailable: hostAvailable(),
      /** System memory, so the console can say when the limits add up to more than the machine has. */
      totalMemBytes: (readHostStatus().status?.mem?.totalKb ?? 0) * 1024 || config.totalMemBytes,
    });
  });

  r.put('/api/containers/:id/size', async (ctx) => {
    requireConsole(ctx);
    const def = containerDef(ctx.params.id!);
    if (!def) throw notFound('no such container');
    const body = await readJson<{ mem?: string; cpus?: string; apply?: boolean }>(ctx.req);

    const writes: Array<{ key: string; value: string }> = [];
    if (body.mem !== undefined) {
      const mem = String(body.mem).trim();
      if (!validMem(mem)) throw badRequest('A memory limit looks like 512m, 8g or 0 for no limit.');
      const bytes = memBytes(mem);
      // 0 is "no limit", which is always allowed. A real limit below the
      // floor is not a slow container, it is one the kernel kills partway
      // through loading a model — so it is refused with the reason.
      if (bytes !== null && bytes > 0 && bytes < floorFor(def)) {
        throw badRequest(`${def.label} needs at least ${human(floorFor(def))}; below that it is killed rather than slowed.`);
      }
      writes.push({ key: def.memKey, value: mem });
    }
    if (body.cpus !== undefined) {
      const cpus = String(body.cpus).trim();
      if (!validCpus(cpus)) throw badRequest('A CPU limit is a number of cores, such as 2 or 1.5 — or 0 for all of them.');
      writes.push({ key: def.cpuKey, value: cpus });
    }
    if (writes.length === 0) throw badRequest('nothing to change');

    const set: Array<{ key: string; ok: boolean; output: string }> = [];
    for (const w of writes) {
      const r2 = await hostAction('env.set', `${w.key}=${w.value}`, 20_000);
      set.push({ key: w.key, ...r2 });
      // Stop at the first failure rather than writing half a change and
      // reporting success for the other half.
      if (!r2.ok) break;
    }
    const wrote = set.every((x) => x.ok);
    // Recreating perch itself takes this console down with it, so the answer
    // is sent first and the request is left to be cut off — the browser
    // treats a dropped connection as the restart it asked for.
    const applied = wrote && body.apply
      ? await hostAction('containers.recreate', def.id, 15 * 60_000).catch((e: Error) => ({ ok: false, output: e.message }))
      : null;
    sendJson(ctx.res, 200, { ok: wrote, set, applied, containers: containerSizes() });
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
    if (s !== 'perch' && s !== 'ollama' && s !== 'whisper') throw notFound('no such service');
    sendJson(ctx.res, 200, await hostAction('logs', s, 30_000));
  });

  // ---------- the speech model ----------
  //
  // Not the same shape as the Ollama routes above, because whisper.cpp is not
  // the same kind of server: it holds one model, chosen when it starts, and
  // has no API for changing it. See voice.ts. What the console gets is the
  // truth about which model that is and whether the transcriber is answering,
  // and one way to change it — which means the environment and a restart.

  r.get('/api/voice', async (ctx) => {
    requireConsole(ctx);
    sendJson(ctx.res, 200, await voiceStatus());
  });

  r.put('/api/voice/model', async (ctx) => {
    requireConsole(ctx);
    const { model, restart } = await readJson<{ model?: string; restart?: boolean }>(ctx.req);
    if (!model) throw badRequest('which model?');
    if (!validSpeechModel(model)) throw badRequest(`${model} is not a whisper.cpp model this console offers`);
    // Nothing to do only when *both* agree: what .env asks for, and what
    // compose passed this container when the two were last created together.
    // Comparing with .env alone would refuse to re-apply a model that was
    // written but never reached the container — which is exactly the state a
    // failed switch leaves behind, and exactly when somebody retries.
    if (model === (await configuredSpeechModel()).model && model === currentSpeechModel()) {
      sendJson(ctx.res, 200, { ok: true, changed: false, status: await voiceStatus() });
      return;
    }
    // Written to .env so it survives a restart, exactly as Ollama's own knobs
    // are. Applying it needs the container recreated, which is a separate and
    // slower step — and one worth being asked about, because it takes
    // dictation down while the new weights are fetched.
    //
    // Recreated, not restarted. whisper-server is told its model on its
    // command line, which compose builds from .env when it *creates* the
    // container; a restart would bring back the same command line and the
    // same weights. This used to ask for a restart and get a recreate,
    // because the helper quietly recreated whisper on any restart — which
    // worked, and meant the two words did not mean what they said.
    const set = await hostAction('env.set', `WHISPER_MODEL=${model}`, 30_000);
    if (!set.ok) { sendJson(ctx.res, 200, { ok: false, changed: false, set }); return; }
    const applied = restart === false ? null : await hostAction('containers.recreate', 'whisper', 15 * 60_000);
    sendJson(ctx.res, 200, { ok: true, changed: true, set, applied, status: await voiceStatus() });
  });

  // ---------- images, video and audio ----------
  //
  // A catalogue rather than a manager, for the reason media.ts opens with: a
  // diffusion server reads a directory and has no API for putting anything in
  // it. So the console offers what to install, what each costs, whether the
  // backend can see it, and the one command that puts it there — and never a
  // Download button that does nothing.

  r.get('/api/media', async (ctx) => {
    requireConsole(ctx);
    const overview = await mediaOverview();
    sendJson(ctx.res, 200, { ...overview, volumes: MODEL_VOLUMES });
  });

  /**
   * One model's files, for `./bin/perch fetch`.
   *
   * The script asks rather than carrying its own copy of the catalogue: two
   * lists of URLs would disagree the first time one of them was edited, and
   * the one that is wrong would be the one that downloads seven gigabytes.
   */
  r.get('/api/media/model', (ctx) => {
    requireConsole(ctx);
    const id = ctx.url.searchParams.get('id') || '';
    const model = mediaModel(id);
    if (!model) throw notFound(`no model called ${id || '(nothing)'} in the catalogue`);
    const store = MODEL_VOLUMES[model.service] ?? null;
    if (!store || model.bundled) throw badRequest(`${model.name} ships inside its container image, so there is nothing to fetch`);
    sendJson(ctx.res, 200, { model, volume: store.volume, subdir: store.subdir });
  });

  // ---------- settings ----------

  r.get('/api/settings', (ctx) => {
    requireConsole(ctx);
    const wanted = new Set(config.enabledServices.split(',').map((x) => x.trim()).filter(Boolean));
    wanted.add('chat');
    sendJson(ctx.res, 200, {
      settings: loadState().settings,
      services: SERVICES.map((svc) => ({
        id: svc.id,
        label: svc.label,
        blurb: svc.blurb,
        port: svc.port,
        enabled: wanted.has(svc.id),
        overlay: svc.overlay,
        ternField: svc.ternField,
        speaks: svc.speaks,
        vramHintBytes: SERVICE_VRAM_HINT[svc.id],
        routes: routeTable(svc),
      })),
      proxy: { maxConcurrent: config.maxConcurrent, port: config.proxyPort },
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
  //
  // Which is why writing the file is only half the job. Compose hands a
  // container its environment when it *creates* it, so the process running
  // now holds the values it was created with and a restart gives them
  // straight back — the new number sits in the file doing nothing. Applying
  // one of these is a recreate, for exactly the reason a container size is:
  // see the size endpoint above and the note at the top of containers.ts.
  // The console said "restart the containers to apply it" for a long time,
  // which was advice that could not work.
  //
  // Writing without applying is still a legitimate answer, so `apply` is the
  // caller's choice: recreating Ollama drops whatever model is resident, and
  // somebody mid-sentence would rather that waited.
  //
  // Which key belongs to which container is containers.ts's business, along
  // with why the memory and CPU keys are not settable here.
  // Both halves of every knob: what .env asks for, and what the container
  // that reads it is actually running with. They differ exactly while a value
  // has been written and not yet applied — the state that used to be
  // invisible, so a setting that had silently not taken effect looked
  // identical to one that had. The same two figures the container sizes show,
  // for the same reason.
  r.get('/api/ollama-env', async (ctx) => {
    requireConsole(ctx);
    const available = hostAvailable();
    // A console with no helper still draws the card; it just cannot say what
    // anything is set to. Better an empty field than a confident wrong one.
    const raw = available
      ? await hostAction('env.tuning', '', 20_000).catch(() => ({ ok: false, output: '' }))
      : { ok: false, output: '' };

    sendJson(ctx.res, 200, { hostAvailable: available, keys: tuningReport(raw.output) });
  });

  r.put('/api/ollama-env', async (ctx) => {
    requireConsole(ctx);
    const body = await readJson<{ key?: string; value?: string; apply?: boolean }>(ctx.req);
    const def = containerForTuningKey(body.key);
    if (!def) throw badRequest('that is not a settable key');
    if (!body.value || !/^[A-Za-z0-9_.-]{1,32}$/.test(body.value)) throw badRequest('that value is not allowed');
    const set = await hostAction('env.set', `${body.key}=${body.value}`, 20_000);
    // A recreate here pulls no images and starts one container, but Ollama on
    // a cold page cache can still take a while to answer again, so it gets the
    // same leash as the size endpoint's.
    //
    // Recreating perch means recreating the container serving this request:
    // the answer never arrives and the browser sees the connection drop,
    // exactly as it does when perch is resized. The console warns first.
    const applied = set.ok && body.apply
      ? await hostAction('containers.recreate', def.id, 15 * 60_000).catch((e: Error) => ({ ok: false, output: e.message }))
      : null;
    sendJson(ctx.res, 200, {
      ok: set.ok && (applied ? applied.ok : true),
      key: body.key,
      container: def.id,
      set,
      applied,
      // The failure worth reading, for a caller that only looks at this.
      output: !set.ok ? set.output : (applied && !applied.ok ? applied.output : set.output),
    });
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
