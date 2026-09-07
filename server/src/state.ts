// perch's whole memory: tokens, the tunnel's settings, and the handful of
// knobs the console can change without a restart. One JSON file, written
// atomically and readable only by its owner, because it holds password and
// token hashes.
//
// It is deliberately not a database. Everything in here is small, changes
// rarely, and should survive being read — or fixed — with a text editor at
// three in the morning when the tunnel is down.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './log.js';

const log = logger('state');

export interface TokenRecord {
  id: string;
  name: string;
  /** sha256 of the token. The token itself is shown once, at creation, and never stored. */
  hash: string;
  /** First few characters, so the console can tell two tokens apart in a list. */
  prefix: string;
  /** 'use' is generate and read; 'manage' adds pulling and deleting models. */
  scopes: Array<'use' | 'manage'>;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
}

export interface TunnelConfig {
  /** The machine Tern runs on, as SSH reaches it. */
  host: string;
  /** The unprivileged account the tunnel logs into. Not your admin user. */
  user: string;
  sshPort: number;
  /**
   * Where the forwarded port lands on the Tern box. Loopback works when Tern
   * runs on the host; a container needs the podman bridge address, which is
   * what the generated setup script works out. See docs/REMOTE.md.
   */
  remoteBind: string;
  remotePort: number;
  /** Path to the tunnel's private key, on this machine, outside the container. */
  keyPath: string;
  publicKey: string;
  /** What Tern should be given as its AI base URL, once the tunnel is up. */
  ternBaseUrl: string;
  configuredAt: string | null;
}

export interface Settings {
  /** Master switch for pull/delete over the proxy; a token still needs the scope. */
  allowManage: boolean;
  /** How long Ollama keeps a model resident after the last request. */
  keepAlive: string;
  /** Drop the model from memory as soon as nothing is generating. */
  unloadWhenIdle: boolean;
}

export interface State {
  version: 1;
  tokens: TokenRecord[];
  console: { passwordHash: string | null };
  tunnel: TunnelConfig;
  settings: Settings;
}

const DEFAULTS: State = {
  version: 1,
  tokens: [],
  console: { passwordHash: null },
  tunnel: {
    host: '',
    user: 'perch',
    sshPort: 22,
    remoteBind: '127.0.0.1',
    remotePort: 11434,
    // Derived rather than hardcoded: an install with a different state
    // directory would otherwise be told the wrong path to its own key.
    keyPath: path.join(config.stateDir, 'ssh', 'id_ed25519'),
    publicKey: '',
    ternBaseUrl: '',
    configuredAt: null,
  },
  settings: {
    allowManage: config.allowManage,
    keepAlive: '10m',
    unloadWhenIdle: false,
  },
};

const FILE = path.join(config.stateDir, 'state.json');

let cache: State | null = null;

function merge(loaded: unknown): State {
  const l = (loaded ?? {}) as Partial<State>;
  return {
    version: 1,
    tokens: Array.isArray(l.tokens) ? l.tokens : [],
    console: { ...DEFAULTS.console, ...(l.console ?? {}) },
    // keyPath moved from a hardcoded default to one derived from the state
    // directory; a file written by an earlier version carries the old value.
    tunnel: { ...DEFAULTS.tunnel, ...(l.tunnel ?? {}), keyPath: DEFAULTS.tunnel.keyPath },
    settings: { ...DEFAULTS.settings, ...(l.settings ?? {}) },
  };
}

export function loadState(): State {
  if (cache) return cache;
  try {
    cache = merge(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // A missing file is the first run. Anything else is a real problem, and
    // starting from defaults would quietly revoke every token, so say so
    // loudly and start empty rather than pretending nothing happened.
    if (err.code !== 'ENOENT') log.error(`could not read ${FILE}, starting from defaults`, err.message);
    cache = merge(null);
  }
  return cache;
}

/** Read, change, write. The callback mutates the state in place. */
export function updateState(fn: (s: State) => void): State {
  const s = loadState();
  fn(s);
  save(s);
  return s;
}

function save(s: State): void {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  // Write, flush, rename: a crash mid-write leaves the previous state intact
  // rather than a half-written file that loses every token.
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(s, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, FILE);
  cache = s;
}

/** Test seam: forget what was read so the next load hits the disk again. */
export function resetStateCache(): void {
  cache = null;
}
