// The OpenAI images shape, spoken by the video service.
//
// perch used to answer image generation with a container of its own: Stable
// Diffusion's web UI behind its A1111 API, on its own port, with its own
// overlay. That is gone, and this file is what replaced it. The trade is worth
// writing down, because "a service was removed" reads as a loss unless what
// was bought with it is stated:
//
//   - That container resolved its Python dependencies at runtime, from the
//     live package index, on every start. It could not be pinned — an image
//     digest fixes the layers, not what pip resolves inside them — and it
//     stopped working one morning because a build dependency three levels
//     down dropped a module, with nothing on this machine having changed.
//   - ComfyUI was already running and already carried the newer image models.
//     perch's own catalogue put FLUX on it, because Stable Diffusion's web UI
//     cannot load one. Two containers were holding two halves of one job.
//   - What the A1111 API actually gave a caller was txt2img and img2img.
//     ComfyUI gives a graph runner: strictly more capable, and much less
//     pleasant to call — `POST /prompt` wants a whole node graph, and then
//     the answer has to be collected from two more endpoints.
//
// So the endpoint a client wants is neither of those. It is the OpenAI images
// shape, which most clients are already written against, and this file is the
// distance between that one call and ComfyUI's three.
//
// ── The same cost anthropic.ts pays, and the same bound on it ──────────────
//
// proxy.ts opens with "it is a pipe, not a parser", and a translator cannot
// keep that promise: it has to read the request to build a graph out of it.
// What is bounded here:
//
//   - Two paths reach this code. Everything else on the video service is
//     still piped, and the other services never touch it.
//   - The request body is read with a hard ceiling and discarded when the
//     response ends. Nothing is written anywhere and nothing is logged; the
//     activity ring records the path and the byte count, never the prompt.
//   - The image comes back through perch's memory once, because the caller
//     asked for base64. It is not written to disk here, and the copy ComfyUI
//     made is a temp file — see `PREVIEW_NODE` for why that matters.
//
// Unlike the Anthropic translator there is nothing to stream: a diffusion
// model produces one image at the end, not tokens along the way, so the
// response is a single JSON body and the waiting happens against ComfyUI's
// history rather than on an open pipe.
import http from 'node:http';
import { config } from './config.js';
import { logger } from './log.js';
import { requestUpstream } from './upstream.js';

const log = logger('images');

type Block = Record<string, any>;

// ── What the graph is made of ──────────────────────────────────────────────

/**
 * The output node, and the one place this file makes a choice a caller cannot
 * see.
 *
 * `SaveImage` writes into ComfyUI's output directory and leaves the file
 * there forever. That is right for somebody working in ComfyUI's own UI, who
 * wants their pictures afterwards, and wrong for an API endpoint: the caller
 * is handed the bytes in the response, so a second copy accumulating in a
 * volume nobody prunes is a disk that fills up quietly over months.
 *
 * `PreviewImage` is the same node with a different destination — it subclasses
 * `SaveImage` and changes only the directory, the type and the filename
 * prefix — so it lands in `/history` identically and is fetched from `/view`
 * identically, but writes into the temp directory instead.
 */
const PREVIEW_NODE = 'PreviewImage';

/** `/view` needs the type back, and for `PreviewImage` it is always this. */
const PREVIEW_TYPE = 'temp';

/**
 * Node ids for the graph below.
 *
 * ComfyUI keys nodes by string and links them as `[nodeId, outputIndex]`, so
 * these are the graph's wiring and not decoration. They are named rather than
 * numbered inline because a mistyped link in a literal produces a graph that
 * validates and then renders the wrong thing.
 */
const NODE = {
  checkpoint: '1',
  positive: '2',
  negative: '3',
  latent: '4',
  sampler: '5',
  decode: '6',
  output: '7',
} as const;

/**
 * `CheckpointLoaderSimple` returns MODEL, CLIP and VAE in that order, so these
 * are the output indices the links below use. Read from the live
 * `/object_info` rather than assumed; if a future ComfyUI reorders them this
 * is the constant that is wrong.
 */
