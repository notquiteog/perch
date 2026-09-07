// The tunnel, from the console's side: its settings, the key, the two
// commands a person has to run, and the check that says whether it is up.
//
// The console does not run ssh itself. It writes the settings down, asks the
// host helper to render the systemd unit from them, and lets systemd own the
// process — which is what makes the tunnel survive a reboot, a dropped line
// and a closed browser tab.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { config } from './config.js';
import { loadState, updateState, type TunnelConfig } from './state.js';
import { readHostStatus, runHostAction } from './host.js';
import { badRequest } from './http.js';

const KEY_DIR = path.join(config.stateDir, 'ssh');
const PUB_KEY = path.join(KEY_DIR, 'id_ed25519.pub');
const CONF = path.join(config.stateDir, 'tunnel.conf');

export function publicKey(): string | null {
  try {
    return fs.readFileSync(PUB_KEY, 'utf8').trim();
  } catch {
    return null;
  }
}

function isPrivateIp(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function validate(input: Partial<TunnelConfig>): void {
  if (input.host !== undefined && !/^[A-Za-z0-9._-]{1,253}$/.test(input.host)) {
    throw badRequest('That does not look like a hostname or an IP address.');
  }
  if (input.user !== undefined && !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.user)) {
    throw badRequest('That is not a valid Linux account name.');
  }
  for (const [k, v] of [['sshPort', input.sshPort], ['remotePort', input.remotePort]] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 65535)) throw badRequest(`${k} must be a port number.`);
  }
  if (input.remoteBind !== undefined && !isPrivateIp(input.remoteBind)) {
    // The same rail as both scripts. It is stated three times because it is
    // the one mistake in this design that would be genuinely bad.
    throw badRequest(
      'The tunnel may only land on a private address — loopback, or the podman bridge on the Tern box. '
      + 'Binding a public address would put your model endpoint on the internet.',
    );
  }
}

export async function saveTunnel(input: Partial<TunnelConfig>): Promise<TunnelConfig> {
  validate(input);
  const next = updateState((s) => {
    s.tunnel = { ...s.tunnel, ...input, publicKey: publicKey() ?? s.tunnel.publicKey };
    s.tunnel.ternBaseUrl = ternBaseUrl(s.tunnel);
    if (input.host || input.user) s.tunnel.configuredAt = new Date().toISOString();
  }).tunnel;

  // The helper reads this rather than taking six arguments; see
  // do_tunnel_configure in deploy/perch-hostd.
  await fsp.mkdir(config.stateDir, { recursive: true }).catch(() => {});
  await fsp.writeFile(
    CONF,
    [
      `HOST=${next.host}`,
      `USER=${next.user}`,
      `SSH_PORT=${next.sshPort}`,
      `REMOTE_BIND=${next.remoteBind}`,
      `REMOTE_PORT=${next.remotePort}`,
      `LOCAL_PORT=${config.proxyPort}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return next;
}

/**
 * What Tern should be given. `host.containers.internal` is the name Tern's
 * container has for the podman bridge, and it is stable across the network
 * being recreated in a way the literal address is not — but the literal
 * address always works, so the console shows both.
 */
export function ternBaseUrl(t: TunnelConfig): string {
  if (t.remoteBind === '127.0.0.1') return `http://127.0.0.1:${t.remotePort}`;
  return `http://host.containers.internal:${t.remotePort}`;
}

export function ternBaseUrlLiteral(t: TunnelConfig): string {
  return `http://${t.remoteBind}:${t.remotePort}`;
}

/** The command to paste on the Tern box, with this perch's key already in it. */
export function ternSetupCommand(t: TunnelConfig): string | null {
  const key = publicKey();
  if (!key) return null;
  const parts = [
    'curl -fsSL https://raw.githubusercontent.com/notquiteog/perch/main/deploy/tern-side-setup.sh',
    '  | sudo bash -s --',
    `  --key ${JSON.stringify(key)}`,
    `  --user ${t.user}`,
    `  --port ${t.remotePort}`,
  ];
  return parts.join(' \\\n');
}

/** The same thing, for someone who would rather read the script first. */
export function ternSetupManual(t: TunnelConfig): string {
  const key = publicKey() ?? '<generate a key first>';
  return [
    '# On the Tern box:',
    'curl -fsSLO https://raw.githubusercontent.com/notquiteog/perch/main/deploy/tern-side-setup.sh',
    'less tern-side-setup.sh          # read it first',
    `sudo bash tern-side-setup.sh --key ${JSON.stringify(key)} --user ${t.user} --port ${t.remotePort}`,
  ].join('\n');
}

/** What systemd will actually run, for the console to show. */
export function sshCommandPreview(t: TunnelConfig): string {
  return [
    'ssh -NT',
    '  -o ExitOnForwardFailure=yes',
    '  -o ServerAliveInterval=30 -o ServerAliveCountMax=3',
    `  -i ${t.keyPath}`,
    `  -p ${t.sshPort}`,
    `  -R ${t.remoteBind}:${t.remotePort}:127.0.0.1:${config.proxyPort}`,
    `  ${t.user}@${t.host}`,
  ].join(' \\\n');
}

export interface TunnelStatus {
  configured: boolean;
  hasKey: boolean;
  /** From systemd, via the host helper. */
  active: string;
  enabled: string;
  since: string;
  /** True when the local end is listening, which is the half perch can see. */
  endpointUp: boolean;
}

export async function tunnelStatus(): Promise<TunnelStatus> {
  const t = loadState().tunnel;
  const { status } = readHostStatus();
  return {
    configured: Boolean(t.host && t.user),
    hasKey: publicKey() !== null,
    active: status?.tunnel?.active ?? 'unknown',
    enabled: status?.tunnel?.enabled ?? 'unknown',
    since: status?.tunnel?.since ?? '',
    endpointUp: await localEndpointUp(),
  };
}

/**
 * Can something on this machine reach the model endpoint? It says nothing
 * about the far end — only the Tern box can answer that — but a failure here
 * means the problem is on this side, which halves the search.
 */
function localEndpointUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: config.proxyPort });
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

export interface Pairing { bind: string; port: number }

/**
 * The one value perch cannot work out for itself.
 *
 * The bridge address belongs to the Tern box, and the tunnel key is
 * deliberately restricted to nologin, so there is no way to ask for it over
 * SSH. tern-side-setup.sh prints it as a single line; this reads that line
 * back out of whatever was pasted, so somebody can select the whole terminal
 * output rather than picking the address out of it by eye.
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
  // Runs the same rail as everything else: a pasted line is untrusted input
  // like any other, and this one decides what address gets bound.
  validate({ remoteBind: bind, remotePort: port });
  return { bind, port };
}

export async function generateKey(): Promise<string> {
  const result = await runHostAction('tunnel.keygen', '', 30_000);
  if (!result.ok) throw badRequest(result.output || 'could not generate a key');
  const key = publicKey();
  if (!key) throw badRequest('the key was generated but could not be read back');
  updateState((s) => { s.tunnel.publicKey = key; });
  return key;
}
