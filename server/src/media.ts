// The generation models: images, video and audio.
//
// These are not Ollama models, and the difference decides the whole shape of
// this file. Ollama has an API for its models — list, pull, delete, progress
// — so the console can offer buttons. A diffusion server has none of that. It
// reads whatever weight files happen to be in a directory when it starts, and
// there is no HTTP call that will put one there.
//
// So this is a catalogue rather than a manager. For each model it knows:
//
//   - the exact files, their URLs and their real sizes, checked against the
//     registry rather than remembered;
//   - which container runs it, because an image checkpoint and a Kokoro voice
//     are not interchangeable and do not live in the same volume;
//   - what it wants on the card while it works, which is the number that
//     decides whether it fits beside a language model.
//
// Whether a model is *installed* is asked of the backend, not tracked here:
// every one of these servers will list what it can see, and a list perch kept
// itself would be wrong the first time somebody copied a file in by hand.
//
// Downloading is `./bin/perch fetch <id>`, which reads this catalogue over the
// console API and writes into the container's volume. perch does not do it
// itself for the same reason it does not run podman: the console container has
// no business writing into another container's storage.
import { config } from './config.js';
import type { ServiceId } from './services.js';
import { logger } from './log.js';

const log = logger('media');

export type MediaFamily = 'image' | 'video' | 'audio';

export interface MediaFile {
  url: string;
  /** Where it belongs, relative to that container's model directory. */
  dest: string;
  bytes: number;
}

export interface MediaModel {
  /** What `./bin/perch fetch` takes. */
  id: string;
  name: string;
  family: MediaFamily;
  /** The service whose container runs it, and whose volume the files go in. */
  service: ServiceId;
  params: string;
  /** The download, summed across every file it needs. */
  sizeBytes: number;
  /** Roughly what it occupies while generating. */
  needsBytes: number;
  /** Ships inside the container image, so there is nothing to fetch. */
  bundled?: boolean;
  files: MediaFile[];
  note: string;
}

export interface ModelStore {
  /** The compose volume, as named in the overlay's `volumes:` block. */
  volume: string;
  /** Where the model directories start inside it, if not at the root. */
  subdir: string;
}

/**
 * Where each backend keeps its weights.
 *
 * `./bin/perch fetch` resolves the volume to a path on the host and writes
 * under it. podman-compose prefixes volume names with the project, which the
 * script handles.
 *
 * ComfyUI's image keeps everything under /root — itself, its models, its
 * outputs — so the volume is that whole directory and the models are a few
 * levels in. It copies its bundled ComfyUI in without overwriting, so files
 * fetched before its first start survive it.
 */
export const MODEL_VOLUMES: Partial<Record<ServiceId, ModelStore>> = {
  video: { volume: 'perch-comfy', subdir: 'ComfyUI/models' },
};

const hf = (repo: string, path: string): string => `https://huggingface.co/${repo}/resolve/main/${path}`;

