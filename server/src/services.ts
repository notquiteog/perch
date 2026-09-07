// perch started as a proxy in front of Ollama. It now fronts several model
// servers on the same machine — chat, dictation, images — and they differ only
// in three things: which port they listen on, where they forward to, and which
// endpoints they are allowed to expose.
//
// So that is all a service is. Everything else — the bearer token, the
// allowlist discipline, the streaming pipe, the concurrency backstop, the
// activity ring — is shared, because the security properties should not vary
// by which model happens to be behind the socket.
//
// Each is off unless switched on. A machine that only writes email should not
// have an image generator listening on it.
import { config } from './config.js';

export type ServiceId = 'chat' | 'voice' | 'image';

export interface Route {
  method: string;
  path: string;
  /** Counts against the concurrency backstop. */
  generating?: boolean;
  /** Needs the 'manage' scope rather than 'use'. */
  manage?: boolean;
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
  /** What to put in Tern for it, or null if Tern has no setting for it. */
  ternField: string | null;
}

export const SERVICES: ServiceDef[] = [
  {
    id: 'chat',
    label: 'Chat',
    blurb: 'The writing model. Drafts, replies, rewrites, subject lines — everything Tern’s composer asks for.',
    port: config.proxyPort,
    upstream: config.ollamaUrl,
    overlay: null, // always in the base compose file
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
    ],
  },
  {
    id: 'voice',
    label: 'Dictation',
    blurb: 'Speech to text for Tern’s dictation key. whisper.cpp behind its own server, which speaks OpenAI’s transcription shape, so Tern needs no adapter.',
    port: config.voicePort,
    upstream: config.whisperUrl,
    overlay: 'compose.voice.yml',
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
    blurb: 'Stable Diffusion behind an A1111-compatible API. Nothing in Tern uses this yet — it is here for anything else on your network that wants a local image model.',
    port: config.imagePort,
    upstream: config.sdUrl,
    overlay: 'compose.image.yml',
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
};
