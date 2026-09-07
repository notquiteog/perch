// Sizing: what this machine can actually run, and what it should run for
// writing email.
//
// The numbers below are the memory a model needs to be useful, not the size
// of its download. Weights are only part of it: every concurrent request
// holds its own context window of KV cache, and a card that fits the weights
// with nothing to spare will spill into system RAM and generate at a tenth of
// the speed. So each entry leaves room, and the recommendation prefers the
// model that runs well over the largest one that technically loads.
import { readHostStatus } from './host.js';
import { config } from './config.js';

export interface ModelChoice {
  name: string;
  /** Roughly how much memory it wants, in bytes, to run comfortably. */
  needsBytes: number;
  params: string;
  note: string;
}

// Ordered smallest first. Tags are the ones Ollama serves by default.
export const MODELS: ModelChoice[] = [
  { name: 'qwen2.5:1.5b', needsBytes: 2.0e9, params: '1.5B', note: 'Runs on anything, including a laptop with no GPU. Good for short replies and tidying up what you wrote; it will not surprise you.' },
  { name: 'llama3.2:3b', needsBytes: 3.5e9, params: '3B', note: 'The smallest model that writes a whole email without wandering. A sensible floor.' },
  { name: 'qwen2.5:7b', needsBytes: 6.5e9, params: '7B', note: 'The sweet spot for email on an 8 GB card. Follows instructions closely and keeps a tone once you give it one.' },
  { name: 'llama3.1:8b', needsBytes: 7.0e9, params: '8B', note: 'Warmer and more conversational than Qwen at the same size. Worth trying if replies read as stiff.' },
  { name: 'gemma2:9b', needsBytes: 8.5e9, params: '9B', note: 'Strong at rewriting and shortening. A little slower than the 7Bs.' },
  { name: 'qwen2.5:14b', needsBytes: 12.0e9, params: '14B', note: 'Noticeably better judgement about tone and about what to leave out. The first size where drafts often need no edit.' },
  { name: 'qwen2.5:32b', needsBytes: 24.0e9, params: '32B', note: 'For a 24 GB card. Writes email you would send unedited more often than not.' },
  { name: 'llama3.3:70b', needsBytes: 48.0e9, params: '70B', note: 'Two big cards or a very large machine. Diminishing returns for email specifically.' },
];

export const EMBED_MODELS: ModelChoice[] = [
  { name: 'all-minilm', needsBytes: 0.2e9, params: '23M', note: "Tern's default for meaning search. Tiny, and loads beside the writing model without competing for room." },
  { name: 'nomic-embed-text', needsBytes: 0.5e9, params: '137M', note: 'Better search quality, still small. Worth it if you search a large mailbox.' },
];

export interface Sizing {
  /** What the recommendation was made from. */
  basis: 'vram' | 'ram';
  usableBytes: number;
  recommended: ModelChoice;
  /** Everything this machine can run, largest first. */
  fits: ModelChoice[];
  /** Context window that will not push the model off the GPU. */
  numCtx: number;
}

export function sizing(): Sizing {
  const { status } = readHostStatus();
  const gpu = status?.gpus?.[0];
  const vramBytes = gpu?.memTotalMb ? gpu.memTotalMb * 1024 * 1024 : 0;
  const ramBytes = status?.mem?.totalKb ? status.mem.totalKb * 1024 : config.totalMemBytes;

  // A GPU is the thing that decides, when there is one. Without it the model
  // runs in system RAM, where the rest of the machine also lives — so only
  // about two thirds is really available.
  const basis: 'vram' | 'ram' = vramBytes > 1e9 ? 'vram' : 'ram';
  const usableBytes = basis === 'vram' ? vramBytes * 0.9 : ramBytes * 0.66;

  const fits = MODELS.filter((m) => m.needsBytes <= usableBytes).reverse();
  const recommended = fits[0] ?? MODELS[0]!;

  // Context costs memory per slot, so it scales with what is left after the
  // weights rather than being a fixed number for everybody.
  const headroom = usableBytes - recommended.needsBytes;
  let numCtx = 8192;
  if (headroom > 6e9) numCtx = 32768;
  else if (headroom > 3e9) numCtx = 16384;
  else if (headroom < 0.5e9) numCtx = 4096;

  return { basis, usableBytes, recommended, fits, numCtx };
}

/** Bytes, for a person. */
export function human(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
