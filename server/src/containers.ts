// How big each container is allowed to be.
//
// perch runs five containers at most, on one machine, sharing one card and one
// pool of system memory. Left alone they each take whatever they can get,
// which is fine until the day ComfyUI decodes a long clip, the kernel picks a
// process to kill, and the thing it picks is Ollama in the middle of somebody
// else's sentence. A limit turns that into a failure inside the container that
// caused it.
//
// The limits are written into .env, because compose reads them when it creates
// a container. That is also why applying one is a recreate rather than a
// restart: a restart reuses the existing container with the resources it was
// created with, so the new value would sit in the file doing nothing — which
// is a change that silently fails, the worst kind.
//
// Two numbers are shown for each, and the difference between them is the
// point. `configured` is what .env says, read from the environment compose
// passed this container rather than from a value remembered here. `effective`
// is what the running container actually has, read from podman by the host
// helper. They differ exactly when a change has been written and not yet
// applied.
import { config } from './config.js';
import { readHostStatus } from './host.js';
import { sizing } from './system.js';
import type { ServiceId } from './services.js';

export interface ContainerDef {
  /** The compose service name, which is also what a restart is asked for. */
  id: string;
  label: string;
  /** The perch service it is behind, or null for perch itself. */
  service: ServiceId | null;
  memKey: string;
  cpuKey: string;
  /** What compose falls back to when the key is unset. */
  defaultMem: string;
  /**
   * Below this it will be killed rather than slowed. Memory limits are not
   * throttles: a process that asks for one byte past the limit is killed, so
   * a limit set too low does not make a container slow, it makes it die
   * halfway through loading a model.
   */
  floorBytes: number;
  note: string;
}

export const CONTAINERS: ContainerDef[] = [
  {
    id: 'perch',
    label: 'perch',
    service: null,
    memKey: 'PERCH_MEM_LIMIT',
    cpuKey: 'PERCH_CPUS',
    defaultMem: '256m',
    floorBytes: 128e6,
    note: 'The console and the endpoints. It streams bodies through without holding them, so it stays small whatever is passing through it — 256 MB is generous.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    service: 'chat',
    memKey: 'OLLAMA_MEM_LIMIT',
    cpuKey: 'OLLAMA_CPUS',
    defaultMem: '0',
    floorBytes: 2e9,
    note: 'The language model. On a GPU box the weights live in VRAM, which no memory limit here touches; on a CPU box they live in this limit, so it has to be larger than the model.',
  },
  {
    id: 'whisper',
    label: 'whisper.cpp',
    service: 'voice',
    memKey: 'WHISPER_MEM_LIMIT',
    cpuKey: 'WHISPER_CPUS',
    defaultMem: '2g',
    floorBytes: 512e6,
    note: 'Transcription. Small unless you run a large model on the CPU, where the weights are in system memory and this is what holds them.',
  },
  {
    id: 'comfy',
    label: 'ComfyUI',
    service: 'video',
    memKey: 'COMFY_MEM_LIMIT',
    cpuKey: 'COMFY_CPUS',
    defaultMem: '24g',
    floorBytes: 8e9,
    note: 'Video, images and music — every diffusion model perch runs is a graph in here. The hungriest container by a distance: it decodes whole clips in memory and offloads model parts back to the host when the card is full, so a tight limit here shows up as an out-of-memory kill mid-render.',
  },
  {
    id: 'kokoro',
    label: 'Kokoro',
    service: 'audio',
    memKey: 'KOKORO_MEM_LIMIT',
    cpuKey: 'KOKORO_CPUS',
    defaultMem: '4g',
    floorBytes: 1e9,
    note: 'Speech synthesis. An 82M-parameter model and the runtime around it; the runtime is most of this.',
  },
];

export function containerDef(id: string): ContainerDef | undefined {
  return CONTAINERS.find((c) => c.id === id);
}

