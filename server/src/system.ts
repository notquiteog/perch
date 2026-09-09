// Sizing: what this machine can actually run, and which language model it
// should run.
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
   * would do better — which is how a catalogue quietly goes stale while
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

// Ordered smallest first; the recommendation relies on that.
//
// A note on the nested Gemma builds, because file size misleads here. `e2b`
// and `e4b` are MatFormer models: the file holds the whole thing but only the
// stated fraction activates per token. gemma4:e4b is a 9.6 GB file with about
// 4B parameters doing the work, while gemma4:12b is a true 12B in a *smaller*
// 7.6 GB file. Picking by size would take the worse model, so the nested ones
// are listed and installable but never marked current.
export const MODELS: ModelChoice[] = [
  {
    name: 'qwen3.5:2b', current: true, sizeBytes: 2.74e9, needsBytes: need(2.74), params: '2B', contextTokens: 262144,
    note: 'Runs anywhere, including with no GPU. Shipped at Q8 rather than Q4, so it is larger than its parameter count suggests and correspondingly less lossy. Good for tidying text you wrote; not for drafting unsupervised.',
  },
  {
    name: 'qwen3.5:4b', current: true, sizeBytes: 3.39e9, needsBytes: need(3.39), params: '4B', contextTokens: 262144,
    note: 'The smallest that writes a whole message or summary without wandering off. Comfortable on a 6–8 GB card.',
  },
  {
    name: 'qwen3.5:9b', current: true, sizeBytes: 6.59e9, needsBytes: need(6.59), params: '9B', contextTokens: 262144,
    note: 'The sensible floor for work you would use after a glance rather than a rewrite. Its 262k context means a long document or thread fits without being trimmed, which is worth more than another couple of billion parameters for anything that reads before it writes.',
  },
  {
    name: 'gemma4:e2b', sizeBytes: 7.16e9, needsBytes: need(7.16), params: '2B effective', contextTokens: null,
    note: 'A nested build: the file holds the whole model but only about 2B parameters activate, so it generates at 2B speed while occupying 7 GB. Fast, not memory-light — pick it for tokens per second, not to save room.',
  },
  {
    name: 'gemma4:12b', current: true, sizeBytes: 7.56e9, needsBytes: need(7.56), params: '12B', contextTokens: null,
    note: 'The best value on a 12–16 GB card: a true 12B in a smaller file than gemma4:e4b, which is only 4B effective. Newest Gemma generation.',
  },
  {
    name: 'gemma4:e4b', sizeBytes: 9.61e9, needsBytes: need(9.61), params: '4B effective', contextTokens: null,
    note: 'The other nested build, and what a bare `gemma4` pull gives you. About 4B parameters activate out of a 9.6 GB file: quick, but gemma4:12b is a true 12B in a smaller file and will write better. Worth it only if speed matters more than quality.',
  },
  {
    name: 'qwen3.5:27b', sizeBytes: 17.42e9, needsBytes: need(17.42), params: '27B', contextTokens: 262144,
    note: 'For a 24–32 GB card. The previous generation at this size — compare it against qwen3.8:27b before committing the disk space.',
  },
  {
    name: 'qwen3.8:27b', current: true, sizeBytes: 17.74e9, needsBytes: need(17.74), params: '27B', contextTokens: null,
    note: 'The newest Qwen. It ships only at 27b, so this generation has no smaller version to fall back to: under 24 GB, qwen3.5:9b is still the current-generation answer.',
  },
  {
    name: 'gemma4:26b', sizeBytes: 18.60e9, needsBytes: need(18.60), params: '26B, 4B active', contextTokens: null,
    note: 'Mixture of experts: 26B stored, about 4B active per token. Fast for its size, and still wants the memory of the full 26B.',
  },
  {
    name: 'gemma4:31b', current: true, sizeBytes: 19.87e9, needsBytes: need(19.87), params: '31B', contextTokens: null,
    note: 'A 32 GB card. The largest dense Gemma of this generation.',
  },
  {
    name: 'qwen3.5:35b-a3b', sizeBytes: 23.87e9, needsBytes: need(23.87), params: '35B, 3B active', contextTokens: 262144,
    note: 'Mixture of experts: 35B stored, 3B active. Generates quickly for its size but needs the memory of the whole thing.',
  },
];

