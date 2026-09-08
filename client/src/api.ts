// Everything the console asks the server for. Thin on purpose: the server
// already decides what is allowed, and duplicating those rules here would
// only create two places to disagree.

export interface Gpu {
  vendor: string; name: string;
  memTotalMb: number | null; memUsedMb: number | null;
  utilPct: number | null; tempC: number | null; powerW: number | null;
}

export interface HostStatus {
  at: string; hostname: string; kernel: string; uptimeSeconds: number | null;
  mem: { totalKb: number | null; availableKb: number | null; freeKb: number | null; swapTotalKb: number | null; swapFreeKb: number | null };
  cpu: { load1: number | null; load5: number | null; load15: number | null; cores: number | null };
  gpus: Gpu[];
  disk: { path: string; totalKb: number | null; usedKb: number | null; availableKb: number | null; usedPct: number | null };
  /** With the resource limits each container was created with, where podman could say. */
  containers: Array<{ name: string; status: string; startedAt: string; memLimitBytes?: number | null; cpus?: number | null }>;
  boot: { unit: string; active: string; enabled: string; since: string };
  tunnel: { unit: string; active: string; enabled: string; since: string };
}

export interface LoadedModel { name: string; model: string; size: number; size_vram: number; expires_at: string }
export interface ModelInfo {
  name: string; model: string; size: number; digest: string; modified_at: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}
export interface ModelChoice {
  name: string; needsBytes: number; sizeBytes: number;
  params: string; contextTokens: number | null; current?: boolean; note: string;
}
export interface Sizing { basis: 'vram' | 'ram'; usableBytes: number; recommended: ModelChoice; fits: ModelChoice[]; numCtx: number }
/** A download, as the server sees it. It is a job there, not this request. */
export interface PullView {
  name: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  status: string;
  completed: number;
  total: number;
  /** Whole percent, or null while nothing has been sized yet. */
  pct: number | null;
  bytesPerSec: number | null;
  etaSeconds: number | null;
  startedAt: number;
  endedAt: number | null;
  error?: string;
}

export interface SpeechModel { name: string; sizeBytes: number; needsBytes: number; note: string }

export type MediaFamily = 'image' | 'video' | 'audio';
export interface MediaFile { url: string; dest: string; bytes: number }
export interface MediaModel {
  id: string; name: string; family: MediaFamily; service: ServiceId;
  params: string; sizeBytes: number; needsBytes: number;
  bundled?: boolean; files: MediaFile[]; note: string;
}
/** What one generation backend says about itself, and what it can see. */
export interface MediaServiceStatus {
  id: ServiceId; enabled: boolean; url: string;
  ok: boolean; starting: boolean; error?: string;
  installed: string[]; at: string;
}
export interface MediaOverview {
  models: MediaModel[];
  services: MediaServiceStatus[];
  volumes: Partial<Record<ServiceId, { volume: string; subdir: string }>>;
  at: string;
}

/** One container, and how big it is allowed to be. */
export interface ContainerSize {
  id: string; label: string; service: ServiceId | null; enabled: boolean;
  memKey: string; cpuKey: string; defaultMem: string; floorBytes: number; note: string;
  /** What .env asks for, as compose passed it through. */
  configuredMem: string | null; configuredCpus: string | null;
  /** Whether perch was told the configured value at all, or is showing the default. */
  known: boolean;
  /** What the running container was actually created with. */
  effectiveMemBytes: number | null; effectiveCpus: number | null;
  running: boolean; status: string | null;
}

export interface VoiceStatus {
  enabled: boolean; url: string;
  /** What .env asks for next time the container is created. */
  model: string; modelKnown: boolean;
  /** What it is actually running, from the host helper; null when unknown. */
  running: string | null;
  /** A model is set that the running container does not have. */
  pending: boolean;
  ok: boolean; error?: string; starting: boolean;
  catalog: SpeechModel[]; at: string;
}

export interface Throughput { current: number; last: number; average: number; ttftMs: number | null; generations: number; totalTokens: number }