const CKPT_OUT = { model: 0, clip: 1, vae: 2 } as const;

export interface WorkflowOptions {
  ckptName: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  batchSize: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
}

/**
 * One text-to-image graph, in the form `POST /prompt` takes.
 *
 * This is the smallest graph that produces a picture from a checkpoint, and
 * deliberately so: every node here is a built-in, so the graph runs on a
 * stock ComfyUI with no custom nodes installed. Anything fancier — LoRAs,
 * upscalers, ControlNet — is a graph the caller can queue themselves through
 * the service's own `/prompt`, which is still piped and still there.
 */
export function toWorkflow(o: WorkflowOptions): Block {
  return {
    [NODE.checkpoint]: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: o.ckptName },
    },
    [NODE.positive]: {
      class_type: 'CLIPTextEncode',
      inputs: { text: o.prompt, clip: [NODE.checkpoint, CKPT_OUT.clip] },
    },
    [NODE.negative]: {
      class_type: 'CLIPTextEncode',
      inputs: { text: o.negativePrompt, clip: [NODE.checkpoint, CKPT_OUT.clip] },
    },
    [NODE.latent]: {
      class_type: 'EmptyLatentImage',
      inputs: { width: o.width, height: o.height, batch_size: o.batchSize },
    },
    [NODE.sampler]: {
      class_type: 'KSampler',
      inputs: {
        seed: o.seed,
        steps: o.steps,
        cfg: o.cfg,
        sampler_name: o.sampler,
        scheduler: o.scheduler,
        denoise: 1.0,
        model: [NODE.checkpoint, CKPT_OUT.model],
        positive: [NODE.positive, 0],
        negative: [NODE.negative, 0],
        latent_image: [NODE.latent, 0],
      },
    },
    [NODE.decode]: {
      class_type: 'VAEDecode',
      inputs: { samples: [NODE.sampler, 0], vae: [NODE.checkpoint, CKPT_OUT.vae] },
    },
    [NODE.output]: {
      class_type: PREVIEW_NODE,
      inputs: { images: [NODE.decode, 0] },
    },
  };
}

// ── Reading the request ────────────────────────────────────────────────────

/**
 * OpenAI's default, kept even though it is the wrong size for half the
 * catalogue.
 *
 * An SD 1.5 checkpoint was trained at 512×512 and produces duplicated limbs
 * and doubled horizons above about 768; SDXL and FLUX want 1024 and look soft
 * below it. There is no default that is right for both, so the choice is
 * between guessing from the checkpoint's filename — which is a string somebody
 * can rename — and matching the API being imitated. Matching the API wins:
 * a client that sends no `size` gets what it would have got from OpenAI, and
 * docs/SERVICES.md says plainly that SD 1.5 checkpoints want `"512x512"`.
 */
const DEFAULT_SIZE = { width: 1024, height: 1024 };

/**
 * Bounds on the picture, which are bounds on the GPU.
 *
 * Latent size is quadratic in each dimension, so an unbounded `size` is a way
 * to ask one request to occupy the card for an hour. 2048 is past what any of
 * the catalogue's models were trained for and well inside what a 16 GB card
 * survives.
 */
const MIN_DIM = 64;
const MAX_DIM = 2048;

/**
 * How many pictures one request may ask for.
 *
 * OpenAI allows up to 10. A batch is one job on the card holding every latent
 * at once, so ten 1024×1024 latents is a different proposition here than it is
 * on somebody else's cluster — and the concurrency backstop in proxy.ts counts
 * requests, not images, so it would not catch this.
 */
const MAX_N = 4;

/**
 * `"1024x1024"` to a pair of numbers.
 *
 * ComfyUI's latent nodes want multiples of 8 and will not say so politely —
 * a width of 513 fails somewhere inside the VAE with a shape mismatch — so
 * this rounds rather than refusing, and refuses only what is outside the
 * bounds entirely.
 */
