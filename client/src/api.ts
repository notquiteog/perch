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
  containers: Array<{ name: string; status: string; startedAt: string }>;
  boot: { unit: string; active: string; enabled: string; since: string };
  tunnel: { unit: string; active: string; enabled: string; since: string };
}

export interface LoadedModel { name: string; model: string; size: number; size_vram: number; expires_at: string }
export interface ModelInfo {
  name: string; model: string; size: number; digest: string; modified_at: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}
export interface ModelChoice { name: string; needsBytes: number; params: string; note: string }
export interface Sizing { basis: 'vram' | 'ram'; usableBytes: number; recommended: ModelChoice; fits: ModelChoice[]; numCtx: number }
export interface Throughput { current: number; last: number; average: number; ttftMs: number | null; generations: number; totalTokens: number }

export interface TunnelState {
  configured: boolean; hasKey: boolean;
  active: string; enabled: string; since: string; endpointUp: boolean;
}

export interface Overview {
  version: string;
  ollama: { ok: boolean; version?: string; error?: string };
  loaded: LoadedModel[];
  modelCount: number; modelBytes: number;
  host: HostStatus | null; hostPresent: boolean; hostStale: boolean;
  sizing: Sizing;
  tunnel: TunnelState;
  tern: { baseUrl: string; baseUrlLiteral: string; model: string };
  settings: { allowManage: boolean; keepAlive: string; unloadWhenIdle: boolean };
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

export interface TunnelConfig {
  host: string; user: string; sshPort: number;
  remoteBind: string; remotePort: number;
  keyPath: string; publicKey: string; ternBaseUrl: string; configuredAt: string | null;
}

export interface TunnelPage {
  config: TunnelConfig;
  status: TunnelState;
  publicKey: string | null;
  ternBaseUrl: string; ternBaseUrlLiteral: string;
  setupCommand: string | null; setupManual: string; sshCommand: string;
  localPort: number;
}

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

export const api = {
  session: () => request<{ passwordSet: boolean; authenticated: boolean; loopback: boolean; version: string }>('/api/session'),
  signIn: (password: string) => request<{ ok: true }>('/api/session', { method: 'POST', body: JSON.stringify({ password }) }),
  signOut: () => request<{ ok: true }>('/api/session', { method: 'DELETE' }),
  setConsolePassword: (password: string | null) => request<{ ok: true; passwordSet: boolean }>('/api/console-password', { method: 'POST', body: JSON.stringify({ password }) }),

  overview: () => request<Overview>('/api/overview'),

  models: () => request<{
    installed: ModelInfo[]; loaded: LoadedModel[];
    catalog: ModelChoice[]; embedCatalog: ModelChoice[];
    sizing: Sizing; totalBytes: number; totalHuman: string;
  }>('/api/models'),
  deleteModel: (name: string) => request<{ ok: true }>('/api/models/delete', { method: 'POST', body: JSON.stringify({ name }) }),
  loadModel: (name: string) => request<{ ok: true }>('/api/models/load', { method: 'POST', body: JSON.stringify({ name }) }),
  unloadModel: (name: string) => request<{ ok: true }>('/api/models/unload', { method: 'POST', body: JSON.stringify({ name }) }),

  tokens: () => request<{ tokens: TokenRecord[] }>('/api/tokens'),
  createToken: (name: string, scopes: Array<'use' | 'manage'>) =>
    request<{ token: string; record: TokenRecord }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name, scopes }) }),
  revokeToken: (id: string) => request<{ ok: true }>(`/api/tokens/${id}/revoke`, { method: 'POST' }),
  deleteToken: (id: string) => request<{ ok: true }>(`/api/tokens/${id}`, { method: 'DELETE' }),

  tunnel: () => request<TunnelPage>('/api/tunnel'),
  saveTunnel: (body: Partial<TunnelConfig>) => request<{ config: TunnelConfig; applied: { ok: boolean; output: string } }>('/api/tunnel', { method: 'PUT', body: JSON.stringify(body) }),
  generateKey: () => request<{ publicKey: string }>('/api/tunnel/key', { method: 'POST' }),
  pairTunnel: (text: string) => request<{
    config: TunnelConfig;
    baseUrl: string; baseUrlLiteral: string;
    token: string | null; hasExistingToken: boolean;
    status: TunnelState;
    steps: Record<string, { ok: boolean; output: string }>;
  }>('/api/tunnel/pair', { method: 'POST', body: JSON.stringify({ text }) }),
  tunnelAction: (action: 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'logs') =>
    request<{ ok: boolean; output: string }>(`/api/tunnel/${action}`, { method: 'POST' }),

  containerAction: (action: 'start' | 'stop' | 'restart' | 'pull', service?: 'perch' | 'ollama') =>
    request<{ ok: boolean; output: string }>(`/api/containers/${action}`, { method: 'POST', body: JSON.stringify({ service }) }),
  boot: (state: 'enable' | 'disable') => request<{ ok: boolean; output: string }>(`/api/boot/${state}`, { method: 'POST' }),
  logs: (service: 'perch' | 'ollama' | 'tunnel') => request<{ ok: boolean; output: string }>(`/api/logs/${service}`),

  settings: () => request<{
    settings: { allowManage: boolean; keepAlive: string; unloadWhenIdle: boolean };
    proxy: { routes: Array<{ method: string; path: string; scope: string }>; maxConcurrent: number; port: number };
    hostAvailable: boolean;
  }>('/api/settings'),
  saveSettings: (body: Partial<{ allowManage: boolean; keepAlive: string; unloadWhenIdle: boolean }>) =>
    request<{ settings: { allowManage: boolean; keepAlive: string; unloadWhenIdle: boolean } }>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  setOllamaEnv: (key: string, value: string) =>
    request<{ ok: boolean; output: string }>('/api/ollama-env', { method: 'PUT', body: JSON.stringify({ key, value }) }),

  activity: (limit = 100) => request<{
    entries: Array<{ at: string; method: string; path: string; status: number; ms: number; bytes: number; token: string | null; ip: string; note?: string }>;
    summary: { total: number; errors: number; lastAt: string | null };
  }>(`/api/activity?limit=${limit}`),
};

/** A download, as a stream of progress events rather than one long wait. */
export function pullModel(
  name: string,
  onProgress: (p: { status: string; total?: number; completed?: number }) => void,
  onDone: (error?: string) => void,
): () => void {
  const source = new EventSource(`/api/models/pull?name=${encodeURIComponent(name)}`);
  source.addEventListener('progress', (e) => onProgress(JSON.parse((e as MessageEvent).data)));
  source.addEventListener('done', () => { source.close(); onDone(); });
  source.addEventListener('failed', (e) => {
    source.close();
    onDone((JSON.parse((e as MessageEvent).data) as { error: string }).error);
  });
  source.onerror = () => { source.close(); onDone('the connection to perch dropped'); };
  return () => source.close();
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
