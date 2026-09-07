// perch starts two listeners, and keeping them apart is the whole security
// design in one sentence:
//
//   * the console, on loopback, which can do everything;
//   * the model endpoint, which the tunnel carries to the Tern box, and which
//     can do exactly the fourteen things in proxy.ts and nothing else.
//
// They are separate sockets so that exposing the second never exposes the
// first. Nothing about the tunnel gives anyone a route to the console.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { createProxyServer, proxyInFlight } from './proxy.js';
import { buildApi, apiErrorHandler } from './api.js';
import { loadState } from './state.js';
import { HttpError, sendJson, type Ctx } from './http.js';
import * as ollama from './ollama.js';
import { logger } from './log.js';

const log = logger('perch');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<boolean> {
  if (!config.clientDist) return false;
  const root = path.resolve(config.clientDist);
  // Resolve first, then check the result is still inside the root: the
  // shortest correct way to refuse ../../etc/passwd.
  const target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  const file = target.startsWith(root + path.sep) || target === root ? target : null;
  if (!file) return false;

  let body: Buffer;
  let name = file;
  try {
    body = await fsp.readFile(file);
  } catch {
    // Anything the console routes itself falls back to the app shell.
    if (pathname.startsWith('/api/')) return false;
    try {
      name = path.join(root, 'index.html');
      body = await fsp.readFile(name);
    } catch {
      return false;
    }
  }
  const ext = path.extname(name);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // The console is a local control panel: it should never be framed, and
    // nothing it loads comes from anywhere but itself.
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  res.end(body);
  return true;
}

function startConsole(): http.Server {
  const api = buildApi();
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const method = (req.method || 'GET').toUpperCase();
      try {
        const hit = api.match(method, url.pathname);
        if (hit) {
          const ctx: Ctx = { req, res, params: hit.params, url };
          await hit.handler(ctx);
          return;
        }
        if (method === 'GET' && (await serveStatic(res, url.pathname))) return;
        if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'no such endpoint');
        sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        if (res.headersSent) { res.destroy(); return; }
        apiErrorHandler(res, err);
      }
    })();
  });
  server.headersTimeout = 30_000;
  server.listen(config.consolePort, config.consoleBind, () => {
    log.info(`console on http://${config.consoleBind}:${config.consolePort}`);
  });
  return server;
}

/**
 * Optional: drop the model from memory once nothing has needed it for a
 * while, rather than leaving it — and the KV cache holding the last email it
 * saw — resident until Ollama's own timer runs out. Costs a load on the next
 * request, which is the point of it being a choice.
 */
function startIdleWatcher(): NodeJS.Timeout {
  let idleSince = Date.now();
  return setInterval(() => {
    void (async () => {
      if (!loadState().settings.unloadWhenIdle) { idleSince = Date.now(); return; }
      if (proxyInFlight() > 0) { idleSince = Date.now(); return; }
      if (Date.now() - idleSince < 60_000) return;
      try {
        const loaded = await ollama.loadedModels();
        for (const m of loaded) {
          await ollama.unloadModel(m.name);
          log.info(`unloaded ${m.name} after a minute idle`);
        }
        if (loaded.length) idleSince = Date.now();
      } catch { /* Ollama is down or restarting; try again next time round */ }
    })();
  }, 20_000);
}

/**
 * A port already in use is the most likely reason perch fails to start —
 * usually another copy of it, or something else on 11434. Node's default for
 * that is an unhandled 'error' event and a stack trace, which tells you
 * nothing you can act on. Say which port and what to do instead.
 */
function onListenError(what: string, port: number, bind: string): (err: NodeJS.ErrnoException) => void {
  return (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`the ${what} cannot start: ${bind}:${port} is already in use`);
      log.error(`something else is on that port — another perch, perhaps. Check with: ss -lntp | grep ${port}`);
    } else if (err.code === 'EACCES') {
      log.error(`the ${what} cannot start: not allowed to bind ${bind}:${port}`);
    } else {
      log.error(`the ${what} cannot start`, err.message);
    }
    process.exit(1);
  };
}

function main(): void {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const state = loadState();

  const consoleServer = startConsole();
  consoleServer.on('error', onListenError('console', config.consolePort, config.consoleBind));
  const proxyServer = createProxyServer();
  proxyServer.on('error', onListenError('model endpoint', config.proxyPort, config.proxyBind));
  proxyServer.listen(config.proxyPort, config.proxyBind, () => {
    log.info(`model endpoint on http://${config.proxyBind}:${config.proxyPort}`);
  });
  const idle = startIdleWatcher();

  if (!state.tokens.some((t) => !t.revokedAt)) {
    log.warn('no API tokens yet — nothing can use this perch until you make one in the console');
  }
  if (config.consoleBind !== '127.0.0.1' && !state.console.passwordHash) {
    log.warn(`the console is bound to ${config.consoleBind} with no password; it will refuse every request that is not from this machine`);
  }
  // Logged once both listeners are actually bound, so a failed bind does not
  // print a reassuring "ready" line just before the error.
  let up = 0;
  const readyWhenBoth = (): void => { up += 1; if (up === 2) log.info(`perch ${config.version} ready`); };
  consoleServer.on('listening', readyWhenBoth);
  proxyServer.on('listening', readyWhenBoth);

  const shutdown = (signal: string): void => {
    log.info(`${signal}: shutting down`);
    clearInterval(idle);
    consoleServer.close();
    proxyServer.close();
    // Give in-flight generations a moment to finish rather than cutting
    // somebody's draft off mid-sentence.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