export function parseSize(size: unknown): { width: number; height: number } | { error: string } {
  if (size === undefined || size === null || size === 'auto') return { ...DEFAULT_SIZE };
  if (typeof size !== 'string') return { error: 'size must be a string like "1024x1024"' };
  const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(size.trim());
  if (!m) return { error: `size must look like "1024x1024", not ${JSON.stringify(size)}` };
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < MIN_DIM || height < MIN_DIM || width > MAX_DIM || height > MAX_DIM) {
    return { error: `size must be between ${MIN_DIM} and ${MAX_DIM} in each direction` };
  }
  // Down to the multiple of 8, never up: rounding up can cross MAX_DIM, and a
  // caller who asked for the maximum should not be given more than it.
  return { width: Math.floor(width / 8) * 8, height: Math.floor(height / 8) * 8 };
}

/** A number from the request, clamped, with the default when it is absent or unreadable. */
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The checkpoint this request should load, out of what ComfyUI can see.
 *
 * OpenAI's `model` is a bare name and ComfyUI's is a filename, sometimes in a
 * subdirectory, so an exact match is the exception rather than the rule.
 * Matching loosely is worth the ambiguity: a caller writing
 * `model: "dreamshaper"` against a file called
 * `DreamShaper_8_pruned.safetensors` means the obvious thing, and the
 * alternative is that every client hard-codes a filename it cannot discover
 * without reading `/object_info`.
 *
 * Ambiguity resolves to the shortest match, which is the one whose name is
 * most nearly what was asked for.
 */
export function matchCheckpoint(wanted: string | undefined, available: string[]): string | undefined {
  if (!available.length) return undefined;
  if (!wanted) return available[0];
  const want = wanted.trim().toLowerCase();
  const exact = available.find((a) => a.toLowerCase() === want);
  if (exact) return exact;
  // Without the directory and without the extension, which is how a caller
  // who has seen the name written down will usually type it.
  const bare = (s: string): string => (s.split('/').pop() ?? s).replace(/\.(safetensors|ckpt|sft)$/i, '').toLowerCase();
  const byBare = available.find((a) => bare(a) === want);
  if (byBare) return byBare;
  const partial = available.filter((a) => bare(a).includes(want) || a.toLowerCase().includes(want));
  if (!partial.length) return undefined;
  return partial.sort((a, b) => a.length - b.length)[0];
}

// ── Reading the answer ─────────────────────────────────────────────────────

export interface OutputImage { filename: string; subfolder: string; type: string }

/**
 * Every image one finished prompt produced, from ComfyUI's history entry.
 *
 * Written against `outputs` as a whole rather than against the known id of
 * the output node, because a graph is data: reading only node "7" would work
 * until the day this file grows a second shape and someone forgets to update
 * the reader. An entry with no images at all is a real outcome — a graph that
 * ran and saved nothing — and it returns empty rather than throwing, so the
 * caller of this function decides what that means.
 */
export function imagesFromHistory(history: Block, promptId: string): OutputImage[] {
  const entry = history?.[promptId];
  if (!entry) return [];
  const out: OutputImage[] = [];
  for (const node of Object.values(entry.outputs ?? {}) as Block[]) {
    for (const img of (node?.images ?? []) as Block[]) {
      if (!img?.filename) continue;
      out.push({
        filename: String(img.filename),
        subfolder: String(img.subfolder ?? ''),
        type: String(img.type ?? PREVIEW_TYPE),
      });
    }
  }
  return out;
}

/**
 * Whether a history entry is finished, and how it ended.
 *
 * ComfyUI reports completion in `status.completed`, and a prompt that failed
 * mid-graph is also "finished" — it is in history with `status_str: "error"`
 * and no outputs. Polling that only looked for images would wait out the full
 * deadline on a job that died in the first second.
 */
