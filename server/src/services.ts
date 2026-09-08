// perch started as a proxy in front of Ollama. It now fronts several model
// servers on the same machine — text, embeddings, speech, images, video and
// audio — and they differ only in three things: which port they listen on,
// where they forward to, and which endpoints they are allowed to expose.
//
// So that is all a service is. Everything else — the bearer token, the
// allowlist discipline, the streaming pipe, the concurrency backstop, the
// activity ring — is shared, because the security properties should not vary
// by which model happens to be behind the socket.
//
// Each is off unless switched on. A machine that only writes email should not
// have an image generator listening on it.
import { config } from './config.js';

export type ServiceId = 'chat' | 'voice' | 'video' | 'audio';

/**
 * Which translator answers a route, for the ones perch does not pipe.
 *
 * A string rather than a boolean because there are now two backends being
 * translated for — Ollama into Anthropic's shape, ComfyUI into OpenAI's — and
 * the proxy has to know which. Naming the handler here rather than matching on
 * the path there keeps the route table the single place a route is described.
 */
export type Translator = 'messages' | 'count_tokens' | 'images' | 'image_models';

/**
 * The wire shapes a service answers, as data rather than as prose.
 *
 * `speaks` below says the same thing in a sentence, and that sentence is for a
 * person reading the console. This is for everything else: the console renders
 * a badge per shape, and a client asking what an address is can be told
 * without parsing English.
 *
 * They are shapes, not companies and not backends. `openai` here means "the
 * OpenAI-compatible shape", which is what whisper.cpp and Kokoro serve
 * natively and what `images.ts` translates ComfyUI into.
 */
export type ApiShape = 'ollama' | 'openai' | 'anthropic' | 'comfyui';

export interface Route {
  method: string;
  path: string;
  /** Counts against the concurrency backstop. */
  generating?: boolean;
  /** Needs the 'manage' scope rather than 'use'. */
  manage?: boolean;
  /**
   * Answered by a translator rather than piped upstream, and by which one.
   *
   * Everything else here is a straight pipe: perch never sees the body. A
   * translated route is the exception and it is deliberately explicit, so the
   * one property the proxy's header comment claims for the whole file can be
   * checked against a list rather than remembered.
   */
  translated?: Translator;
}

export interface ServiceDef {
  id: ServiceId;
  label: string;
  /** What it is for, in the console. */
  blurb: string;
  /** Local port perch listens on; the tunnel forwards this. */
  port: number;
  /** The container behind it. */
  upstream: string;
  /** Everything it will answer, and nothing else. */
  routes: Route[];
  /** The compose overlay that brings its container up. */
  overlay: string | null;
  /** The compose service name of the container behind it, for restarts and logs. */
  container: string;
  /**
   * The API shape behind the address, for whoever is pointing something at
   * it. Most clients are written against one of these already, and knowing
   * which is the difference between an address and a usable endpoint.
   */
  speaks: string;
  /** The same, as data. See `ApiShape`. */
  api: ApiShape[];
  /**
   * The environment variable holding this service's proxy, if it has one set.
   *
   * Each service reaches its own upstream, and each may reach it its own way:
   * a chat model on a rented box across the internet and a whisper container
   * one bridge away are not the same journey and should not share a decision.
   * Empty is a direct connection, which is what every service does by default
   * and what a machine hosting its own models wants.
   *
   * The value is a proxy URL — `socks5h://127.0.0.1:9150` for Tor — rather
   * than a switch, so perch holds no opinion about which port Tor listens on
   * and the same field covers a jump host or any other SOCKS proxy. See
   * `upstream.ts`.
   */
  proxyEnv: string;
  /**
   * What to put in Tern for it, or null if Tern has no setting for it.
   *
   * Most services have none, and that is not a gap: perch is a model host in
   * its own right, and Tern is one of the things that can call it.
   */
  ternField: string | null;
}

