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

/**
 * Delete a model, and then check that it is gone.
 *
 * A 200 from /api/delete was the whole story before, and it is not enough. A
 * name that differs from the stored one by `:latest` deletes nothing while
 * answering 200, and the console then showed the model as removed until the
 * next poll put it back — which looks exactly like the delete button not
 * working. The answer is the model list, not the status code.
 */
export async function deleteModel(name: string): Promise<ModelInfo[]> {
  // Dropped from memory first, or a resident copy keeps holding the VRAM the
  // deletion was meant to give back — and, on this machine, the KV cache with
  // somebody's email in it.
  await unloadModel(name).catch(() => {});
  const res = await call('/api/delete', {
    method: 'DELETE',
    // `model` is what current Ollama reads, `name` what it read before 0.4.
    // Sending both costs nothing and covers a delete that matched nothing.
    body: JSON.stringify({ model: name, name }),
  }, 60_000);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    if (res.status === 404) throw new Error(`ollama has no model called ${name}`);
    throw new Error(`could not delete ${name}: ${detail}`);
  }
  const after = await listModels().catch(() => null);
  if (after && after.some((m) => sameModel(m.name, name))) {
    throw new Error(`${name} is still on this machine after the delete was accepted`);
  }
  return after ?? [];
}

/**
 * Ollama tags an untagged name with `:latest` when it stores or loads it, so
 * the name somebody types and the name in /api/tags often differ by that
 * suffix alone.
 */
export function sameModel(a: string, b: string): boolean {
  const norm = (s: string): string => { const t = String(s ?? '').trim(); return t.includes(':') ? t : `${t}:latest`; };
  return Boolean(String(a ?? '').trim()) && norm(a) === norm(b);
}

/**
 * Everything the Models page draws, asked of Ollama every time.
 *
 * The page used to catch a failure into an empty array, so an Ollama that was
 * down and an Ollama with nothing downloaded produced the same screen: "no
 * models". On a machine whose entire job is holding models, that is the one
 * thing the page must not say by accident.
 */
export async function liveModels(): Promise<{ ok: boolean; error?: string; version?: string; installed: ModelInfo[]; loaded: LoadedModel[]; at: string }> {
  const at = new Date().toISOString();
  const h = await health();
  if (!h.ok) return { ok: false, error: h.error, installed: [], loaded: [], at };
  try {
    const [installed, loaded] = await Promise.all([listModels(), loadedModels().catch(() => [])]);
    return { ok: true, version: h.version, installed, loaded, at };
  } catch (e) {
    return { ok: false, version: h.version, error: (e as Error).message, installed: [], loaded: [], at };
  }
}

/**
 * keep_alive, in the shape Ollama will actually take.
 *
 * It accepts either a duration *string* with a unit — "30s", "10m" — or a
 * *number* of seconds, where a negative number means "never unload". The two
 * are not interchangeable: a bare "-1" as a string goes to Go's
 * ParseDuration, which rejects it with `time: missing unit in duration "-1"`,
 * and it does so before the model is even looked up.
 *
 * That matters because -1 is exactly what the Settings page offers for
 * keeping a model resident. Anybody who took that advice found the Load
 * button failing with a Go error about duration units, on a setting the
 * console itself recommended.
 */
export function keepAliveValue(raw: string | null | undefined): string | number {
  const value = (raw ?? '').trim() || '10m';
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

/**
 * Put a model in memory without asking it for anything, so the first real
 * request does not pay the load time. An empty prompt with a keep_alive is
 * Ollama's own idiom for this.
 */
export async function loadModel(name: string): Promise<void> {
  const keepAlive = keepAliveValue(loadState().settings.keepAlive);
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
      // A line that will not parse is noise and is skipped; a line that
      // parses and carries an error is the download failing and has to come
      // out of here rather than being logged as a curiosity. Parsing first
      // and throwing second keeps those two apart, which a single try/catch
      // around both could not.
      let parsed: (PullProgress & { error?: string }) | null = null;
      try {
        parsed = JSON.parse(line) as PullProgress & { error?: string };
      } catch {
        log.debug('unparsed pull line', line.slice(0, 120));
      }
      if (!parsed) continue;
      if (parsed.error) throw new Error(parsed.error);
      onProgress(parsed);
    }
  }
}
