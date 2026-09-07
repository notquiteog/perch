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

/**
 * One SSH connection to one machine running Tern. perch holds several: a
 * laptop's Tern and a VPS's Tern can both use the same GPU, and each gets its
 * own account, its own key and its own systemd unit so that removing one
 * touches nothing belonging to another.
 */
export interface Connection {
  /** Stable slug. Becomes part of a unit name and a filename, so it is checked. */
  id: string;
  /** What to call it in the console. */
  name: string;
  /** The machine Tern runs on, as SSH reaches it. May be an .onion. */
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
  /**
   * A SOCKS5 proxy to dial out through, as host:port — in practice Tor's
   * 127.0.0.1:9050. Empty means connect directly.
   */
  torProxy: string;
  /** Per-connection, so retiring one cannot affect any other. */
  keyPath: string;
  publicKey: string;
  createdAt: string;
  configuredAt: string | null;
  /**
   * Set when the connection is removed here. The record is kept, without its
   * key or its unit, until the account on the far side has been cleaned up —
   * because perch cannot do that itself. The tunnel key is restricted to
   * holding one port open and explicitly cannot run commands, which is the
   * point of it; cleaning up remotely would mean keeping a credential here
   * that could. So the record survives long enough to tell you what to run.
   */
  retiredAt: string | null;
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
  version: 2;
  tokens: TokenRecord[];
  console: { passwordHash: string | null };
  connections: Connection[];
  settings: Settings;
}

const DEFAULTS: State = {
  version: 2,
  tokens: [],
  console: { passwordHash: null },
  connections: [],
  settings: {
    allowManage: config.allowManage,
    keepAlive: '10m',
    unloadWhenIdle: false,
  },
};

/** Where a connection's private key lives. Per connection, never shared. */
export function keyPathFor(id: string): string {
  return path.join(config.stateDir, 'ssh', id, 'id_ed25519');
}

export function newConnection(partial: Partial<Connection> & { id: string }): Connection {
  return {
    id: partial.id,
    name: partial.name ?? partial.host ?? partial.id,
    host: partial.host ?? '',
    user: partial.user ?? 'perch',
    sshPort: partial.sshPort ?? 22,
    remoteBind: partial.remoteBind ?? '',
    remotePort: partial.remotePort ?? 11434,
    torProxy: partial.torProxy ?? '',
    keyPath: keyPathFor(partial.id),
    publicKey: partial.publicKey ?? '',
    createdAt: partial.createdAt ?? new Date().toISOString(),
    configuredAt: partial.configuredAt ?? null,
    retiredAt: partial.retiredAt ?? null,
  };
}

const FILE = path.join(config.stateDir, 'state.json');

let cache: State | null = null;

function merge(loaded: unknown): State {
  const l = (loaded ?? {}) as Partial<State> & { tunnel?: Partial<Connection> & { ternBaseUrl?: string } };

  // Version 1 held a single `tunnel` object. Carry it across as the first
  // connection rather than losing somebody's working setup on an upgrade; the
  // id is fixed so the unit and key it already has can be found again.
  let connections: Connection[] = Array.isArray(l.connections) ? l.connections.map((c) => newConnection(c)) : [];
  if (!connections.length && l.tunnel && (l.tunnel.host || l.tunnel.publicKey)) {
    connections = [newConnection({ ...l.tunnel, id: 'default', name: l.tunnel.host || 'Tern' })];
  }

  return {
    version: 2,
    tokens: Array.isArray(l.tokens) ? l.tokens : [],
    console: { ...DEFAULTS.console, ...(l.console ?? {}) },
    connections,
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
