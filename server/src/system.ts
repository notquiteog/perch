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
  /**
   * Meets the floor the clients' AI features are built and tested against —
   * see FLOOR_CHAT and FLOOR_EMBED below. Not a quality score and not a
   * capacity check: `needsBytes` already says whether a model fits. This says
   * whether the features on the other end of the tunnel can rely on it.
   *
   * Unrelated to `floorBytes` in containers.ts, which is a memory limit.
   */
  floor?: boolean;
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

// ---------- The floor ----------
//
// perch is a model host, so it does not have AI features of its own to size.
// What it has is clients — Tern, cryptostore, roost — whose features ARE built
// and tested against a stated minimum, and this is where that minimum is
// written down, because this is the machine that decides which models exist.
//
// **Chat: qwen3.5:9b or gemma4:12b. Embedding: qwen3-embedding:4b.**
//
// The distinction that makes this worth encoding rather than leaving to a
// docs paragraph: below the floor, features do not get slower, they silently
// stop working. A model without a usable `tools` capability answers questions
// perfectly and never calls the tool that sets the alert, files the draft or
// writes the entry — with no error anywhere for the operator to find. A 768-
// wide embedding retrieves worse on exactly the paraphrases meaning search
// exists to catch. Neither failure shows up as a failure.
//
// **It is a warning, never a wall.** Every model in this catalogue stays
// listed, sized and installable, and `pick_model` in install.sh goes all the
// way down. Somebody who wants qwen3:1.7b on a 4 GB box to see how far it gets
// is making a decision that belongs to them; perch's job is to make sure it is
// an informed one. What the floor governs is what a FEATURE may assume, not
// what an operator may install.
//
// The other end is a first-class target too, and it is not this file's
// business: a client pointed at a frontier model with thinking enabled should
// get more out of the same features, which is why perch will front a hosted
// API (PERCH_CHAT_UPSTREAM_API) rather than only a local Ollama. See README,
// "What this is built for".
//
// When the floor moves it moves here, in `pick_model` in install.sh, and in
// docs/TERN.md — all three, or perch is recommending something the clients are
// not tested against.
export const FLOOR_CHAT = ['qwen3.5:9b', 'gemma4:12b'] as const;
export const FLOOR_EMBED = 'qwen3-embedding:4b';

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
    note: 'Runs anywhere, including with no GPU. Shipped at Q8 rather than Q4, so it is larger than its parameter count suggests and correspondingly less lossy. Good for tidying text you wrote; not for drafting unsupervised, and well below the floor for anything that calls tools.',
  },
  {
    name: 'qwen3.5:4b', current: true, sizeBytes: 3.39e9, needsBytes: need(3.39), params: '4B', contextTokens: 262144,
    note: 'The smallest that writes a whole message or summary without wandering off. Comfortable on a 6–8 GB card. Below the floor: fine for drafting and rewriting, but a client that expects it to call tools will find the feature quietly doing nothing.',
  },
  {
    name: 'qwen3.5:9b', current: true, floor: true, sizeBytes: 6.59e9, needsBytes: need(6.59), params: '9B', contextTokens: 262144,
    note: 'The floor, and the smaller of the two that meet it. Work you would use after a glance rather than a rewrite, and reliable enough at calling tools that a client can build a feature on it. Its 262k context means a long document or thread fits without being trimmed, which is worth more than another couple of billion parameters for anything that reads before it writes.',
  },
  {
    name: 'gemma4:e2b', sizeBytes: 7.16e9, needsBytes: need(7.16), params: '2B effective', contextTokens: null,
    note: 'A nested build: the file holds the whole model but only about 2B parameters activate, so it generates at 2B speed while occupying 7 GB. Fast, not memory-light — pick it for tokens per second, not to save room.',
  },
  {
    name: 'gemma4:12b', current: true, floor: true, sizeBytes: 7.56e9, needsBytes: need(7.56), params: '12B', contextTokens: null,
    note: 'The other model that meets the floor, and the best value on a 12–16 GB card: a true 12B in a smaller file than gemma4:e4b, which is only 4B effective. Newest Gemma generation.',
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
    note: 'The small-box option. Tiny, and loads beside a language model without competing for room \u2014 but 384 wide and a 512-token window, so only the opening of a long document reaches the vector. Well below the floor: still selectable, no longer what anything defaults to.',
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
    name: 'qwen3-embedding:4b', floor: true, sizeBytes: 2.5e9, needsBytes: 3.4e9, params: '4B', contextTokens: 32768,
    note: 'The floor, and what a client\u2019s meaning search is built and tested against. Strong multilingual retrieval, 2560-wide vectors, and a 32k input window so a long document embeds whole. Wants the GPU; on CPU a first index pass over a real collection is an overnight job.',
  },
  {
    name: 'qwen3-embedding:8b', sizeBytes: 4.7e9, needsBytes: 6.2e9, params: '8B', contextTokens: 32768,
    note: 'The best open-weight retrieval model here and the widest at 4096. Only worth it with room on the card beside whatever language model is loaded.',
  },
];

/**
 * The memory a machine needs before a floor model will run on it: the smaller
 * of the two, plus the room `need()` already accounts for. Derived rather than
 * typed in, so it cannot drift from the catalogue it describes.
 */
export const FLOOR_BYTES = Math.min(
  ...MODELS.filter((m) => m.floor).map((m) => m.needsBytes),
);

export interface Sizing {
  /** What the recommendation was made from. */
  basis: 'vram' | 'ram';
  usableBytes: number;
  recommended: ModelChoice;
  /**
   * The embedding model to run beside it. A second, separate claim on the same
   * memory — it loads *as well as* the language model, not instead of it — so
   * it is sized against what is left rather than against the whole card.
   */
  recommendedEmbed: ModelChoice;
  /** Everything this machine can run, largest first. */
  fits: ModelChoice[];
  /**
   * This machine cannot run either floor model, so a client pointed at it will
   * have features that silently do not work. Reported, never enforced: perch
   * still installs whatever is asked for. See FLOOR_CHAT.
   */
  belowFloor: boolean;
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

  // The embedding model competes with the language model for the same memory,
  // so it is sized from the headroom and not from the card. Largest that fits
  // beside it, preferring the floor model; the smallest in the catalogue if
  // nothing does, because meaning search with a weak embedder still beats a
  // client falling back to substring matching.
  const embedFits = EMBED_MODELS.filter((m) => m.needsBytes <= headroom);
  const recommendedEmbed =
    embedFits.find((m) => m.floor) ?? embedFits[embedFits.length - 1] ?? EMBED_MODELS[0]!;

  return {
    basis,
    usableBytes,
    recommended,
    recommendedEmbed,
    fits,
    belowFloor: usableBytes < FLOOR_BYTES,
    numCtx,
  };
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
