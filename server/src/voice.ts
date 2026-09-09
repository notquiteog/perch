// The speech model, which is the one model on this machine perch could not
// see anything about.
//
// Ollama has an API for its models: list, pull, delete, and a progress stream
// while it works. whisper.cpp has none of that. It is started with one model
// file, it downloads that file itself on first start if the volume is empty,
// and the only thing it will tell you afterwards is whether it is listening.
// So the console cannot offer the same buttons here, and pretending otherwise
// would mean a Download button that does nothing and a list that is a guess.
//
// What it can do honestly is all of this:
//
//   - say which model the container was started with, read from the same
//     environment compose passes to it rather than remembered here;
//   - say whether the transcriber is answering yet, which during a first
//     start is exactly the question — the port does not open until the
//     weights are on disk, so "not answering" and "still downloading" are
//     the same state and the card says so;
//   - change the model, which means writing WHISPER_MODEL and restarting the
//     container, and then watching the port for it to come back.
//
// The catalogue is whisper.cpp's own published set. Sizes are the ggml files
// as upstream publishes them; `needsBytes` is roughly what one occupies while
// transcribing, which is the number that decides whether it fits beside a
// writing model on the same card.
import { config } from './config.js';
import { runHostAction } from './host.js';

export interface SpeechModel {
  name: string;
  sizeBytes: number;
  needsBytes: number;
  note: string;
}

export const SPEECH_MODELS: SpeechModel[] = [
  { name: 'tiny', sizeBytes: 0.075e9, needsBytes: 0.27e9, note: 'Fastest and least accurate. Fine for short, clear dictation in one language.' },
  { name: 'base', sizeBytes: 0.142e9, needsBytes: 0.39e9, note: 'The default, and what fits a small box beside a chat model. Good on clear speech.' },
  { name: 'small', sizeBytes: 0.466e9, needsBytes: 0.85e9, note: 'Noticeably better on accents, names and background noise. The right pick when there is room.' },
  { name: 'medium', sizeBytes: 1.5e9, needsBytes: 2.4e9, note: 'Better again, and slow on a CPU — worth it only with a GPU or a lot of cores.' },
  { name: 'large-v3', sizeBytes: 3.1e9, needsBytes: 4.3e9, note: 'The best whisper.cpp publishes. Wants a GPU; on a card also holding a writing model it is a real claim on the VRAM.' },
  { name: 'large-v3-turbo', sizeBytes: 1.62e9, needsBytes: 2.6e9, note: 'Nearly large-v3 quality at a fraction of the time. The best choice on a card with room to spare.' },
  // The English-only builds are meaningfully better at English for their
  // size, and useless for anything else, so they are offered rather than
  // hidden — but never recommended, because the cost of being wrong about
  // which language somebody dictates in is a transcript of nonsense.
  { name: 'tiny.en', sizeBytes: 0.075e9, needsBytes: 0.27e9, note: 'English only, and the smallest thing here. For a box with nothing to spare, where the alternative is no transcription at all.' },
  { name: 'base.en', sizeBytes: 0.142e9, needsBytes: 0.39e9, note: 'English only, and better at English than plain base for the same size.' },
  { name: 'small.en', sizeBytes: 0.466e9, needsBytes: 0.85e9, note: 'English only. The best accuracy per megabyte if nobody here dictates in another language.' },
  { name: 'medium.en', sizeBytes: 1.5e9, needsBytes: 2.4e9, note: 'English only, and about as good as English gets short of large-v3-turbo — which is smaller and faster, so this is worth it only on a box where the turbo build misbehaves.' },
];

export function validSpeechModel(name: string): boolean {
  return SPEECH_MODELS.some((m) => m.name === name);
}

/** Which model compose handed *this* container when it was created. */
export function currentSpeechModel(): string {
  const v = String(process.env.WHISPER_MODEL ?? '').trim();
  return v || 'base';
}

/**
 * Which model is actually configured, asked of the host rather than
 * remembered.
 *
 * These are two different questions and they diverge exactly when it matters.
 * The environment above is what compose passed perch when *perch* was
 * created; .env is what it will pass whisper next time whisper is created.
 * Change the speech model and only whisper is recreated — as it should be,
 * since recreating perch would take the console down mid-answer — so the
 * snapshot is stale from that moment on, and the card would go on naming the
 * old model while the new one transcribes.
 *
 * Without the helper there is nothing to ask, and the snapshot is the best
 * available answer; `known` says which of the two this is.
 */
