// The console's side of the conversation with perch-hostd.
//
// perch runs in a container; the helper runs on the host. They talk through a
// directory both can see: perch writes a request file, the helper does the
// work and writes a result file back. See deploy/perch-hostd for the actions
// that exist and why the channel is shaped this way.
//
// If the helper is not installed — perfectly reasonable, perch works without
// it — every call here fails cleanly and the console hides the panels that
// depend on it rather than showing broken ones.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './log.js';

const log = logger('host');

const HOST_DIR = path.join(config.stateDir, 'host');
const REQ_DIR = path.join(HOST_DIR, 'requests');
const RES_DIR = path.join(HOST_DIR, 'results');
const STATUS_FILE = path.join(HOST_DIR, 'status.json');

export interface Gpu {
  vendor: string;
  name: string;
  memTotalMb: number | null;
  memUsedMb: number | null;
  utilPct: number | null;
  tempC: number | null;
  powerW: number | null;
}

export interface UnitState { unit: string; active: string; enabled: string; since: string }

export interface HostStatus {
  at: string;
  hostname: string;
  kernel: string;
  uptimeSeconds: number | null;
  mem: { totalKb: number | null; availableKb: number | null; freeKb: number | null; swapTotalKb: number | null; swapFreeKb: number | null };
  cpu: { load1: number | null; load5: number | null; load15: number | null; cores: number | null };
  gpus: Gpu[];
  disk: { path: string; totalKb: number | null; usedKb: number | null; availableKb: number | null; usedPct: number | null };
  /**
   * What podman reports, with the resource limits each container was created
   * with. The limits are the answer to "did the size I set actually take?" —
   * a value in .env that has not been applied yet shows up here as the old
   * one. Null where the helper predates them or podman could not be asked.
   */
  containers: Array<{ name: string; status: string; startedAt: string; memLimitBytes?: number | null; cpus?: number | null }>;
  boot: UnitState;
  /** One entry per perch-tunnel-*.service the helper can see. */
  tunnels: UnitState[];
  hostd: { version: string; interval: number };
}

/**
 * The helper republishes this every second. "Stale" is how the console knows
 * the helper has stopped, which is different from it never having been there.
 */
export function readHostStatus(): { status: HostStatus | null; present: boolean; stale: boolean } {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf8');
    const status = JSON.parse(raw) as HostStatus;
    const age = Date.now() - new Date(status.at).getTime();
    return { status, present: true, stale: age > 15_000 };
  } catch {
    return { status: null, present: false, stale: true };
  }
}

export type HostAction =
  | 'containers.start' | 'containers.stop' | 'containers.restart' | 'containers.pull'
  // Recreate, not restart: resource limits are fixed when a container is
  // created, so a restart would leave a changed limit sitting in .env doing
  // nothing.
  | 'containers.recreate'
  | 'boot.enable' | 'boot.disable'
  | 'tunnel.start' | 'tunnel.stop' | 'tunnel.restart' | 'tunnel.enable' | 'tunnel.disable'
  | 'tunnel.logs' | 'tunnel.keygen' | 'tunnel.configure' | 'tunnel.remove'
  // env.get reads a setting back from .env. The console cannot see that file
  // — it only has the environment its own container was created with, which
  // goes stale as soon as a setting changes without perch being recreated.
  // whisper.model reports what the speech container is actually started with,
  // which nothing inside a container can see.
  | 'logs' | 'env.set' | 'env.get' | 'whisper.model' | 'daemon.reload';

export interface HostResult { ok: boolean; code: number; output: string }

export class HostUnavailable extends Error {
  constructor() {
    super('the perch host helper is not running, so this cannot be done from the console');
    this.name = 'HostUnavailable';
  }
}

export function hostAvailable(): boolean {
  return readHostStatus().present && !readHostStatus().stale;
}

/**
 * Ask the helper to do one thing and wait for the answer. `timeoutMs` is
 * generous for the actions that pull images, because a slow line pulling a
 * container image is a legitimate several minutes.
 */
export async function runHostAction(action: HostAction, arg = '', timeoutMs = 120_000): Promise<HostResult> {
  if (!hostAvailable()) throw new HostUnavailable();
  const id = crypto.randomBytes(12).toString('hex');
  const body = `action=${action}\narg=${arg}\n`;

  await fsp.mkdir(REQ_DIR, { recursive: true }).catch(() => {});
  // Write beside the target and rename in, so the helper never reads a
  // half-written request.
  const tmp = path.join(REQ_DIR, `.${id}.tmp`);
  await fsp.writeFile(tmp, body, { mode: 0o644 });
  await fsp.rename(tmp, path.join(REQ_DIR, `${id}.req`));

  const resFile = path.join(RES_DIR, `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fsp.readFile(resFile, 'utf8');
      const parsed = JSON.parse(raw) as HostResult;
      await fsp.unlink(resFile).catch(() => {});
      if (!parsed.ok) log.warn(`host action ${action} failed`, parsed.output.slice(0, 200));
      return parsed;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`the host helper did not answer within ${Math.round(timeoutMs / 1000)}s`);
}
