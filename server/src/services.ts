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

export type ServiceId = 'chat' | 'voice' | 'image' | 'video' | 'audio';

export interface Route {
  method: string;
  path: string;
  /** Counts against the concurrency backstop. */
  generating?: boolean;
  /** Needs the 'manage' scope rather than 'use'. */
  manage?: boolean;
  /**
   * Answered by a translator rather than piped upstream.
   *
   * Everything else here is a straight pipe: perch never sees the body. A
   * translated route is the exception and the flag is deliberately explicit,
   * so the one property the proxy's header comment claims for the whole file
   * can be checked against a list rather than remembered.
   */
  translated?: boolean;
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
      { method: 'POST', path: '/v1/messages', generating: true, translated: true },
      { method: 'POST', path: '/v1/messages/count_tokens', translated: true },
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
    ternField: 'Admin → AI model → Dictation → Transcriber address',
    // One endpoint. Tern posts audio to the OpenAI path, which is where
    // compose.voice.yml tells whisper.cpp to serve via --inference-path.
    routes: [
      { method: 'POST', path: '/v1/audio/transcriptions', generating: true },
      { method: 'GET', path: '/' },
    ],
  },
  {
    id: 'image',
    label: 'Images',
    blurb: 'Image generation. Stable Diffusion behind an A1111-compatible API, for anything on your network that wants a local image model.',
    port: config.imagePort,
    upstream: config.sdUrl,
    overlay: 'compose.image.yml',
    container: 'sd',
    speaks: 'the A1111 /sdapi/v1 generation endpoints',
    ternField: null,
    // The A1111 API is large and mostly concerned with changing the server's
    // own configuration. Only generation and the read-only queries needed to
    // drive it are exposed: nothing here can install a model, run a script, or
    // rewrite the server's settings.
    routes: [
      { method: 'POST', path: '/sdapi/v1/txt2img', generating: true },
      { method: 'POST', path: '/sdapi/v1/img2img', generating: true },
      { method: 'GET', path: '/sdapi/v1/sd-models' },
      { method: 'GET', path: '/sdapi/v1/samplers' },
      { method: 'GET', path: '/sdapi/v1/progress' },
      { method: 'GET', path: '/sdapi/v1/memory' },
      { method: 'GET', path: '/internal/ping' },
    ],
  },
  {
    id: 'video',
    label: 'Video',
    blurb: 'Video generation. ComfyUI, which runs a workflow rather than a single prompt — and the same container is what runs the newer image models and the music ones, because they are all diffusion graphs.',
    port: config.videoPort,
    upstream: config.comfyUrl,
    overlay: 'compose.video.yml',
    container: 'comfy',
    speaks: 'ComfyUI’s workflow API — POST /prompt, then /history and /view',
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
  image: 4.5e9,  // SD 1.5 class; SDXL is nearer 10 GB
  video: 12e9,   // a 5B video model and its text encoder; the 14B ones want a card to themselves
  audio: 1.5e9,  // Kokoro is 82M parameters — this is mostly the runtime around it
};

/** Every service id, for validating what a caller asked for. */
export const SERVICE_IDS: ServiceId[] = SERVICES.map((s) => s.id);

export function isServiceId(value: unknown): value is ServiceId {
  return typeof value === 'string' && (SERVICE_IDS as string[]).includes(value);
}