// Every URL below was fetched to check that it resolves and to read its real
// size, and `sizeBytes` is the sum of those. That check is worth repeating
// whenever this list is edited: a catalogue of plausible files that 404 is
// worse than no catalogue, because it fails after a 7 GB wait rather than at
// the suggestion.
//
// Ordered smallest first within each family, because that is the order
// somebody with one card reads them in.
export const MEDIA_MODELS: MediaModel[] = [
  // ---------- images: every one of these is a ComfyUI checkpoint ----------
  //
  // The SD 1.5 and SDXL entries below used to run in a Stable Diffusion web UI
  // container of their own, which is why they are still described in that
  // family's terms. ComfyUI loads the same checkpoint files unchanged — the
  // only thing that moved when that container went away is the directory they
  // belong in, `checkpoints/` rather than `Stable-diffusion/`.
  {
    id: 'dreamshaper-8',
    name: 'DreamShaper 8',
    family: 'image',
    service: 'video',
    params: 'SD 1.5',
    sizeBytes: 2.13e9,
    needsBytes: 4e9,
    files: [{ url: hf('Lykon/DreamShaper', 'DreamShaper_8_pruned.safetensors'), dest: 'checkpoints/DreamShaper_8_pruned.safetensors', bytes: 2.13e9 }],
    note: 'The small one that still looks good. An SD 1.5 fine-tune, so it generates in seconds on a modest card and leaves most of it free — the sensible first checkpoint on a box that is mainly doing something else.',
  },
  {
    id: 'sd15',
    name: 'Stable Diffusion 1.5',
    family: 'image',
    service: 'video',
    params: 'SD 1.5',
    sizeBytes: 4.27e9,
    needsBytes: 4e9,
    files: [{ url: hf('stable-diffusion-v1-5/stable-diffusion-v1-5', 'v1-5-pruned-emaonly.safetensors'), dest: 'checkpoints/v1-5-pruned-emaonly.safetensors', bytes: 4.27e9 }],
    note: 'The base model everything else in this family was trained from. Worth having as a reference; a fine-tune of it will almost always look better.',
  },
  {
    id: 'sdxl-turbo',
    name: 'SDXL Turbo',
    family: 'image',
    service: 'video',
    params: 'SDXL',
    sizeBytes: 6.94e9,
    needsBytes: 10e9,
    files: [{ url: hf('stabilityai/sdxl-turbo', 'sd_xl_turbo_1.0_fp16.safetensors'), dest: 'checkpoints/sd_xl_turbo_1.0_fp16.safetensors', bytes: 6.94e9 }],
    note: 'SDXL quality in one to four steps instead of thirty. The fastest thing here by a wide margin, at some cost in fine detail and prompt following.',
  },
  {
    id: 'sdxl-base',
    name: 'SDXL 1.0 base',
    family: 'image',
    service: 'video',
    params: 'SDXL',
    sizeBytes: 6.94e9,
    needsBytes: 10e9,
    files: [{ url: hf('stabilityai/stable-diffusion-xl-base-1.0', 'sd_xl_base_1.0.safetensors'), dest: 'checkpoints/sd_xl_base_1.0.safetensors', bytes: 6.94e9 }],
    note: 'Native 1024×1024 and a real step up in composition. On a card also holding a language model this is where the two stop fitting together — see the sizes on the Status page.',
  },
  {
    id: 'juggernaut-xl-v9',
    name: 'Juggernaut XL v9',
    family: 'image',
    service: 'video',
    params: 'SDXL',
    sizeBytes: 7.11e9,
    needsBytes: 10e9,
    files: [{ url: hf('RunDiffusion/Juggernaut-XL-v9', 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors'), dest: 'checkpoints/Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors', bytes: 7.11e9 }],
    note: 'An SDXL fine-tune aimed at photographic work. Better at faces and light than the base model, and the same size on the card.',
  },
  {
    id: 'flux1-schnell',
    name: 'FLUX.1 schnell',
    family: 'image',
    service: 'video',
    params: '12B',
    sizeBytes: 17.24e9,
    needsBytes: 18e9,
    files: [{ url: hf('Comfy-Org/flux1-schnell', 'flux1-schnell-fp8.safetensors'), dest: 'checkpoints/flux1-schnell-fp8.safetensors', bytes: 17.24e9 }],
    note: 'The current open image model, and much better at text in pictures than anything above. Needs a 24 GB card to be comfortable.',
  },

  // ---------- video: ComfyUI ----------
  {
    id: 'ltxv-2b',
    name: 'LTX-Video 2B distilled',
    family: 'video',
    service: 'video',
    params: '2B',
    sizeBytes: 9.35e9,
    needsBytes: 8e9,
    files: [
      { url: hf('Lightricks/LTX-Video', 'ltxv-2b-0.9.8-distilled-fp8.safetensors'), dest: 'checkpoints/ltxv-2b-0.9.8-distilled-fp8.safetensors', bytes: 4.46e9 },
      { url: hf('comfyanonymous/flux_text_encoders', 't5xxl_fp8_e4m3fn.safetensors'), dest: 'text_encoders/t5xxl_fp8_e4m3fn.safetensors', bytes: 4.89e9 },
    ],
    note: 'The one that runs on a normal card. A few seconds of 768×512 in well under a minute on a 12 GB GPU, which is what makes it worth having at all — the larger models below are minutes per clip.',
  },
  {
    id: 'svd-xt',
    name: 'Stable Video Diffusion XT',
    family: 'video',
    service: 'video',
    params: '1.5B',
    sizeBytes: 9.56e9,
    needsBytes: 14e9,
    files: [{ url: hf('stabilityai/stable-video-diffusion-img2vid-xt', 'svd_xt.safetensors'), dest: 'checkpoints/svd_xt.safetensors', bytes: 9.56e9 }],
    note: 'Image to video only: it animates a still rather than taking a prompt. One file with everything in it, which makes it the simplest thing here to get working.',
  },
  {
    id: 'wan22-ti2v-5b',
    name: 'Wan 2.2 TI2V 5B',
    family: 'video',
    service: 'video',
    params: '5B',
    sizeBytes: 18.15e9,
    needsBytes: 14e9,
    files: [
      { url: hf('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors'), dest: 'diffusion_models/wan2.2_ti2v_5B_fp16.safetensors', bytes: 10.0e9 },
      { url: hf('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/vae/wan2.2_vae.safetensors'), dest: 'vae/wan2.2_vae.safetensors', bytes: 1.41e9 },
      { url: hf('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'), dest: 'text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', bytes: 6.74e9 },
    ],
    note: 'Text or image to video, and the best quality that fits a 16 GB card. Three files: the model, its VAE and a text encoder shared with the 14B below.',
  },
  {
    id: 'wan22-t2v-14b',
    name: 'Wan 2.2 T2V 14B',
    family: 'video',
    service: 'video',
    params: '14B ×2',
    sizeBytes: 35.57e9,
    needsBytes: 30e9,
    files: [
      { url: hf('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors'), dest: 'diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors', bytes: 14.29e9 },
      { url: hf('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors'), dest: 'diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors', bytes: 14.29e9 },
      { url: hf('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'), dest: 'text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', bytes: 6.74e9 },
      { url: hf('Comfy-Org/Wan_2.2_ComfyUI_Repackaged', 'split_files/vae/wan_2.1_vae.safetensors'), dest: 'vae/wan_2.1_vae.safetensors', bytes: 0.25e9 },
    ],
    note: 'Two 14B experts, one for the noisy half of the schedule and one for the clean half, so both are downloaded and the workflow swaps between them. A 24 GB card at minimum, and minutes per clip.',
  },

  // ---------- audio ----------
  {
    id: 'kokoro-82m',
    name: 'Kokoro 82M',
    family: 'audio',
    service: 'audio',
    params: '82M',
    sizeBytes: 0.35e9,
    needsBytes: 1.5e9,
    bundled: true,
    files: [],
    note: 'The voices the audio service speaks with, built into its container image — there is nothing to download. Small enough to run on the CPU at faster than real time, which is usually the right place for it.',
  },
  {
    id: 'ace-step-3.5b',
    name: 'ACE-Step v1 3.5B',
    family: 'audio',
    service: 'video',
    params: '3.5B',
    sizeBytes: 7.7e9,
    needsBytes: 10e9,
    files: [{ url: hf('Comfy-Org/ACE-Step_ComfyUI_repackaged', 'all_in_one/ace_step_v1_3.5b.safetensors'), dest: 'checkpoints/ace_step_v1_3.5b.safetensors', bytes: 7.7e9 }],
    note: 'Music from a prompt — a minute of song in a few seconds on a good card.',
  },
];

export function mediaModel(id: string): MediaModel | undefined {
  return MEDIA_MODELS.find((m) => m.id === id);
}

/** What to run to put a model on this machine. */
export function fetchCommand(m: MediaModel): string | null {
  return m.bundled ? null : `sudo ./bin/perch fetch ${m.id}`;
}

// ---------- what each backend can actually see ----------

export interface MediaServiceStatus {
  id: ServiceId;
  /** Switched on for this machine at all. */
  enabled: boolean;
  url: string;
  /** Answering right now. */
  ok: boolean;
  /**
   * The port is refused rather than answering. On these containers a first
   * start is minutes of unpacking a multi-gigabyte image, so this is far more
   * often "still starting" than "broken" — and saying so beats a red badge on
   * a container doing exactly what it should.
   */
  starting: boolean;
  error?: string;
  /**
   * The weight files the backend reports, by filename. Asked of it rather
   * than remembered, so a file copied in by hand shows up too.
   */
  installed: string[];
  at: string;
}

function enabled(id: ServiceId): boolean {
  return config.enabledServices.split(',').map((x) => x.trim()).includes(id);
}

async function get(url: string, timeoutMs = 5000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

async function jsonOrNull<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await get(url, timeoutMs);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * A refused connection, told apart from a server that answered badly.
 *
 * Shared with voice.ts's reasoning, and for the same reason: these containers
 * hold their port closed while they set themselves up, so the only difference
 * between "starting" and "dead" is the shape of the error.
 */
function looksLikeStarting(message: string): boolean {
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH/i.test(message)) return true;
  if (/^fetch failed$/i.test(message.trim())) return true;
  return /timed? ?out|abort/i.test(message);
}

/**
 * ComfyUI keeps weights in one directory per kind, and a model here may put
 * files in three of them, so every directory a catalogue entry mentions is
 * listed. `/models/<kind>` is the cheap call for this; `/object_info` would
 * also answer it and is megabytes of JSON.
 */
async function comfyInstalled(): Promise<string[]> {
  const kinds = new Set<string>();
  for (const m of MEDIA_MODELS) {
    if (m.service !== 'video') continue;
    for (const f of m.files) kinds.add(f.dest.split('/')[0]!);
  }
  const found: string[] = [];
  for (const kind of kinds) {
    const list = await jsonOrNull<string[]>(`${config.comfyUrl}/models/${kind}`);
    for (const name of list ?? []) found.push(String(name).split('/').pop()!);
  }
  return found;
}

/** Kokoro carries its weights in the image, so its voices are the evidence. */
async function audioInstalled(): Promise<string[]> {
  const r = await jsonOrNull<{ voices?: string[] }>(`${config.ttsUrl}/v1/audio/voices`);
  return r?.voices ?? [];
}

const PROBE: Record<string, { path: string; installed: () => Promise<string[]> }> = {
  video: { path: '/system_stats', installed: comfyInstalled },
  audio: { path: '/health', installed: audioInstalled },
};

const UPSTREAM: Record<string, string> = {
  video: config.comfyUrl,
  audio: config.ttsUrl,
};

export async function mediaStatus(id: 'video' | 'audio'): Promise<MediaServiceStatus> {
  const url = UPSTREAM[id]!;
  const base = { id: id as ServiceId, enabled: enabled(id), url, installed: [] as string[], at: new Date().toISOString() };
  if (!base.enabled) return { ...base, ok: false, starting: false, error: `${id} is not switched on for this machine` };
  try {
    // Any answer below 500 counts as listening: a 404 from a server that is
    // up still means the address is right.
    const res = await get(`${url}${PROBE[id]!.path}`);
    if (res.status >= 500) return { ...base, ok: false, starting: false, error: `HTTP ${res.status}` };
    const installed = await PROBE[id]!.installed().catch((e: Error) => {
      log.warn(`could not list ${id} models`, e.message);
      return [];
    });
    return { ...base, ok: true, starting: false, installed };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    return { ...base, ok: false, starting: looksLikeStarting(message), error: message };
  }
}

export interface MediaOverview {
  models: MediaModel[];
  services: MediaServiceStatus[];
  at: string;
}

/**
 * The whole picture for the Models page: the catalogue, and what each backend
 * says it has. Both probes run together — one of them being slow should not
 * hold up the other.
 */
export async function mediaOverview(): Promise<MediaOverview> {
  const services = await Promise.all((['video', 'audio'] as const).map((id) => mediaStatus(id)));
  return { models: MEDIA_MODELS, services, at: new Date().toISOString() };
}

/** Whether every file a model needs is where its backend can see it. */
export function isInstalled(m: MediaModel, status: MediaServiceStatus | undefined): boolean {
  if (!status?.ok) return false;
  if (m.bundled) return true;
  if (m.files.length === 0) return false;
  const have = new Set(status.installed);
  return m.files.every((f) => have.has(f.dest.split('/').pop()!));
}
