// Downloads that outlive the page that started them.
//
// The console's Models page opened an EventSource, the route drove Ollama
// inside that request, and `res.on('close')` aborted it. Which meant that
// switching to the System tab, reloading, or letting the laptop sleep killed
// a download — and on this machine that is a 17 GB model over a domestic
// line, with no evidence afterwards beyond a model that never appeared.
//
// So a pull is a job here now. Starting one twice attaches to the one already
// running; watching it is a subscription that can be dropped and remade; only
// an explicit cancel stops it.
//
// The other half is arithmetic. Ollama reports progress per layer, and
// reporting that number directly is what made the bar restart from zero
// several times per download and reach "100%" more than once. Progress is
// summed across every layer the stream has mentioned.
import { logger } from './log.js';

const log = logger('pull');

export interface PullLine { status?: string; digest?: string; total?: number; completed?: number; error?: string }

export interface PullView {
  name: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  /** The phase the far end last named. */
  status: string;
  /** Bytes across every layer seen so far. */
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

interface Job {
  view: PullView;
  abort: AbortController;
  layers: Map<string, { total: number; completed: number }>;
  watchers: Set<(v: PullView) => void>;
  lastSample: { at: number; completed: number } | null;
  sweep?: NodeJS.Timeout;
}

const jobs = new Map<string, Job>();

/** How long a finished job stays visible, so a page that reconnects learns the outcome. */
const KEEP_FINISHED_MS = 90_000;

function publish(job: Job): void {
  const snapshot = { ...job.view };
  for (const fn of job.watchers) {
    try { fn(snapshot); } catch { /* a dead socket is not this job's problem */ }
  }
}

function absorb(job: Job, line: PullLine): void {
  if (line.status) job.view.status = line.status;
  if (line.digest && typeof line.total === 'number' && line.total > 0) {
    const prev = job.layers.get(line.digest);
    job.layers.set(line.digest, {
      total: Math.max(line.total, prev?.total ?? 0),
      // Ollama re-sends a layer's final size; never let a late line move one
      // backwards.
      completed: Math.max(line.completed ?? 0, prev?.completed ?? 0),
    });
  }
  let total = 0;
  let completed = 0;
  for (const l of job.layers.values()) { total += l.total; completed += Math.min(l.completed, l.total); }
  job.view.total = total;
  job.view.completed = completed;
  job.view.pct = total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : null;
  rate(job);
}

// Smoothed, because an unsmoothed estimate off registry throughput is
// unreadable.
function rate(job: Job): void {
  const now = Date.now();
  const sample = job.lastSample;
  if (!sample) { job.lastSample = { at: now, completed: job.view.completed }; return; }
  const dt = (now - sample.at) / 1000;
  if (dt < 1) return;
  const db = job.view.completed - sample.completed;
  job.lastSample = { at: now, completed: job.view.completed };
  if (db < 0) return;
  const instant = db / dt;
  job.view.bytesPerSec = job.view.bytesPerSec === null ? instant : job.view.bytesPerSec * 0.7 + instant * 0.3;
  const left = job.view.total - job.view.completed;
  job.view.etaSeconds = job.view.bytesPerSec > 1024 && left > 0 ? Math.round(left / job.view.bytesPerSec) : null;
}

function finish(job: Job, state: PullView['state'], error?: string): void {
  if (job.view.state !== 'running') return;
  job.view.state = state;
  job.view.endedAt = Date.now();
  job.view.bytesPerSec = null;
  job.view.etaSeconds = null;
  if (error) job.view.error = error;
  if (state === 'done') { job.view.status = 'ready'; if (job.view.total > 0) { job.view.completed = job.view.total; job.view.pct = 100; } }
  publish(job);
  log.info(`pull ${state}: ${job.view.name}${error ? ` (${error})` : ''}`);
  job.sweep = setTimeout(() => { if (jobs.get(job.view.name) === job) jobs.delete(job.view.name); }, KEEP_FINISHED_MS);
  job.sweep.unref?.();
}

/**
 * Start a download, or hand back the one already running for this name. The
 * runner is driven to completion by this function and not by whoever is
 * watching: the returned view is a handle, not the work.
 */
export function startPull(
  name: string,
  run: (emit: (line: PullLine) => void, signal: AbortSignal) => Promise<void>,
): PullView {
  const existing = jobs.get(name);
  if (existing && existing.view.state === 'running') return { ...existing.view };
  if (existing?.sweep) clearTimeout(existing.sweep);

  const abort = new AbortController();
  const job: Job = {
    view: {
      name, state: 'running', status: 'starting',
      completed: 0, total: 0, pct: null, bytesPerSec: null, etaSeconds: null,
      startedAt: Date.now(), endedAt: null,
    },
    abort,
    layers: new Map(),
    watchers: new Set(),
    lastSample: null,
  };
  jobs.set(name, job);
  log.info(`pull started: ${name}`);

  void (async () => {
    try {
      await run((line) => {
        if (job.view.state !== 'running') return;
        if (line.error) throw new Error(line.error);
        absorb(job, line);
        publish(job);
      }, abort.signal);
      if (abort.signal.aborted) finish(job, 'cancelled', 'cancelled');
      else finish(job, 'done');
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      if (abort.signal.aborted) finish(job, 'cancelled', 'cancelled');
      else finish(job, 'error', message);
    }
  })();

  return { ...job.view };
}

/** Every job this process knows about, running or recently finished. */
export function listPulls(): PullView[] {
  return [...jobs.values()].map((j) => ({ ...j.view })).sort((a, b) => a.startedAt - b.startedAt);
}

export function getPull(name: string): PullView | null {
  const job = jobs.get(name);
  return job ? { ...job.view } : null;
}

/**
 * Watch a job. The current state arrives immediately — a console that reloads
 * mid-download sees where it is — and the returned function detaches without
 * touching the download.
 */
export function watchPull(name: string, onUpdate: (v: PullView) => void): (() => void) | null {
  const job = jobs.get(name);
  if (!job) return null;
  onUpdate({ ...job.view });
  if (job.view.state !== 'running') return () => {};
  job.watchers.add(onUpdate);
  return () => { job.watchers.delete(onUpdate); };
}

/** Stop a download on purpose. The only thing that does. */
export function cancelPull(name: string): boolean {
  const job = jobs.get(name);
  if (!job || job.view.state !== 'running') return false;
  job.abort.abort();
  finish(job, 'cancelled', 'cancelled');
  return true;
}

/** Tests only. */
export function resetPulls(): void {
  for (const job of jobs.values()) { if (job.sweep) clearTimeout(job.sweep); job.abort.abort(); }
  jobs.clear();
}
