// Connections: one per machine running Tern, each with its own account on the
// far side, its own key, its own systemd unit and its own config file. Nothing
// is shared between them, which is what makes removing one safe.
//
// The console does not run ssh itself. It writes each connection's settings
// down, asks the host helper to render a unit from them, and lets systemd own
// the process — which is what makes a tunnel survive a reboot, a dropped line
// and a closed browser tab.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { config } from './config.js';
import { loadState, updateState, newConnection, keyPathFor, type Connection } from './state.js';
import { readHostStatus, runHostAction } from './host.js';
import { badRequest, notFound } from './http.js';

const CONF_DIR = path.join(config.stateDir, 'tunnels');

/**
 * Which ports a connection carries, and where each lands.
 *
 * The far side's ports are consecutive from the chat port because every one of
 * them must appear in that machine's permitlisten: three consecutive numbers
 * is one thing to check, three arbitrary ones is three.
 */
export function forwardsFor(c: Connection): Array<{ id: string; localPort: number; remotePort: number; label: string }> {
  // Host-side ports: the tunnel runs on the host, so it forwards from what
  // compose published, not from what perch listens on inside the container.
  const order: Array<{ id: string; port: number; label: string }> = [
    { id: 'chat', port: config.hostChatPort, label: 'Chat' },
    { id: 'voice', port: config.hostVoicePort, label: 'Dictation' },
    { id: 'image', port: config.hostImagePort, label: 'Images' },
  ];
  return order
    .map((svc, i) => ({ ...svc, offset: i }))
    .filter((svc) => (c.services ?? ['chat']).includes(svc.id))
    .map((svc) => ({ id: svc.id, localPort: svc.port, remotePort: c.remotePort + svc.offset, label: svc.label }));
}

// ---------- identity ----------

/** A slug that is safe as a filename and as part of a systemd unit name. */
export function slugify(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return base || 'tern';
}

function uniqueId(desired: string): string {
  const taken = new Set(loadState().connections.map((c) => c.id));
  if (!taken.has(desired)) return desired;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${desired}-${n}`.slice(0, 36);
    if (!taken.has(candidate)) return candidate;
  }
  throw badRequest('too many connections with similar names');
}

// ---------- reading ----------

export function listConnections(): Connection[] {
  return loadState().connections;
}

export function getConnection(id: string): Connection {
  const found = loadState().connections.find((c) => c.id === id);
  if (!found) throw notFound('no such connection');
  return found;
}

export function publicKeyOf(conn: Connection): string | null {
  try {
    return fs.readFileSync(`${conn.keyPath}.pub`, 'utf8').trim();
  } catch {
    return conn.publicKey || null;
  }
}

// ---------- validation ----------

function isPrivateIp(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function validate(input: Partial<Connection>, selfId?: string): void {
  if (input.name !== undefined && (input.name.length < 1 || input.name.length > 60)) {
    throw badRequest('Give the connection a name of up to 60 characters.');
  }
  // An .onion passes this as-is: it is only letters, digits and dots.
  if (input.host !== undefined && !/^[A-Za-z0-9._-]{1,253}$/.test(input.host)) {
    throw badRequest('That does not look like a hostname, an IP address or an .onion address.');
  }
  if (input.user !== undefined && !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.user)) {
    throw badRequest('That is not a valid Linux account name.');
  }
  for (const [k, v] of [['sshPort', input.sshPort], ['remotePort', input.remotePort]] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 65535)) throw badRequest(`${k} must be a port number.`);
  }
  if (input.torProxy !== undefined && input.torProxy !== '') {
    const m = /^([0-9.]+):(\d{1,5})$/.exec(input.torProxy);
    if (!m) throw badRequest('The SOCKS proxy wants an address and port, such as 127.0.0.1:9050.');
    if (!isPrivateIp(m[1]!)) throw badRequest('The SOCKS proxy must be on this machine or your own network, not a remote address.');
    const port = Number(m[2]);
    if (port < 1 || port > 65535) throw badRequest('That is not a port number.');
  }
  if (input.remoteBind !== undefined && input.remoteBind !== '' && !isPrivateIp(input.remoteBind)) {
    // The rail, stated here as it is in the host helper and the setup script.
    throw badRequest(
      'The tunnel may only land on a private address — loopback, or the podman bridge on the Tern box. '
      + 'Binding a public address would put your model endpoint on the internet.',
    );
  }

  // Two connections to the same machine cannot ask for the same port there:
  // the second would fail to bind, and with ExitOnForwardFailure it would
  // restart for ever without either of them working.
  if (input.host && input.remotePort) {
    const clash = loadState().connections.find(
      (c) => c.id !== selfId && !c.retiredAt && c.host === input.host && c.remotePort === input.remotePort,
    );
    if (clash) {
      throw badRequest(
        `"${clash.name}" already forwards port ${input.remotePort} on ${input.host}. `
        + 'Use a different port there, or remove that connection first.',
      );
    }
  }
}

// ---------- writing ----------

/**
 * The helper reads this rather than taking eight arguments; see
 * do_tunnel_configure in deploy/perch-hostd.
 */
async function writeConf(conn: Connection): Promise<void> {
  await fsp.mkdir(CONF_DIR, { recursive: true }).catch(() => {});
  await fsp.writeFile(
    path.join(CONF_DIR, `${conn.id}.conf`),
    [
      `ID=${conn.id}`,
      `HOST=${conn.host}`,
      `USER=${conn.user}`,
      `SSH_PORT=${conn.sshPort}`,
      `REMOTE_BIND=${conn.remoteBind}`,
      `REMOTE_PORT=${conn.remotePort}`,
      `LOCAL_PORT=${config.proxyPort}`,
      // One line per forwarded service: "<local>:<remote>". The helper turns
      // each into its own -R, so a connection that carries dictation as well
      // as chat is one SSH session with two forwards rather than two tunnels.
      `FORWARDS=${forwardsFor(conn).map((f) => `${f.localPort}:${f.remotePort}`).join(',')}`,
      `TOR_PROXY=${conn.torProxy}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
}