export type TunnelProblem =
  | 'host-key-changed' | 'key-rejected' | 'forward-refused' | 'host-unknown' | 'unreachable';

export interface ConnectionStatus {
  id: string; configured: boolean; hasKey: boolean;
  active: string; enabled: string; since: string; retired: boolean;
  /** Why it is not up, when ssh said so plainly, and that in a sentence. */
  problem: TunnelProblem | '';
  problemSays: string;
}

export type ServiceId = 'chat' | 'voice' | 'video' | 'audio';

/** One endpoint perch fronts: its port, its allowlist and what it costs. */
/** The console's copy of perch's stored settings. */
export interface PerchSettings {
  allowManage: boolean;
  keepAlive: string;
  unloadWhenIdle: boolean;
  /** Per service: a proxy URL for reaching its upstream, or empty for direct. */
  proxies: Record<ServiceId, string>;
}

export interface ServiceInfo {
  id: ServiceId;
  label: string; blurb: string;
  port: number; enabled: boolean;
  overlay: string | null; ternField: string | null; speaks: string;
  /** The same as `speaks`, as data — one badge per shape. */
  api: Array<'ollama' | 'openai' | 'anthropic' | 'comfyui'>;
  /** This service's own upstream, and the env var that presets its proxy. */
  upstream: string; proxyEnv: string;
  vramHintBytes: number;
  routes: Array<{ method: string; path: string; scope: string }>;
}

export interface Forward { id: string; localPort: number; remotePort: number; label: string }
export interface TernUrl {
  id: string; label: string; url: string; literal: string;
  /** Where it goes in Tern, for the services Tern has a setting for. */
  ternField: string | null;
  /** The API shape behind the address, for anything else pointing at it. */
  speaks: string;
}

export interface Connection {
  id: string; name: string;
  host: string; user: string; sshPort: number;
  remoteBind: string; remotePort: number;
  torProxy: string;
  services: string[];
  forwards: Forward[];
  ternUrls: TernUrl[];
  keyPath: string; publicKey: string;
  createdAt: string; configuredAt: string | null; retiredAt: string | null;
  status: ConnectionStatus;
  ternBaseUrl: string; ternBaseUrlLiteral: string;
  setupCommand: string | null; setupManual: string;
  uninstallCommand: string | null; sshCommand: string;
}

export interface Overview {
  version: string;
  ollama: { ok: boolean; version?: string; error?: string };
  loaded: LoadedModel[];
  modelCount: number; modelBytes: number;
  host: HostStatus | null; hostPresent: boolean; hostStale: boolean;
  sizing: Sizing;
  connections: Array<Connection & { status: ConnectionStatus; ternBaseUrl: string }>;
  endpointUp: boolean;
  settings: PerchSettings;
  tokens: number;
  activity: { total: number; errors: number; lastAt: string | null };
  throughput: Throughput;
  inFlight: number;
  endpoint: { port: number; bind: string };
}

export interface Tick {
  at: string;
  host: HostStatus | null;
  hostStale: boolean;
  loaded: LoadedModel[];
  throughput: Throughput;
  inFlight: number;
}

export interface TokenRecord {
  id: string; name: string; prefix: string;
  scopes: Array<'use' | 'manage'>;
  createdAt: string; lastUsedAt: string | null; lastUsedIp: string | null; revokedAt: string | null;
}

/** The compose services perch runs, which are what a restart or a log names. */
export type ContainerName = 'perch' | 'ollama' | 'whisper' | 'comfy' | 'kokoro';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* not JSON */ }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface TuningKey {
  key: string;
  /** The container that reads it, and so the one that has to be recreated. */
  container: string;
  /** What .env asks for, read from the file rather than remembered. */
  configured: string | null;
  /** What the container was created with, or null when nothing could say. */
  running: string | null;
  /** Written, not yet applied: both are known and they disagree. */
  pending: boolean;
}

