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
  /** The download, as the registry reports it. */
  sizeBytes: number;
  params: string;
  /** Training context window, where it is known. */
  contextTokens: number | null;
  /**
   * Part of the current generation, and so what the recommendation reaches
   * for first. Without this the sizing picks whatever is largest, and a
   * previous-generation model one notch bigger wins over a newer one that
   * would write better — which is how a catalogue quietly goes stale while
   * still looking maintained.
   */
  current?: boolean;
  note: string;
}

// Sizes below are the real download sizes, read from the Ollama registry
// rather than remembered — every tag here was checked to exist. That check is
// worth repeating whenever this list is edited: a catalogue of plausible tags
// that do not resolve is worse than no catalogue, because it fails at the
// download rather than at the suggestion.
//
// `needsBytes` is the download plus room to actually run: about 20% for
// overhead and runtime buffers, and a further 1.5 GB for the context window
// and a second request slot. A model whose weights merely fit will spill into
// system memory the moment anyone sends it a long thread, and generate at a
// fraction of the speed — so the sizing prefers the model that runs well over
// the largest one that technically loads.
//
// On quality: the sizes and the fit here are measured. The ordering by
// capability is not something this file can verify, and a newer model at a
// smaller size will often beat an older larger one — the notes say what each
// is for, and the console lets you install any tag you like.
const need = (gb: number): number => Math.round(gb * 1.2e9 + 1.5e9);

export const MODELS: ModelChoice[] = [
  {
    name: 'qwen3.5:2b', current: true, sizeBytes: 2.74e9, needsBytes: need(2.74), params: '2B', contextTokens: 262144,
    note: 'Runs anywhere, including with no GPU at all. Good for tidying up text you already wrote; do not expect it to draft unsupervised.',
  },
  {
    name: 'qwen3.5:4b', current: true, sizeBytes: 3.39e9, needsBytes: need(3.39), params: '4B', contextTokens: 262144,
    note: 'The smallest that writes a whole email without wandering. Comfortable on a 6–8 GB card.',
  },
  {
    name: 'qwen3.5:9b', current: true, sizeBytes: 6.59e9, needsBytes: need(6.59), params: '9B', contextTokens: 262144,
    note: 'The sensible floor for drafts you would send after a glance rather than a rewrite, and the sweet spot on a 12–16 GB card. The long context means a whole thread fits without being trimmed.',
  },
  {
    name: 'gemma3:12b', sizeBytes: 8.15e9, needsBytes: need(8.15), params: '12B', contextTokens: null,
    note: 'A step up in size for a 16 GB card, if you prefer Gemma’s register to Qwen’s.',
  },
  {
    name: 'phi4:14b', sizeBytes: 9.05e9, needsBytes: need(9.05), params: '14B', contextTokens: 16384,
    note: 'Strong at following an instruction exactly, which suits rewriting and shortening. Its 16k context is much shorter than Qwen’s, so very long threads get trimmed.',
  },
  {
    name: 'qwen3:14b', sizeBytes: 9.28e9, needsBytes: need(9.28), params: '14B', contextTokens: null,
    note: 'The previous Qwen generation at 14B. Worth trying against qwen3.5:9b on your own mail — bigger and older is not automatically better.',
  },
  {
    name: 'mistral-small:24b', sizeBytes: 14.33e9, needsBytes: need(14.33), params: '24B', contextTokens: 32768,
    note: 'Wants a 24 GB card. Too tight on 16 GB: the weights alone leave nothing for context.',
  },
  {
    name: 'qwen3.5:27b', current: true, sizeBytes: 17.42e9, needsBytes: need(17.42), params: '27B', contextTokens: 262144,
    note: 'For a 24–32 GB card. The point at which drafts often need no edit at all.',
  },
  {
    name: 'qwen3:32b', sizeBytes: 20.20e9, needsBytes: need(20.20), params: '32B', contextTokens: null,
    note: 'A 32 GB card, or two smaller ones. The previous generation at this size — compare it against qwen3.5:27b before committing the disk space.',
  },
  {
    name: 'llama3.3:70b', sizeBytes: 42.52e9, needsBytes: need(42.52), params: '70B', contextTokens: 131072,
    note: 'Two big cards or a very large machine. Diminishing returns for email specifically.',
  },
];

export const EMBED_MODELS: ModelChoice[] = [
  {
    name: 'all-minilm', sizeBytes: 0.05e9, needsBytes: 0.3e9, params: '23M', contextTokens: 512,
    note: 'Tern’s default for meaning search. Tiny, and loads beside the writing model without competing for room.',
  },
  {
    name: 'nomic-embed-text', sizeBytes: 0.27e9, needsBytes: 0.6e9, params: '137M', contextTokens: 8192,
    note: 'Better search quality and a much longer input window, so a whole message embeds as one vector.',
  },
  {
    name: 'embeddinggemma', sizeBytes: 0.62e9, needsBytes: 1.1e9, params: '300M', contextTokens: 2048,
    note: 'Larger again. Worth it only if you search a big mailbox and find the others imprecise.',
  },
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
  // Largest of the current generation that fits; only if none of those fit
  // does it fall back to the largest of anything.
  const recommended = fits.find((m) => m.current) ?? fits[0] ?? MODELS[0]!;

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