export async function createConnection(input: Partial<Connection>): Promise<Connection> {
  validate(input);
  if (!input.host) throw badRequest('Say which machine Tern runs on.');
  const id = uniqueId(slugify(input.name || input.host));
  const conn = newConnection({ ...input, id });
  updateState((s) => { s.connections.push(conn); });
  await writeConf(conn);
  // A connection is useless without a key, and asking for it as a separate
  // click is a click nobody would ever want to skip.
  await generateKey(conn.id).catch(() => undefined);
  return getConnection(id);
}

export async function updateConnection(id: string, patch: Partial<Connection>): Promise<Connection> {
  const before = getConnection(id);
  validate({ ...patch, host: patch.host ?? before.host, remotePort: patch.remotePort ?? before.remotePort }, id);
  // Explicit undefined would blank a field the caller never mentioned.
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Connection>;
  const next = updateState((s) => {
    const c = s.connections.find((x) => x.id === id)!;
    Object.assign(c, clean, { id: c.id, keyPath: keyPathFor(c.id) });
    // "Configured" means the far side has been paired, which is exactly when
    // a bind address arrives — pairing changes neither host nor user, so
    // keying off those left a paired connection reading as unfinished.
    if (clean.remoteBind || clean.host || clean.user) c.configuredAt = new Date().toISOString();
  }).connections.find((c) => c.id === id)!;
  await writeConf(next);
  return next;
}

export async function generateKey(id: string): Promise<string> {
  const result = await runHostAction('tunnel.keygen', id, 30_000);
  if (!result.ok) throw badRequest(result.output || 'could not generate a key');
  const conn = getConnection(id);
  const key = publicKeyOf(conn);
  if (!key) {
    // Almost always a permissions problem rather than a missing file: the
    // console runs in a container as a different uid from the account that
    // owns the keys, and a directory it cannot traverse blocks the read
    // before file permissions are consulted. Say so, because "could not be
    // read back" on its own leaves nowhere to go.
    throw badRequest(
      `The key was generated but ${conn.keyPath}.pub could not be read back. `
      + 'This is usually the key directory being unreadable to the console: '
      + '`sudo chmod 711 /var/lib/perch/ssh /var/lib/perch/ssh/*` and then '
      + '`sudo systemctl restart perch-hostd`.',
    );
  }
  updateState((s) => {
    const c = s.connections.find((x) => x.id === id);
    if (c) c.publicKey = key;
  });
  return key;
}

// ---------- pairing ----------

export interface Pairing { bind: string; port: number }

/**
 * The one value perch cannot work out for itself. The bridge address belongs
 * to the Tern box, and the tunnel key is restricted to nologin, so there is no
 * way to ask for it over SSH. tern-side-setup.sh prints it as a single line;
 * this reads it back out of whatever was pasted, so somebody can select the
 * whole terminal output rather than picking the address out by eye.
 */
export function parsePairing(text: string): Pairing {
  const match = /perch-pair:v1:(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})/.exec(text || '');
  if (!match) {
    throw badRequest(
      'No pairing line found in that. Look for the line beginning "perch-pair:" '
      + 'in what the setup script printed on the Tern box, and paste it (or the whole output) here.',
    );
  }
  const bind = match[1]!;
  const port = Number(match[2]);
  validate({ remoteBind: bind, remotePort: port });
  return { bind, port };
}

// ---------- commands to show ----------

export function ternBaseUrl(c: Connection): string {
  if (!c.remoteBind || c.remoteBind === '127.0.0.1') return `http://127.0.0.1:${c.remotePort}`;
  return `http://host.containers.internal:${c.remotePort}`;
}

export function ternBaseUrlLiteral(c: Connection): string {
  return `http://${c.remoteBind || '127.0.0.1'}:${c.remotePort}`;
}