export function historyOutcome(history: Block, promptId: string): 'pending' | 'done' | 'failed' {
  const entry = history?.[promptId];
  if (!entry) return 'pending';
  const status = entry.status ?? {};
  if (status.status_str === 'error') return 'failed';
  if (status.completed === true) return 'done';
  // Some builds omit `completed` and only ever write the entry once the run
  // has ended, so an entry carrying outputs is finished whatever it says.
  return imagesFromHistory(history, promptId).length ? 'done' : 'pending';
}

// ── The error envelope ─────────────────────────────────────────────────────

/**
 * OpenAI's error shape, which is what a client's error handling reads.
 *
 * A raw ComfyUI error here would be a 400 the caller cannot classify: its
 * validation failures come back as a `node_errors` map keyed by node id,
 * which is meaningless to somebody who never wrote a graph.
 */
export function errorBody(type: string, message: string, code?: string): Block {
  return { error: { message, type, param: null, code: code ?? null } };
}

/**
 * ComfyUI's validation failure, flattened into one sentence.
 *
 * `/prompt` answers 400 with `{error: {...}, node_errors: {"1": {errors: [...]}}}`
 * and the useful part is usually one line deep in the map — most often that
 * the checkpoint named does not exist, which is the single most likely thing
 * to be wrong with a request that got this far.
 */
export function flattenNodeErrors(body: Block): string {
  const parts: string[] = [];
  const top = body?.error?.message ?? body?.error;
  if (typeof top === 'string' && top) parts.push(top);
  for (const node of Object.values(body?.node_errors ?? {}) as Block[]) {
    for (const e of (node?.errors ?? []) as Block[]) {
      const detail = [e?.message, e?.details].filter(Boolean).join(': ');
      if (detail) parts.push(detail);
    }
  }
  return parts.join('; ') || 'the workflow was rejected';
}

// ── The HTTP handler ───────────────────────────────────────────────────────

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Read the request body, with a ceiling.
 *
 * The twin of the reader in anthropic.ts, and separate from it on purpose:
 * these are the only two paths in perch that buffer a request, and each one
 * enforcing its own ceiling is what stops a future third translator from
 * inheriting the check by accident and losing it in a refactor. The
 * content-length test in proxy.ts runs first; a chunked request has no
 * content-length, which is why the bytes are counted again here.
 */