/**
 * The tuning keys the console may set, and which container reads each one.
 *
 * The same recreate-not-restart rule as the sizes above governs these, for the
 * same reason: compose hands a container its environment when it *creates*
 * it, so a restarted container reads back what it already had. Knowing which
 * container a key belongs to is what makes applying one possible at all —
 * OLLAMA_NUM_PARALLEL is read by Ollama, PERCH_MAX_CONCURRENT by perch, and
 * recreating the wrong one leaves the setting exactly as unapplied as a
 * restart did.
 *
 * The memory and CPU keys are deliberately absent. They go through
 * /api/containers/:id/size, which refuses a value below what the container
 * needs; a second way in would be a way around that check.
 *
 * Every key here also has to be one the host helper will write — see
 * do_env_set in deploy/perch-hostd, which keeps its own list because it is
 * the thing with root and cannot trust this one.
 */
export const TUNING_KEYS: Record<string, string> = {
  OLLAMA_NUM_PARALLEL: 'ollama',
  OLLAMA_MAX_LOADED_MODELS: 'ollama',
  OLLAMA_MAX_QUEUE: 'ollama',
  OLLAMA_KV_CACHE_TYPE: 'ollama',
  OLLAMA_FLASH_ATTENTION: 'ollama',
  OLLAMA_KEEP_ALIVE: 'ollama',
  PERCH_MAX_CONCURRENT: 'perch',
};

/** The container a tuning key belongs to, or undefined if it is not settable. */
export function containerForTuningKey(key: string | undefined): ContainerDef | undefined {
  const id = key ? TUNING_KEYS[key] : undefined;
  return id ? containerDef(id) : undefined;
}

export interface TuningValue {
  key: string;
  container: string;
  /** What .env asks for, read from the file by the host helper. */
  configured: string | null;
  /** What the container was created with, or null when nothing could say. */
  running: string | null;
  /** Written, not yet applied: both are known and they disagree. */
  pending: boolean;
}

/**
 * Both figures for every tuning key, out of the host helper's answer.
 *
 * The helper writes one `<scope>\t<KEY>=<value>` line per thing it found:
 * scope `env` for what .env asks for, and the container's own name for what
 * that container was created with. Two scopes rather than two actions,
 * because the pair is only meaningful read together — the gap between them is
 * a change that has been written and not applied, which is exactly the state
 * that used to be invisible.
 *
 * A running value is only believed from the container that actually reads the
 * key. Ollama's environment happens to be where most of these live, but
 * `perch OLLAMA_NUM_PARALLEL=...` would be perch's copy of a number Ollama
 * reads, and reporting that as what is running would be a confident lie in
 * precisely the case somebody is trying to diagnose.
 */
export function tuningReport(helperOutput: string, ownEnv: Record<string, string | undefined> = process.env): TuningValue[] {
  const configured: Record<string, string> = {};
  const running: Record<string, string> = {};
  for (const line of helperOutput.split('\n')) {
    const tab = line.indexOf('\t');
    const eq = line.indexOf('=', tab + 1);
    if (tab < 0 || eq < 0) continue;
    const scope = line.slice(0, tab);
    const key = line.slice(tab + 1, eq);
    const value = line.slice(eq + 1).trim();
    if (!TUNING_KEYS[key] || !value) continue;
    if (scope === 'env') configured[key] = value;
    else if (scope === TUNING_KEYS[key]) running[key] = value;
  }

  return Object.entries(TUNING_KEYS).map(([key, container]) => {
    const set = configured[key] ?? null;
    // perch is the container the console is running in, so its own
    // environment is what perch is running with — no podman needed, and still
    // true when the helper cannot answer at all.
    const live = running[key] ?? (container === 'perch' ? (ownEnv[key] ?? null) : null);
    return {
      key,
      container,
      configured: set,
      running: live,
      // Only when both are known. A key absent from .env is compose's own
      // default rather than a pending change, and an unknown running value is
      // a question nothing answered — neither of those is a difference.
      pending: Boolean(set && live && set !== live),
    };
  });
}

/**
 * A memory limit as a person writes it, in bytes. `0` and an empty value both
 * mean unlimited, which is what compose does with them.
 */
export function memBytes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgKMG])?[bB]?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const scale = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return Math.round(n * scale);
}

/** What compose will accept, and what the host helper will write. */
export function validMem(value: string): boolean {
  return /^\d{1,6}[kmgKMG]?$/.test(value.trim());
}