/** One base URL per forwarded service, for the console to hand over. */
export function ternUrls(c: Connection): Array<{ id: string; label: string; url: string; literal: string; ternField: string | null }> {
  const host = !c.remoteBind || c.remoteBind === '127.0.0.1' ? '127.0.0.1' : 'host.containers.internal';
  const fields: Record<string, string | null> = {
    chat: 'Admin → AI model → Base URL',
    voice: 'Admin → AI model → Dictation → Transcriber address',
    image: null,
  };
  return forwardsFor(c).map((f) => ({
    id: f.id,
    label: f.label,
    url: `http://${host}:${f.remotePort}`,
    literal: `http://${c.remoteBind || '127.0.0.1'}:${f.remotePort}`,
    ternField: fields[f.id] ?? null,
  }));
}

const RAW = 'https://raw.githubusercontent.com/notquiteog/perch/main/deploy/tern-side-setup.sh';

export function setupCommand(c: Connection): string | null {
  const key = publicKeyOf(c);
  if (!key) return null;
  return [
    `curl -fsSL ${RAW}`,
    '  | sudo bash -s --',
    `  --key ${JSON.stringify(key)}`,
    `  --user ${c.user}`,
    `  --port ${forwardsFor(c).map((f) => f.remotePort).join(',')}`,
  ].join(' \\\n');
}

export function setupManual(c: Connection): string {
  const key = publicKeyOf(c) ?? '<generate a key first>';
  return [
    '# On the Tern box:',
    `curl -fsSLO ${RAW}`,
    'less tern-side-setup.sh          # read it first',
    `sudo bash tern-side-setup.sh --key ${JSON.stringify(key)} --user ${c.user} --port ${forwardsFor(c).map((f) => f.remotePort).join(',')}`,
  ].join('\n');
}

/**
 * What to run on the far side when a connection is removed here.
 *
 * Scoped to this connection's key: it takes that one line out of
 * authorized_keys and removes the account and the sshd drop-in only when no
 * other key is left, so removing one perch does not cut off another. Running
 * it twice is harmless.
 */
export function uninstallCommand(c: Connection): string | null {
  const key = c.publicKey || publicKeyOf(c);
  if (!key) return null;
  return [
    `curl -fsSL ${RAW}`,
    '  | sudo bash -s -- --uninstall',
    `  --key ${JSON.stringify(key)}`,
    `  --user ${c.user}`,
  ].join(' \\\n');
}

export function sshCommandPreview(c: Connection): string {
  const tor = Boolean(c.torProxy);
  return [
    'ssh -NT',
    ...(tor ? [`  -o "ProxyCommand=/usr/bin/nc -X 5 -x ${c.torProxy} %h %p"`] : []),
    '  -o ExitOnForwardFailure=yes',
    tor ? '  -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o ConnectTimeout=120'
        : '  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=15',
    `  -i ${c.keyPath}`,
    `  -p ${c.sshPort}`,
    ...forwardsFor(c).map((f) => `  -R ${c.remoteBind || '127.0.0.1'}:${f.remotePort}:127.0.0.1:${f.localPort}`),
    `  ${c.user}@${c.host}`,
  ].join(' \\\n');
}

// ---------- status ----------

export interface ConnectionStatus {
  id: string;
  configured: boolean;
  hasKey: boolean;
  active: string;
  enabled: string;
  since: string;
  retired: boolean;
}

export function statusOf(c: Connection): ConnectionStatus {
  const { status } = readHostStatus();
  const unit = (status?.tunnels ?? []).find((t) => t.unit === `perch-tunnel-${c.id}.service`);
  return {
    id: c.id,
    configured: Boolean(c.host && c.remoteBind),
    hasKey: publicKeyOf(c) !== null,
    active: unit?.active ?? 'unknown',
    enabled: unit?.enabled ?? 'unknown',
    since: unit?.since ?? '',
    retired: Boolean(c.retiredAt),
  };
}

/**
 * Can something on this machine reach the model endpoint? It says nothing
 * about any far end — only the Tern box can answer that — but a failure here
 * means the problem is on this side, which halves the search. Shared by every
 * connection, because they all forward the same local port.
 */
export function localEndpointUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: config.proxyPort });
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

// ---------- removal ----------

/**
 * Take a connection down on this machine and keep the record so its far side
 * can still be cleaned up. Idempotent: retiring an already-retired connection
 * tears down again and changes nothing else.
 */
export async function retireConnection(id: string): Promise<{ connection: Connection; teardown: { ok: boolean; output: string } }> {
  const conn = getConnection(id);
  // Capture the key before the helper deletes it, or the uninstall command
  // afterwards has nothing to name.
  const key = publicKeyOf(conn) ?? conn.publicKey;
  const teardown = await runHostAction('tunnel.remove', id, 60_000)
    .catch((e) => ({ ok: false, code: 1, output: (e as Error).message }));
  const next = updateState((s) => {
    const c = s.connections.find((x) => x.id === id);
    if (c) {
      c.retiredAt = new Date().toISOString();
      c.publicKey = key || c.publicKey;
    }
  }).connections.find((c) => c.id === id)!;
  await fsp.rm(path.join(CONF_DIR, `${id}.conf`), { force: true }).catch(() => {});
  return { connection: next, teardown: { ok: teardown.ok, output: teardown.output } };
}

/** Drop the record for good, once the far side has been dealt with. */
export function forgetConnection(id: string): void {
  updateState((s) => { s.connections = s.connections.filter((c) => c.id !== id); });
}