// Uncensored ("abliterated") variants: the refusal direction is ablated out of
// the weights, so the model does not decline. Local drafting is where that
// earns its place — a stock model refusing to help with a firm complaint, a
// debt letter or a frank performance review is a common and genuinely
// annoying failure, and the refusal protects nobody when the work is yours and
// the machine is yours.
//
// Two things worth knowing. Ablation is not free: it can soften
// instruction-following and make a model slightly likelier to invent detail,
// so compare against the stock model on your own work rather than assuming an
// upgrade. And anywhere the output goes out without a person reading it first,
// the model's own refusals were the last thing between an odd prompt and an odd
// sent message — worth keeping a human in that loop at first.
//
// Never auto-recommended: these are listed, sized and installable, and picking
// one is a decision rather than a default.
export const UNCENSORED_MODELS: ModelChoice[] = [
  {
    name: 'huihui_ai/qwen3.5-abliterated:4b', sizeBytes: 3.32e9, needsBytes: need(3.32), params: '4B', contextTokens: 262144,
    note: 'Uncensored qwen3.5:4b, and marginally smaller than the stock build. A 6–8 GB card.',
  },
  {
    name: 'huihui_ai/qwen3.5-abliterated:9b', sizeBytes: 6.59e9, needsBytes: need(6.59), params: '9B', contextTokens: 262144,
    note: 'Identical in size and quantisation to stock qwen3.5:9b. The lightest of these on a 16 GB card, leaving the most room for a long context and the fastest generation.',
  },
  {
    name: 'huihui_ai/gemma-4-abliterated:12b', sizeBytes: 7.56e9, needsBytes: need(7.56), params: '12B', contextTokens: null,
    note: 'Uncensored gemma4:12b — a true 12B, newest generation, and the best quality-per-gigabyte here on a 16 GB card.',
  },
  {
    name: 'huihui_ai/qwen3-abliterated:14b', sizeBytes: 9.00e9, needsBytes: need(9.00), params: '14B', contextTokens: null,
    note: 'The largest true parameter count that fits a 16 GB card with real headroom left for context. Previous-generation Qwen, so worth timing against the 9b and the gemma4 12b rather than assuming the biggest wins.',
  },
  {
    name: 'huihui_ai/gemma-4-abliterated:e4b', sizeBytes: 9.61e9, needsBytes: need(9.61), params: '4B effective', contextTokens: null,
    note: 'Uncensored gemma4:e4b. Nested, so about 4B parameters activate out of a 9.6 GB file: very fast to generate, but the 12b above is a true 12B in a smaller file.',
  },
  {
    name: 'huihui_ai/mistral-small-abliterated:24b', sizeBytes: 14.33e9, needsBytes: need(14.33), params: '24B', contextTokens: 32768,
    note: 'The stretch option on 16 GB. The weights alone are 14.3 GB of a 16 GB card, so almost nothing is left for context and part of it will spill to system memory. Comfortable only on 24 GB.',
  },
  {
    name: 'huihui_ai/qwen3.5-abliterated:27b', sizeBytes: 17.42e9, needsBytes: need(17.42), params: '27B', contextTokens: 262144,
    note: 'Uncensored qwen3.5:27b, for a 24–32 GB card.',
  },
];

export const EMBED_MODELS: ModelChoice[] = [
  {
    name: 'all-minilm', sizeBytes: 0.05e9, needsBytes: 0.3e9, params: '23M', contextTokens: 512,
    note: 'The usual default, and Tern\u2019s. Tiny, and loads beside a language model without competing for room.',
  },
  {
    name: 'nomic-embed-text', sizeBytes: 0.27e9, needsBytes: 0.6e9, params: '137M', contextTokens: 8192,
    note: 'Better search quality and a much longer input window, so a whole message or page embeds as one vector.',
  },
  {
    name: 'embeddinggemma', sizeBytes: 0.62e9, needsBytes: 1.1e9, params: '300M', contextTokens: 2048,
    note: 'Larger again. Worth it only if you search a large collection and find the others imprecise.',
  },
  // The two Qwen3 embedders — a different class from the three above. Those
  // fit in a corner of a VPS; these want the card. Worth having here because
  // perch IS the machine with the card, and this is the list a client points
  // at when it wants an embedder better than a hosted one.
  //
  // Vector width matters more than the download for these, and neither is
  // reported by any listing: the 4B answers 2560 numbers per vector and the 8B
  // answers 4096, against 384 for all-minilm. Whatever stores them pays that
  // multiple on every row, so it is a decision about somebody else's disk as
  // well as about this card.
  {
    name: 'qwen3-embedding:4b', sizeBytes: 2.5e9, needsBytes: 3.4e9, params: '4B', contextTokens: 32768,
    note: 'Strong multilingual retrieval, 2560-wide vectors, and a 32k input window so a long document embeds whole. Wants the GPU; on CPU a first index pass over a real collection is an overnight job.',
  },
  {
    name: 'qwen3-embedding:8b', sizeBytes: 4.7e9, needsBytes: 6.2e9, params: '8B', contextTokens: 32768,
    note: 'The best open-weight retrieval model here and the widest at 4096. Only worth it with room on the card beside whatever language model is loaded.',
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
