// Live numbers for the console's monitors: throughput, time to first token,
// and how much of the last minute the box spent generating.
//
// The throughput measurement is worth explaining, because it is the one place
// perch could have been tempted to read a response body and is not. Ollama
// streams `/api/chat` as newline-delimited JSON, one object per token. So the
// number of newline bytes in the stream is the number of tokens, and perch
// counts bytes it never inspects: it learns the rate without learning a
// single word of what was written. The count is approximate by a token or two
// (the final object carries the summary rather than content) and that is a
// price worth paying to keep the promise.
const WINDOW_MS = 60_000;

interface Sample { at: number; tokens: number; ms: number; ttftMs: number | null }

const samples: Sample[] = [];

/** Tokens counted in the last second, for the moving graph. */
const ticks: Array<{ at: number; tokens: number }> = [];

export function recordTokens(tokens: number): void {
  if (tokens <= 0) return;
  ticks.push({ at: Date.now(), tokens });
  prune();
}

export function recordGeneration(tokens: number, ms: number, ttftMs: number | null): void {
  if (tokens <= 0 || ms <= 0) return;
  samples.push({ at: Date.now(), tokens, ms, ttftMs });
  prune();
}

function prune(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (samples.length && samples[0]!.at < cutoff) samples.shift();
  while (ticks.length && ticks[0]!.at < cutoff) ticks.shift();
}

export interface Throughput {
  /** Tokens per second over the last few seconds — what the needle shows. */
  current: number;
  /** Tokens per second of the last finished generation. */
  last: number;
  /** Average over the last minute of generating, ignoring idle time. */
  average: number;
  /** Time to first token of the last generation, in milliseconds. */
  ttftMs: number | null;
  /** Generations finished in the last minute. */
  generations: number;
  totalTokens: number;
}

export function throughput(): Throughput {
  prune();
  const now = Date.now();
  const recentTicks = ticks.filter((t) => now - t.at <= 3000);
  const currentTokens = recentTicks.reduce((n, t) => n + t.tokens, 0);
  // Measured against the window rather than against the span of the samples,
  // so the needle falls back to zero when generating stops instead of holding
  // the last rate for ever.
  const current = recentTicks.length ? currentTokens / 3 : 0;

  const last = samples.at(-1);
  const totalTokens = samples.reduce((n, s) => n + s.tokens, 0);
  const totalMs = samples.reduce((n, s) => n + s.ms, 0);

  return {
    current: Math.round(current * 10) / 10,
    last: last ? Math.round((last.tokens / (last.ms / 1000)) * 10) / 10 : 0,
    average: totalMs ? Math.round((totalTokens / (totalMs / 1000)) * 10) / 10 : 0,
    ttftMs: last?.ttftMs ?? null,
    generations: samples.length,
    totalTokens,
  };
}

export function reset(): void {
  samples.length = 0;
  ticks.length = 0;
}