export function validCpus(value: string): boolean {
  return /^\d{1,3}(\.\d{1,2})?$/.test(value.trim());
}

/**
 * The smallest limit worth allowing for this container on this machine.
 *
 * For Ollama it is not a constant: on a box with no GPU the model runs in
 * system memory, so the floor is the model the sizing recommends plus room to
 * load it. Refusing a limit under that is better than accepting one that
 * guarantees an out-of-memory kill on the first request.
 */
export function floorFor(def: ContainerDef): number {
  if (def.id !== 'ollama') return def.floorBytes;
  const s = sizing();
  return s.basis === 'vram' ? def.floorBytes : Math.max(def.floorBytes, s.recommended.needsBytes);
}

export interface ContainerSize {
  id: string;
  label: string;
  service: ServiceId | null;
  enabled: boolean;
  memKey: string;
  cpuKey: string;
  defaultMem: string;
  floorBytes: number;
  note: string;
  /** What .env says, as compose passed it through to this container. */
  configuredMem: string | null;
  configuredCpus: string | null;
  /**
   * Whether perch was told the configured value at all. An overlay from
   * before these knobs existed does not pass them through, and showing the
   * default as though it were the setting would be a guess presented as fact.
   */
  known: boolean;
  /** What the running container has, from podman by way of the host helper. */
  effectiveMemBytes: number | null;
  effectiveCpus: number | null;
  running: boolean;
  status: string | null;
}

/** The value compose passed through, or null for "no limit". */
function envValue(key: string): string | null {
  const v = String(process.env[key] ?? '').trim();
  return v === '' ? null : v;
}

/**
 * Whether compose passed the key through at all, which is a different
 * question from whether it has a value.
 *
 * An empty value is a real setting — it is how compose spells "no limit", and
 * it is Ollama's default, because on a GPU box a memory limit does nothing
 * useful. An *absent* key means an overlay from before these knobs existed,
 * where the console would otherwise show a default as though it were the
 * setting. The two look identical in a shell and are distinguishable here
 * only because an unset variable is undefined rather than empty.
 */
function envPassed(key: string): boolean {
  return process.env[key] !== undefined;
}

/**
 * Match a compose service to the container podman reports.
 *
 * podman-compose names containers `<project>_<service>_<n>`, and the project
 * here is called perch — so `perch_whisper_1` and `perch_perch_1` both begin
 * with the service name of the console container. Matching anywhere in the
 * name therefore reports whisper's limits as perch's, which is worse than
 * reporting nothing: it is a number, on the right row, that belongs to a
 * different container.
 *
 * So the first segment is dropped before looking, because it is the project
 * rather than the service. A container named after nothing but its service —
 * one somebody started by hand — still matches on its own.
 */
export function containerNameMatches(name: string, id: string): boolean {
  const parts = name.split(/[_-]/).filter(Boolean);
  if (parts.length <= 1) return parts[0] === id;
  return parts.slice(1).includes(id);
}

function containerRow(id: string): { name: string; status: string; memLimitBytes?: number | null; cpus?: number | null } | undefined {
  const { status } = readHostStatus();
  return status?.containers?.find((c) => containerNameMatches(c.name, id));
}

export function containerSizes(): ContainerSize[] {
  const wanted = new Set(config.enabledServices.split(',').map((x) => x.trim()).filter(Boolean));
  wanted.add('chat');
  return CONTAINERS.map((def) => {
    const row = containerRow(def.id);
    return {
      id: def.id,
      label: def.label,
      service: def.service,
      enabled: def.service === null || wanted.has(def.service),
      memKey: def.memKey,
      cpuKey: def.cpuKey,
      defaultMem: def.defaultMem,
      floorBytes: floorFor(def),
      note: def.note,
      configuredMem: envValue(def.memKey),
      configuredCpus: envValue(def.cpuKey),
      known: envPassed(def.memKey),
      effectiveMemBytes: row?.memLimitBytes ?? null,
      effectiveCpus: row?.cpus ?? null,
      running: Boolean(row && row.status.toLowerCase().startsWith('up')),
      status: row?.status ?? null,
    };
  });
}