async function readBody(req: http.IncomingMessage, limit: number): Promise<Block> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function comfyJson<T>(url: string, agent?: http.Agent, timeoutMs = 10_000): Promise<T | null> {
  try {
    // Not `fetch`: it cannot be given an agent, so a call left on it would
    // ignore the service's proxy and go direct — succeeding, with nothing to
    // show it had. See upstream.ts.
    const res = await requestUpstream(url, { agent, timeoutMs });
    if (res.status < 200 || res.status >= 300) return null;
    return JSON.parse(res.body.toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** What ComfyUI can load right now, which is what `model` is matched against. */
export async function availableCheckpoints(upstreamUrl: string, agent?: http.Agent): Promise<string[]> {
  const list = await comfyJson<string[]>(`${upstreamUrl}/models/checkpoints`, agent);
  return Array.isArray(list) ? list.map(String) : [];
}

export interface ImagesResult { status: number; bytes: number; tokens: number; ttftMs: number | null }

/**
 * `GET /v1/models` on the video service — the checkpoints, in OpenAI's shape.
 *
 * Not decoration. `model` on a generation request is matched against filenames
 * that live in a volume, and without this the only way to discover one is
 * `/object_info`, which is megabytes of JSON describing every node ComfyUI
 * has. A client that cannot name a model cannot use the endpoint.
 */
export async function handleImageModels(res: http.ServerResponse, upstreamUrl: string, agent?: http.Agent): Promise<number> {
  const names = await availableCheckpoints(upstreamUrl, agent);
  send(res, 200, {
    object: 'list',
    data: names.map((id) => ({ id, object: 'model', created: 0, owned_by: 'perch' })),
  });
  return 200;
}

/**
 * `POST /v1/images/generations` — one picture, out of a ComfyUI graph.
 *
 * The three calls this collapses are: queue the graph, wait for it in the
 * history, fetch the file. Everything before it in proxy.ts — the token, the
 * scope, the size ceiling, the concurrency backstop, the activity ring — has
 * already run, exactly as it does for a piped route.
 */
export async function handleImages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamUrl: string,
  started: number,
  // How to reach the upstream, when that is not a direct connection. Every
  // call below carries it; one that did not would quietly go direct while the
  // rest of the request went through the operator's proxy.
  agent?: http.Agent,
): Promise<ImagesResult> {
  const fail = (status: number, type: string, message: string, code?: string): ImagesResult => {
    send(res, status, errorBody(type, message, code));
    return { status, bytes: 0, tokens: 0, ttftMs: null };
  };

  let body: Block;
  try {
    body = await readBody(req, config.maxBodyBytes);
  } catch (e) {
    const tooLarge = (e as Error).message === 'request too large';
    return fail(
      tooLarge ? 413 : 400,
      'invalid_request_error',
      tooLarge ? 'request too large' : 'the request body is not valid JSON',
    );
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return fail(400, 'invalid_request_error', 'prompt is required');

  // OpenAI's newer image models return base64 and have no `url` form, and
  // perch has nothing it could put behind a URL: the picture ComfyUI made is
  // a temp file behind an authenticated port. Answering with base64 anyway
  // would give a client reading `.url` an undefined it discovers three lines
  // later, so this refuses in the one place the caller can act on it.
  if (body?.response_format && body.response_format !== 'b64_json') {
    return fail(
      400,
      'invalid_request_error',
      'this endpoint returns b64_json only; perch does not host generated images at a URL',
      'unsupported_response_format',
    );
  }

  const size = parseSize(body?.size);
  if ('error' in size) return fail(400, 'invalid_request_error', size.error);

  const available = await availableCheckpoints(upstreamUrl, agent);
  if (!available.length) {
    return fail(
      503,
      'api_error',
      'no image checkpoints are installed. The console’s Models page lists them; `sudo ./bin/perch fetch dreamshaper-8` is the small one.',
      'no_model',
    );
  }
  const ckptName = matchCheckpoint(body?.model ? String(body.model) : undefined, available);
  if (!ckptName) {
    return fail(
      404,
      'invalid_request_error',
      `no checkpoint here matches ${JSON.stringify(String(body.model))}. Installed: ${available.join(', ')}`,
      'model_not_found',
    );
  }

  const workflow = toWorkflow({
    ckptName,
    prompt,
    // Not in OpenAI's API, and the single most asked-for thing that is
    // missing from it. Absent means the empty string, which is what a graph
    // with no negative prompt uses.
    negativePrompt: typeof body?.negative_prompt === 'string' ? body.negative_prompt : '',
    width: size.width,
    height: size.height,
    batchSize: Math.round(clampNumber(body?.n, 1, 1, MAX_N)),
    // The remaining four are extensions too. Their defaults are the ones a
    // stock ComfyUI text-to-image graph ships with, so a request that sets
    // none of them behaves like the workflow everybody starts from.
    steps: Math.round(clampNumber(body?.steps, 20, 1, 150)),
    cfg: clampNumber(body?.cfg_scale, 7, 0, 30),
    sampler: typeof body?.sampler === 'string' && body.sampler ? body.sampler : 'euler',
    scheduler: typeof body?.scheduler === 'string' && body.scheduler ? body.scheduler : 'normal',
    // ComfyUI caches by graph, so a fixed default would make every request
    // with the same prompt return the same picture out of the cache.
    seed: Number.isFinite(body?.seed) ? Math.floor(Number(body.seed)) : Math.floor(Math.random() * 2 ** 48),
  });

  // ---- queue it ----
  let promptId: string;
  try {
    const queued = await requestUpstream(`${upstreamUrl}/prompt`, {
      agent,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
      timeoutMs: 30_000,
    });
    let queuedBody: Block = {};
    try { queuedBody = JSON.parse(queued.body.toString('utf8')) as Block; } catch { /* reported below */ }
    if (queued.status < 200 || queued.status >= 300) {
      // A rejected graph is almost always a bad `model` or a `sampler` this
      // build does not have, both of which are the caller's to fix.
      return fail(400, 'invalid_request_error', flattenNodeErrors(queuedBody), 'workflow_rejected');
    }
    if (!queuedBody?.prompt_id) return fail(502, 'api_error', 'the image server accepted the job without returning an id');
    promptId = String(queuedBody.prompt_id);
  } catch (e) {
    log.warn('could not queue workflow', (e as Error).message);
    return fail(502, 'api_error', 'the image server is not answering');
  }

  // ---- wait for it ----
  //
  // By polling the history rather than ComfyUI's websocket, which perch does
  // not proxy and would not benefit from: there is no partial image to show,
  // so the only event that matters is the last one. The deadline is the same
  // one the proxy gives an upstream socket, because the thing being waited on
  // is the same thing — a generation that may legitimately take minutes.
  const deadline = Date.now() + config.upstreamIdleMs;
  let outputs: OutputImage[] = [];
  let aborted = false;
  res.on('close', () => { if (!res.writableFinished) aborted = true; });

  for (let attempt = 0; ; attempt += 1) {
    if (aborted) {
      // The job is left running on purpose. ComfyUI's only cancel is
      // `/interrupt`, which stops whatever is on the card right now — and
      // that may well be somebody else's generation rather than this one.
      // Finishing a job nobody collects wastes a minute of GPU; interrupting
      // the wrong one loses somebody's work.
      return { status: 499, bytes: 0, tokens: 0, ttftMs: null };
    }
    if (Date.now() > deadline) {
      return fail(504, 'api_error', 'the image server did not finish in time');
    }
    // Fast at first, because a small model at low steps can be done inside a
    // second and a fixed one-second poll would double the latency of the
    // quickest requests; slower after, because most are not.
    await new Promise((r) => { setTimeout(r, attempt < 8 ? 250 : 1000); });

    const history = await comfyJson<Block>(`${upstreamUrl}/history/${encodeURIComponent(promptId)}`, agent);
    if (!history) continue;
    const outcome = historyOutcome(history, promptId);
    if (outcome === 'failed') {
      return fail(502, 'api_error', 'the image server could not run the workflow', 'generation_failed');
    }
    if (outcome === 'done') {
      outputs = imagesFromHistory(history, promptId);
      break;
    }
  }

  if (!outputs.length) {
    return fail(502, 'api_error', 'the workflow finished without producing an image', 'no_output');
  }

  // ---- collect it ----
  const data: Block[] = [];
  for (const img of outputs) {
    const query = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
    try {
      const file = await requestUpstream(`${upstreamUrl}/view?${query}`, { agent, timeoutMs: 60_000 });
      if (file.status < 200 || file.status >= 300) continue;
      data.push({ b64_json: file.body.toString('base64') });
    } catch (e) {
      log.warn('could not read a generated image', (e as Error).message);
    }
  }
  if (!data.length) return fail(502, 'api_error', 'the image was generated but could not be read back');

  const out = JSON.stringify({ created: Math.floor(Date.now() / 1000), data });
  const bytes = Buffer.byteLength(out);
  if (aborted) return { status: 499, bytes: 0, tokens: 0, ttftMs: null };
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes });
  res.end(out);
  // `tokens` stays zero: the tokens-per-second gauge is about a language
  // model's output and counting a picture into it would make the number lie.
  // The generation itself is still timed, which is what the Status page's
  // "last generation" is reading.
  return { status: 200, bytes, tokens: 0, ttftMs: Date.now() - started };
}