export const SERVICES: ServiceDef[] = [
  {
    id: 'chat',
    label: 'Chat',
    blurb: 'The language model. Ollama behind an authenticated endpoint, speaking its own API, OpenAI’s and Anthropic’s, so anything written against any of the three can use it — Tern’s composer included.',
    port: config.proxyPort,
    upstream: config.ollamaUrl,
    overlay: null, // always in the base compose file
    container: 'ollama',
    speaks: 'Ollama’s API, OpenAI’s /v1 chat, completions and embeddings, and Anthropic’s /v1/messages',
    api: ['ollama', 'openai', 'anthropic'],
    proxyEnv: 'PERCH_CHAT_PROXY',
    ternField: 'Admin → AI model → Base URL',
    // Everything Tern asks Ollama for, and nothing else. Ollama's own API is
    // wider than this — /api/create, /api/push and the blob endpoints can
    // write a model onto this box or ship one off it — so they are absent.
    routes: [
      { method: 'GET', path: '/api/version' },
      { method: 'GET', path: '/api/tags' },
      { method: 'GET', path: '/api/ps' },
      { method: 'POST', path: '/api/show' },
      { method: 'POST', path: '/api/chat', generating: true },
      { method: 'POST', path: '/api/generate', generating: true },
      { method: 'POST', path: '/api/embed' },
      { method: 'POST', path: '/api/embeddings' },
      { method: 'POST', path: '/api/pull', manage: true },
      { method: 'DELETE', path: '/api/delete', manage: true },
      { method: 'GET', path: '/v1/models' },
      { method: 'POST', path: '/v1/chat/completions', generating: true },
      { method: 'POST', path: '/v1/completions', generating: true },
      { method: 'POST', path: '/v1/embeddings' },
      // The two Anthropic-shaped routes. Unlike every other entry in this
      // table these are NOT piped to Ollama — Ollama does not serve this
      // shape, so `anthropic.ts` translates them. They are listed here anyway
      // because this table is what decides the token, the scope, the
      // concurrency backstop and the activity ring, and a route that skipped
      // it would skip all four.
      { method: 'POST', path: '/v1/messages', generating: true, translated: 'messages' },
      { method: 'POST', path: '/v1/messages/count_tokens', translated: 'count_tokens' },
    ],
  },
  {
    id: 'voice',
    label: 'Dictation',
    blurb: 'Speech to text. whisper.cpp behind its own server, speaking OpenAI’s transcription shape, so anything written against that API — Tern’s dictation key included — needs no adapter.',
    port: config.voicePort,
    upstream: config.whisperUrl,
    overlay: 'compose.voice.yml',
    container: 'whisper',
    speaks: 'OpenAI’s /v1/audio/transcriptions',
    api: ['openai'],
    proxyEnv: 'PERCH_VOICE_PROXY',
    ternField: 'Admin → AI model → Dictation → Transcriber address',
    // One endpoint. Tern posts audio to the OpenAI path, which is where
    // compose.voice.yml tells whisper.cpp to serve via --inference-path.
    routes: [
      { method: 'POST', path: '/v1/audio/transcriptions', generating: true },
      { method: 'GET', path: '/' },
    ],
  },
  {
    id: 'video',
    label: 'Video and images',
    blurb: 'Video, images and music. ComfyUI, which runs a workflow rather than a single prompt — one graph runner for every diffusion model, because that is what they all are. Images also have a plain OpenAI-shaped endpoint in front of that, so a client that just wants a picture does not have to build a graph.',
    port: config.videoPort,
    upstream: config.comfyUrl,
    overlay: 'compose.video.yml',
    container: 'comfy',
    speaks: 'OpenAI’s /v1/images/generations, and ComfyUI’s workflow API — POST /prompt, then /history and /view',
    api: ['openai', 'comfyui'],
    proxyEnv: 'PERCH_VIDEO_PROXY',
    ternField: null,
    // ComfyUI's API is small but not harmless: it can load models by name,
    // write files into its input directory, and — with the manager extension
    // installed — install code from the internet. What is exposed here is
    // queueing a workflow, reading the result, and the two read-only queries
    // needed to drive both.
    //
    // Deliberately absent: /api/manager/* (installs custom nodes),
    // /userdata/* and /api/userdata/* (reads and writes arbitrary files under
    // the user directory), and the websocket, which perch does not proxy —
    // progress is read by polling /history.
    routes: [
      // The two OpenAI-shaped routes, which are NOT piped to ComfyUI —
      // ComfyUI does not serve this shape, so `images.ts` translates them. A
      // picture is one call here and three there, and the difference is the
      // reason perch no longer runs a second container for images.
      //
      // They are listed in this table like everything else because the table
      // is what decides the token, the scope, the concurrency backstop and the
      // activity ring, and a route that skipped it would skip all four.
      { method: 'POST', path: '/v1/images/generations', generating: true, translated: 'images' },
      { method: 'GET', path: '/v1/models', translated: 'image_models' },
      { method: 'POST', path: '/prompt', generating: true },
      { method: 'GET', path: '/history' },
      { method: 'GET', path: '/queue' },
      { method: 'POST', path: '/interrupt' },
      // The generated file itself, by name and type in the query string.
      { method: 'GET', path: '/view' },
      // Image to video needs a source image, and this is the only way in.
      // It writes into ComfyUI's input directory and nowhere else; the body
      // cap in config.ts is what stops it being a way to fill the disk.
      { method: 'POST', path: '/upload/image' },
      { method: 'GET', path: '/object_info' },
      { method: 'GET', path: '/system_stats' },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    blurb: 'Speech synthesis. Kokoro behind an OpenAI-shaped API, so the same client code that reaches OpenAI’s text-to-speech reaches this instead. Music generation is a workflow on the video service rather than a server of its own.',
    port: config.audioPort,
    upstream: config.ttsUrl,
    overlay: 'compose.audio.yml',
    container: 'kokoro',
    speaks: 'OpenAI’s /v1/audio/speech',
    api: ['openai'],
    proxyEnv: 'PERCH_AUDIO_PROXY',
    ternField: null,
    // The mirror image of dictation: audio out rather than in, on the OpenAI
    // path a client will already be written against.
    routes: [
      { method: 'POST', path: '/v1/audio/speech', generating: true },
      { method: 'GET', path: '/v1/audio/voices' },
      { method: 'GET', path: '/v1/models' },
      { method: 'GET', path: '/health' },
    ],
  },
];

export function serviceById(id: ServiceId): ServiceDef {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) throw new Error(`no such service: ${id}`);
  return s;
}

/**
 * Roughly what each service wants on the card while it is working, so the
 * console can say when the enabled set will not fit. These are the resident
 * cost of the smallest sensible model for each, not the largest.
 */
export const SERVICE_VRAM_HINT: Record<ServiceId, number> = {
  chat: 9.4e9,   // qwen3.5:9b and up; the Models page is the real answer
  voice: 1.0e9,  // whisper small; base is about 0.4 GB
  // One container now covers images, video and music, and this is the video
  // figure because video is the expensive one: a 5B model and its text encoder,
  // with the 14B ones wanting a card to themselves. An SD 1.5 checkpoint in the
  // same container is nearer 4.5 GB, so a machine only generating pictures has
  // more headroom than this says — which is the safe direction to be wrong in.
  video: 12e9,
  audio: 1.5e9,  // Kokoro is 82M parameters — this is mostly the runtime around it
};

/** Every service id, for validating what a caller asked for. */
export const SERVICE_IDS: ServiceId[] = SERVICES.map((s) => s.id);

export function isServiceId(value: unknown): value is ServiceId {
  return typeof value === 'string' && (SERVICE_IDS as string[]).includes(value);
}