export const api = {
  session: () => request<{ passwordSet: boolean; authenticated: boolean; loopback: boolean; containerised: boolean; version: string }>('/api/session'),
  signIn: (password: string) => request<{ ok: true }>('/api/session', { method: 'POST', body: JSON.stringify({ password }) }),
  signOut: () => request<{ ok: true }>('/api/session', { method: 'DELETE' }),
  setConsolePassword: (password: string | null) => request<{ ok: true; passwordSet: boolean }>('/api/console-password', { method: 'POST', body: JSON.stringify({ password }) }),

  overview: () => request<Overview>('/api/overview'),

  models: () => request<{
    ok: boolean; error?: string; at: string;
    installed: ModelInfo[]; loaded: LoadedModel[]; pulls: PullView[];
    catalog: ModelChoice[]; embedCatalog: ModelChoice[]; uncensoredCatalog: ModelChoice[];
    sizing: Sizing; totalBytes: number; totalHuman: string;
  }>('/api/models'),
  deleteModel: (name: string) => request<{ ok: true; deleted: string; installed: ModelInfo[]; loaded: LoadedModel[] }>('/api/models/delete', { method: 'POST', body: JSON.stringify({ name }) }),
  cancelPull: (name: string) => request<{ cancelled: boolean }>('/api/models/cancel', { method: 'POST', body: JSON.stringify({ name }) }),

  voice: () => request<VoiceStatus>('/api/voice'),

  media: () => request<MediaOverview>('/api/media'),

  containers: () => request<{ containers: ContainerSize[]; hostAvailable: boolean; totalMemBytes: number }>('/api/containers'),
  setContainerSize: (id: string, body: { mem?: string; cpus?: string; apply?: boolean }) =>
    request<{
      ok: boolean;
      set: Array<{ key: string; ok: boolean; output: string }>;
      applied: { ok: boolean; output: string } | null;
      containers: ContainerSize[];
    }>(`/api/containers/${id}/size`, { method: 'PUT', body: JSON.stringify(body) }),
  setSpeechModel: (model: string) => request<{ ok: boolean; changed: boolean; set?: { ok: boolean; output: string }; applied?: { ok: boolean; output: string } | null; status?: VoiceStatus }>(
    '/api/voice/model', { method: 'PUT', body: JSON.stringify({ model }) },
  ),
  loadModel: (name: string) => request<{ ok: true }>('/api/models/load', { method: 'POST', body: JSON.stringify({ name }) }),
  unloadModel: (name: string) => request<{ ok: true }>('/api/models/unload', { method: 'POST', body: JSON.stringify({ name }) }),

  tokens: () => request<{ tokens: TokenRecord[] }>('/api/tokens'),
  createToken: (name: string, scopes: Array<'use' | 'manage'>) =>
    request<{ token: string; record: TokenRecord }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name, scopes }) }),
  revokeToken: (id: string) => request<{ ok: true }>(`/api/tokens/${id}/revoke`, { method: 'POST' }),
  deleteToken: (id: string) => request<{ ok: true }>(`/api/tokens/${id}`, { method: 'DELETE' }),

  connections: () => request<{ connections: Connection[]; endpointUp: boolean; localPort: number }>('/api/connections'),
  createConnection: (body: { name: string; host: string; sshPort?: number; user?: string; remotePort?: number; torProxy?: string; services?: string[] }) =>
    request<{ connection: Connection }>('/api/connections', { method: 'POST', body: JSON.stringify(body) }),
  updateConnection: (id: string, body: Partial<Connection>) =>
    request<{ connection: Connection; applied: { ok: boolean; output: string } }>(`/api/connections/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  connectionKey: (id: string) => request<{ publicKey: string }>(`/api/connections/${id}/key`, { method: 'POST' }),
  hostKeys: (id: string) => request<{ hostKeys: string }>(`/api/connections/${id}/hostkey`),
  acceptHostKey: (id: string) =>
    request<{ connection: Connection; output: string }>(`/api/connections/${id}/hostkey`, { method: 'POST' }),
  pairConnection: (id: string, text: string) => request<{
    connection: Connection; token: string | null; hasExistingToken: boolean;
    steps: Record<string, { ok: boolean; output: string }>;
  }>(`/api/connections/${id}/pair`, { method: 'POST', body: JSON.stringify({ text }) }),
  connectionAction: (id: string, action: 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'logs') =>
    request<{ ok: boolean; output: string }>(`/api/connections/${id}/${action}`, { method: 'POST' }),
  removeConnection: (id: string) => request<{
    connection: Connection; teardown: { ok: boolean; output: string }; uninstallCommand: string | null;
  }>(`/api/connections/${id}`, { method: 'DELETE' }),
  forgetConnection: (id: string) => request<{ ok: true }>(`/api/connections/${id}/forget`, { method: 'POST' }),

  containerAction: (action: 'start' | 'stop' | 'restart' | 'pull', service?: ContainerName) =>
    request<{ ok: boolean; output: string }>(`/api/containers/${action}`, { method: 'POST', body: JSON.stringify({ service }) }),
  boot: (state: 'enable' | 'disable') => request<{ ok: boolean; output: string }>(`/api/boot/${state}`, { method: 'POST' }),
  logs: (service: ContainerName | 'tunnel') => request<{ ok: boolean; output: string }>(`/api/logs/${service}`),

  settings: () => request<{
    settings: PerchSettings;
    services: ServiceInfo[];
    proxy: { maxConcurrent: number; port: number };
    hostAvailable: boolean;
  }>('/api/settings'),
  saveSettings: (body: Partial<{ allowManage: boolean; keepAlive: string; unloadWhenIdle: boolean; proxies: Partial<Record<ServiceId, string>> }>) =>
    request<{ settings: PerchSettings }>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  // Both halves of each knob: what .env asks for, and what the container that
  // reads it was actually created with. They differ while a change is written
  // and not applied, which is the only way to see that from the console.
  ollamaEnv: () => request<{ hostAvailable: boolean; keys: TuningKey[] }>('/api/ollama-env'),
  // `apply` recreates the container that reads the key. Without it the value
  // is written to .env and nothing else — which is the honest half of what
  // this used to claim a restart would do.
  setOllamaEnv: (key: string, value: string, apply = false) =>
    request<{
      ok: boolean; output: string; key: string; container: string;
      set: { ok: boolean; output: string };
      applied: { ok: boolean; output: string } | null;
    }>('/api/ollama-env', { method: 'PUT', body: JSON.stringify({ key, value, apply }) }),

  activity: (limit = 100) => request<{
    entries: Array<{ at: string; method: string; path: string; status: number; ms: number; bytes: number; token: string | null; ip: string; note?: string }>;
    summary: { total: number; errors: number; lastAt: string | null };
  }>(`/api/activity?limit=${limit}`),
};

/**
 * Watch a download.
 *
 * What arrives is the server's whole view of the job — summed across layers,
 * with a rate and an estimate — rather than the raw line Ollama last emitted.
 * Closing this stream does not stop the download: it is a job on the server,
 * and the models poll picks it back up. Only `api.cancelPull` stops one.
 */
export function pullModel(
  name: string,
  onProgress: (p: PullView) => void,
  onDone: (error?: string) => void,
): () => void {
  const source = new EventSource(`/api/models/pull?name=${encodeURIComponent(name)}`);
  let settled = false;
  const finish = (error?: string): void => { if (settled) return; settled = true; source.close(); onDone(error); };
  source.addEventListener('progress', (e) => onProgress(JSON.parse((e as MessageEvent).data) as PullView));
  source.addEventListener('done', () => finish());
  source.addEventListener('failed', (e) => finish((JSON.parse((e as MessageEvent).data) as { error: string }).error));
  // EventSource reconnects by itself on a dropped connection, which for a
  // GET that starts work would silently start it again. Closing on the first
  // error is what stops that; the download itself is unaffected either way.
  source.onerror = () => finish('the connection to the console dropped — the download is still running');
  return () => { settled = true; source.close(); };
}

export function human(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function relative(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
