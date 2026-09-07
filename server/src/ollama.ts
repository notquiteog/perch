// The console's own client for Ollama. Separate from proxy.ts on purpose:
// the proxy is a pipe that must never interpret what passes through it, while
// the console genuinely needs to read answers — which models exist, how big
// they are, how a pull is progressing.
//
// Everything here talks to Ollama over the container network. Ollama itself
// publishes no port, so this is the only way in besides the proxy.
import { config } from './config.js';
import { loadState } from './state.js';
import { logger } from './log.js';

const log = logger('ollama');

async function call(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const res = await fetch(`${config.ollamaUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

async function json<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const res = await call(path, init, timeoutMs);
  if (!res.ok) throw new Error(`ollama ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export interface ModelInfo {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

export interface LoadedModel {
  name: string;
  model: string;
  size: number;
  /** How much of it is on the GPU. 0 means it is running on the CPU. */
  size_vram: number;
  expires_at: string;
}

export interface Health { ok: boolean; version?: string; error?: string }

export async function health(): Promise<Health> {
  try {
    const v = await json<{ version: string }>('/api/version', {}, 5000);
    return { ok: true, version: v.version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function listModels(): Promise<ModelInfo[]> {
  const r = await json<{ models?: ModelInfo[] }>('/api/tags');
  return r.models ?? [];
}

export async function loadedModels(): Promise<LoadedModel[]> {
  const r = await json<{ models?: LoadedModel[] }>('/api/ps', {}, 5000);
  return r.models ?? [];
}

export async function showModel(name: string): Promise<Record<string, unknown>> {
  return json<Record<string, unknown>>('/api/show', { method: 'POST', body: JSON.stringify({ model: name }) });
}

export async function deleteModel(name: string): Promise<void> {
  const res = await call('/api/delete', { method: 'DELETE', body: JSON.stringify({ model: name }) }, 60_000);
  if (!res.ok) throw new Error(`could not delete ${name}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Put a model in memory without asking it for anything, so the first real
 * request from Tern does not pay the load time. An empty prompt with a
 * keep_alive is Ollama's own idiom for this.
 */
export async function loadModel(name: string): Promise<void> {
  const keepAlive = loadState().settings.keepAlive || '10m';
  // An empty prompt with a keep_alive is Ollama's idiom for "load this and
  // hold it". It does not work for embedding models: they have no generate
  // endpoint and answer "does not support generate", which surfaced as an
  // unhandled error the moment somebody pressed Load on all-minilm. Warm those
  // through /api/embed instead, which is the only thing they do.
  const res = await call('/api/generate', { method: 'POST', body: JSON.stringify({ model: name, keep_alive: keepAlive }) }, 300_000);
  if (res.ok) { await res.text(); return; }

  const detail = (await res.text()).slice(0, 300);
  if (/does not support generate/i.test(detail)) {
    const embed = await call('/api/embed', {
      method: 'POST',
      body: JSON.stringify({ model: name, input: '', keep_alive: keepAlive }),
    }, 300_000);
    if (embed.ok) { await embed.text(); return; }
    throw new Error(`could not load ${name}: ${(await embed.text()).slice(0, 200)}`);
  }
  throw new Error(`could not load ${name}: ${detail.slice(0, 200)}`);
}

/**
 * Drop a model from memory now. Frees the VRAM, and with it the KV cache
 * holding whatever was last generated — which on this machine is somebody's
 * email. See docs/SECURITY.md.
 */
export async function unloadModel(name: string): Promise<void> {
  const res = await call('/api/generate', { method: 'POST', body: JSON.stringify({ model: name, keep_alive: 0 }) }, 30_000);
  if (res.ok) { await res.text(); return; }
  // Same asymmetry as loading: an embedding model is dropped through the
  // endpoint it actually has.
  const detail = (await res.text()).slice(0, 300);
  if (/does not support generate/i.test(detail)) {
    const embed = await call('/api/embed', { method: 'POST', body: JSON.stringify({ model: name, input: '', keep_alive: 0 }) }, 30_000);
    if (embed.ok) { await embed.text(); return; }
  }
  throw new Error(`could not unload ${name}: ${detail.slice(0, 200)}`);
}

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/**
 * Download a model, reporting progress as it goes. Ollama streams NDJSON; the
 * caller gets one parsed object per line and decides what to do with it (the
 * console forwards them to the browser as server-sent events).
 */
export async function pullModel(
  name: string,
  onProgress: (p: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${config.ollamaUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`could not start the download: ${res.status} ${(await res.text()).slice(0, 200)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as PullProgress & { error?: string };
        if (parsed.error) throw new Error(parsed.error);
        onProgress(parsed);
      } catch (e) {
        if ((e as Error).message && !(e instanceof SyntaxError)) throw e;
        log.debug('unparsed pull line', line.slice(0, 120));
      }
    }
  }
}