export async function configuredSpeechModel(): Promise<{ model: string; known: boolean }> {
  try {
    const r = await runHostAction('env.get', 'WHISPER_MODEL', 10_000);
    const value = r.ok ? r.output.trim() : '';
    if (value && validSpeechModel(value)) return { model: value, known: true };
  } catch {
    // No helper installed, or it is not running. The console says so
    // elsewhere; here it just means falling back.
  }
  const snapshot = String(process.env.WHISPER_MODEL ?? '').trim();
  return { model: snapshot || 'base', known: Boolean(snapshot) };
}

export interface VoiceStatus {
  /** Whether the dictation service is switched on at all. */
  enabled: boolean;
  url: string;
  model: string;
  /** Whether perch knows which model it was started with, or is assuming the default. */
  modelKnown: boolean;
  /** Answering right now. */
  ok: boolean;
  error?: string;
  /**
   * True when the address refuses the connection outright, which during a
   * first start or a model change is the container fetching weights rather
   * than anything being wrong. whisper-server does not open its port until
   * the file is on disk, so this is the only "still downloading" signal there
   * is — and saying that plainly beats a red badge on a container that is
   * working exactly as intended.
   */
  starting: boolean;
  /**
   * What the container is actually started with, from the host helper, or
   * null when there is no helper to ask. Different from `model` — which is
   * what .env asks for next time — whenever a change has been written and not
   * applied, and saying which is which is the difference between "your switch
   * worked" and "your switch is still pending".
   */
  running: string | null;
  /** A model is set that the running container does not have. */
  pending: boolean;
  catalog: SpeechModel[];
  at: string;
}

/** What the whisper container was actually started with, if anything can say. */
async function runningSpeechModel(): Promise<string | null> {
  try {
    const r = await runHostAction('whisper.model', '', 10_000);
    const value = r.ok ? r.output.trim() : '';
    return value || null;
  } catch {
    return null;
  }
}

export async function voiceStatus(): Promise<VoiceStatus> {
  const enabled = config.enabledServices.split(',').map((x) => x.trim()).includes('voice');
  const [configured, running] = await Promise.all([configuredSpeechModel(), runningSpeechModel()]);
  const base = {
    enabled,
    url: config.whisperUrl,
    model: configured.model,
    modelKnown: configured.known,
    running,
    // Only a claim when something actually answered about the container;
    // "no helper" is not evidence of a mismatch.
    pending: running !== null && running !== configured.model,
    catalog: SPEECH_MODELS,
    at: new Date().toISOString(),
  };
  if (!enabled) return { ...base, ok: false, starting: false, error: 'dictation is not switched on for this machine' };
  try {
    // whisper.cpp serves / and the inference path and nothing else, so a live
    // root is the whole health check. Any answer below 500 counts: a 404 from
    // a listening server still means the address is right.
    // transport-exempt: the console's own health probe of the sibling whisper
    // container over the compose bridge, not a caller's request being carried
    // to an upstream. It reads a status code and nothing else.
    const res = await fetch(`${config.whisperUrl}/`, { signal: AbortSignal.timeout(5000) });
    if (res.status < 500) return { ...base, ok: true, starting: false };
    return { ...base, ok: false, starting: false, error: `HTTP ${res.status}` };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    return { ...base, ok: false, starting: looksLikeStarting(message), error: message };
  }
}

/**
 * Whether a failure to reach the transcriber is it starting rather than it
 * being broken.
 *
 * There is no way to ask: whisper-server holds its port closed until the
 * model file is on disk, so a first start and a dead container produce the
 * same refused connection. The reason string is the only thing that separates
 * "nothing is listening there yet" from "something answered and it went
 * wrong", and getting this the wrong way round means either a red badge on a
 * container doing exactly what it should, or a reassuring message about a
 * container that has crashed.
 */
export function looksLikeStarting(message: string): boolean {
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH/i.test(message)) return true;
  // Node reports a refused connection through fetch as a bare "fetch failed"
  // with the real reason on `cause`, which does not survive into the message.
  if (/^fetch failed$/i.test(message.trim())) return true;
  // A timeout is a machine that is thinking, not a port that is closed —
  // usually a transcriber loading a large model into memory. Also a wait.
  return /timed? ?out|abort/i.test(message);
}
