// Everything perch needs to know before it opens a socket. install.sh writes
// these into .env and compose passes them through; nothing here is secret,
// because the secrets (API tokens, the console password) live in the state
// file where they can be rotated without a restart.
import os from 'node:os';

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number): number {
  const n = Number.parseInt(env(key, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = env(key, '').toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const config = {
  // The console: the small web UI and the API behind it. Bound to loopback by
  // default and meant to stay there — it is the machine's own control panel,
  // not something to publish. Binding it anywhere else requires a console
  // password (see auth.ts), because "reachable and unauthenticated" is how
  // people lose a GPU box.
  consolePort: int('PERCH_CONSOLE_PORT', 8099),
  consoleBind: env('PERCH_CONSOLE_BIND', '127.0.0.1'),

  // The model endpoint: an Ollama-compatible API that requires a bearer
  // token. This is what the SSH tunnel picks up and carries to the Tern box.
  // It stays on loopback: the tunnel runs on this machine and reaches it
  // there, so the port never needs to exist on any other interface. Nothing
  // about perch asks you to open a port on your router.
  proxyPort: int('PERCH_PROXY_PORT', 11434),
  proxyBind: env('PERCH_PROXY_BIND', '127.0.0.1'),

  // The other two model servers, each optional and each off unless its
  // compose overlay is enabled. They get their own ports because Tern treats
  // a transcriber as a different server from the writing model — and because
  // one allowlist per API is the whole point.
  voicePort: int('PERCH_VOICE_PORT', 11435),
  imagePort: int('PERCH_IMAGE_PORT', 11436),

  // The ports as published on the *host*, which are not always the ports perch
  // listens on inside the container. compose maps host:container, so a machine
  // that already had something on 11435 gets its dictation endpoint published
  // somewhere else while the container carries on listening where it always
  // did.
  //
  // The tunnel runs on the host, so it must forward from these, not from the
  // listen ports. They match by default, which is exactly why getting this
  // wrong would go unnoticed until somebody remapped a port.
  hostChatPort: int('PERCH_HOST_CHAT_PORT', int('PERCH_PROXY_PORT', 11434)),
  hostVoicePort: int('PERCH_HOST_VOICE_PORT', int('PERCH_VOICE_PORT', 11435)),
  hostImagePort: int('PERCH_HOST_IMAGE_PORT', int('PERCH_IMAGE_PORT', 11436)),
  whisperUrl: env('PERCH_WHISPER_URL', 'http://whisper:8080').replace(/\/+$/, ''),
  sdUrl: env('PERCH_SD_URL', 'http://sd:7860').replace(/\/+$/, ''),
  /** Comma-separated: which services listen at all. chat is always on. */
  enabledServices: env('PERCH_SERVICES', 'chat'),

  // Where the real Ollama is. In the shipped compose file it is the sibling
  // container, which publishes no port of its own: the only way in is through
  // perch, so there is no unauthenticated back door on the LAN.
  ollamaUrl: env('PERCH_OLLAMA_URL', 'http://ollama:11434').replace(/\/+$/, ''),

  // Tokens, settings and the tunnel's heartbeat. A volume in compose, a
  // directory on the host under bin/perch.
  stateDir: env('PERCH_STATE_DIR', '/var/lib/perch'),

  // Where the built console lives inside the image.
  clientDist: env('PERCH_CLIENT_DIST', ''),

  // A generation can legitimately take minutes on a slow box with a big
  // model, so the proxy's idle timeout is generous — it is there to reap
  // sockets a dead client left behind, not to cap thinking time.
  upstreamIdleMs: int('PERCH_UPSTREAM_IDLE_MS', 15 * 60 * 1000),

  // Refuse absurd request bodies before reading them. A chat request carrying
  // a long email thread is tens of kilobytes, but a minute of dictation is a
  // couple of megabytes and an img2img source can be larger again — 64 MB is
  // room for those and still far below "someone is filling my disk".
  maxBodyBytes: int('PERCH_MAX_BODY_BYTES', 64 * 1024 * 1024),

  // A backstop, not a scheduler: how many generations may be in flight at
  // once across all tokens. Tern already paces itself against
  // OLLAMA_NUM_PARALLEL, so this sits comfortably above it and exists to stop
  // a runaway caller — or a leaked token — from pinning the GPU. Past it,
  // perch answers 503 with Retry-After rather than holding the socket open.
  maxConcurrent: int('PERCH_MAX_CONCURRENT', 4),

  // Wrong tokens from one address, before that address is refused outright
  // for a while. With the tunnel the only caller is Tern, so a run of bad
  // tokens means either a misconfigured Tern or something on the far box that
  // should not be talking to us; both are worth stopping early.
  authFailLimit: int('PERCH_AUTH_FAIL_LIMIT', 10),
  authFailWindowMs: int('PERCH_AUTH_FAIL_WINDOW_MS', 15 * 60 * 1000),
  authBlockMs: int('PERCH_AUTH_BLOCK_MS', 15 * 60 * 1000),

  // Model management (pull and delete) through the proxy. Tern's Admin → AI
  // model page uses it to download a model onto this box, which is convenient
  // and also the most destructive thing a leaked token could do, so it is a
  // per-token scope and this is the master switch.
  allowManage: bool('PERCH_ALLOW_MANAGE', true),

  // How many proxy requests the Activity page remembers. In memory only:
  // perch keeps no record of what was asked or answered, and restarting
  // forgets even this much. See docs/SECURITY.md.
  activityLimit: int('PERCH_ACTIVITY_LIMIT', 300),

  version: env('PERCH_VERSION', '0.1.0'),
  totalMemBytes: os.totalmem(),
};

export type Config = typeof config;
