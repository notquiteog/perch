// Container sizes.
//
// A memory limit is not a throttle: a container that asks for one byte past
// it is killed, not slowed. So the two things worth testing are the two that
// turn this feature from useful into harmful — that a value which cannot work
// is refused rather than written, and that what the console reports is what
// the container actually has rather than what somebody hoped it had.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PERCH_LOG_LEVEL = 'error';
process.env.PERCH_SERVICES = 'chat,voice';
// The sizes as compose passes them through. `known` is false without these,
// and the console says it is showing a default rather than a setting.
process.env.PERCH_MEM_LIMIT = '256m';
process.env.WHISPER_MEM_LIMIT = '3g';
process.env.WHISPER_CPUS = '2';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-containers-'));
process.env.PERCH_STATE_DIR = stateDir;
fs.mkdirSync(path.join(stateDir, 'host'), { recursive: true });

/** Stand in for the host helper's telemetry: what podman says is running. */
function publishHostStatus(containers: Array<{ name: string; status: string; memLimitBytes: number | null; cpus: number | null }>): void {
  fs.writeFileSync(path.join(stateDir, 'host', 'status.json'), JSON.stringify({
    at: new Date().toISOString(),
    containers: containers.map((c) => ({ startedAt: '', ...c })),
    mem: { totalKb: 32 * 1024 * 1024 },
    gpus: [],
  }));
}

const c = await import('./containers.js');

test('a limit is read the way a person writes it', () => {
  assert.equal(c.memBytes('512m'), 512 * 1024 ** 2);
  assert.equal(c.memBytes('8g'), 8 * 1024 ** 3);
  assert.equal(c.memBytes('8G'), 8 * 1024 ** 3);
  assert.equal(c.memBytes('1024'), 1024);
  // "No limit", which compose spells as an empty value and podman as zero.
  assert.equal(c.memBytes(''), null);
  assert.equal(c.memBytes(null), null);
  assert.equal(c.memBytes('0'), 0);
  assert.equal(c.memBytes('lots'), null);
});

// Both values end up as arguments to `podman create`, so the shapes are
// checked here as well as in the host helper — the helper is the boundary
// that matters, and this is the one that produces a readable error.
test('only values compose can use are accepted', () => {
  for (const ok of ['0', '512m', '2g', '16G', '1024']) assert.equal(c.validMem(ok), true, ok);
  for (const bad of ['', '2gb ; rm -rf /', '$(id)', '-1', '2.5g', 'unlimited']) assert.equal(c.validMem(bad), false, bad);
  for (const ok of ['0', '1', '1.5', '16']) assert.equal(c.validCpus(ok), true, ok);
  for (const bad of ['', 'all', '1,5', '-2', '1.5e3']) assert.equal(c.validCpus(bad), false, bad);
});

// The floor for Ollama is not a constant. With no GPU the weights live in
// system memory, so a limit under the model's size guarantees a container
// killed partway through the first request — which looks like a crash rather
// than like a setting.
test('Ollama’s floor rises on a machine with no GPU', async () => {
  publishHostStatus([]);
  const { sizing } = await import('./system.js');
  const ollama = c.CONTAINERS.find((x) => x.id === 'ollama')!;
  const floor = c.floorFor(ollama);
  assert.ok(floor >= sizing().recommended.needsBytes, 'the floor must clear the model this machine is told to run');
  assert.ok(floor > ollama.floorBytes || sizing().basis === 'vram');
});

// The project is also called perch, so podman reports `perch_whisper_1` and
// `perch_perch_1`. Matching the service name anywhere in that would put
// whisper's limits on perch's row: a plausible number, on the right row,
// belonging to the wrong container.
test('a container is told apart from the project it belongs to', () => {
  assert.equal(c.containerNameMatches('perch_perch_1', 'perch'), true);
  assert.equal(c.containerNameMatches('perch_whisper_1', 'perch'), false);
  assert.equal(c.containerNameMatches('perch_whisper_1', 'whisper'), true);
  assert.equal(c.containerNameMatches('perch-comfy-1', 'comfy'), true);
  assert.equal(c.containerNameMatches('someone-elses-ollama-box', 'ollama'), true);
  assert.equal(c.containerNameMatches('ollama', 'ollama'), true);
  assert.equal(c.containerNameMatches('perch_sd_1', 'comfy'), false);
});

test('a container reports what it was given, not what was asked for', () => {
  // Recreating is what applies a limit, so a whisper container created before
  // the change still has the old one — and saying otherwise would turn "you
  // have not applied it yet" into "this setting does nothing".
  publishHostStatus([
    { name: 'perch_whisper_1', status: 'Up 2 hours', memLimitBytes: 2 * 1024 ** 3, cpus: 2 },
    { name: 'perch_perch_1', status: 'Up 2 hours', memLimitBytes: 256 * 1024 ** 2, cpus: null },
  ]);
  const rows = c.containerSizes();
  const whisper = rows.find((r) => r.id === 'whisper')!;
  assert.equal(whisper.configuredMem, '3g', 'what .env asks for');
  assert.equal(whisper.effectiveMemBytes, 2 * 1024 ** 3, 'what the running container has');
  assert.equal(whisper.running, true);
  assert.equal(whisper.known, true);

  const perch = rows.find((r) => r.id === 'perch')!;
  assert.equal(perch.effectiveCpus, null, 'no CPU limit is not the same as a limit of zero');
});

test('a container nothing has passed a size for says so rather than guessing', () => {
  publishHostStatus([]);
  const comfy = c.containerSizes().find((r) => r.id === 'comfy')!;
  assert.equal(comfy.configuredMem, null);
  assert.equal(comfy.known, false, 'the console must be able to say it is showing the default');
  assert.equal(comfy.defaultMem, '24g');
});

// "No limit" is a setting, not an absence — it is how compose spells it, and
// it is what Ollama gets by default because on a GPU box a memory limit does
// nothing useful. Reporting that as "perch was never told" would send
// somebody to re-run the installer to fix something that is already right.
test('an empty limit is a decision, not a missing value', () => {
  process.env.OLLAMA_MEM_LIMIT = '';
  publishHostStatus([]);
  const ollama = c.containerSizes().find((r) => r.id === 'ollama')!;
  assert.equal(ollama.configuredMem, null, 'nothing to show, because there is no limit');
  assert.equal(ollama.known, true, 'but compose did pass it through');
  delete process.env.OLLAMA_MEM_LIMIT;
});

test('only the services this machine runs are switched on', () => {
  const rows = c.containerSizes();
  assert.equal(rows.find((r) => r.id === 'ollama')!.enabled, true, 'chat is always on');
  assert.equal(rows.find((r) => r.id === 'perch')!.enabled, true, 'perch itself is not optional');
  assert.equal(rows.find((r) => r.id === 'whisper')!.enabled, true);
  assert.equal(rows.find((r) => r.id === 'comfy')!.enabled, false);
});

// The tuning keys, which share the sizes' rule: a value in .env reaches the
// process that reads it only when the container is created again. Applying one
// therefore means recreating a *particular* container, and the mapping below
// is the whole of how the console knows which. Recreating the wrong one would
// leave the setting exactly as unapplied as the restart that used to be
// advertised here, while looking like it had worked.
test('every tuning key names a container that exists', () => {
  for (const [key, id] of Object.entries(c.TUNING_KEYS)) {
    assert.ok(c.containerDef(id), `${key} is read by "${id}", which is not a container perch runs`);
    assert.equal(c.containerForTuningKey(key)!.id, id);
  }
  assert.equal(c.containerForTuningKey('OLLAMA_NUM_PARALLEL')!.id, 'ollama');
  assert.equal(c.containerForTuningKey('PERCH_MAX_CONCURRENT')!.id, 'perch',
    'perch reads its own concurrency limit; recreating Ollama would not apply it');
});

test('a key that is not settable has no container, so nothing is recreated for it', () => {
  assert.equal(c.containerForTuningKey('PATH'), undefined);
  assert.equal(c.containerForTuningKey(undefined), undefined);
  assert.equal(c.containerForTuningKey(''), undefined);
});

// Sizes have their own route because it refuses a limit below what the
// container needs — a limit set too low is an out-of-memory kill, not a slow
// container. A size key reachable through the tuning route as well would be a
// way around that check.
test('the size keys are not settable as tuning keys', () => {
  for (const def of c.CONTAINERS) {
    assert.equal(c.TUNING_KEYS[def.memKey], undefined, `${def.memKey} must go through the size route`);
    assert.equal(c.TUNING_KEYS[def.cpuKey], undefined, `${def.cpuKey} must go through the size route`);
  }
});

// The host helper keeps its own list of writable keys, because it is the part
// with root and does not trust the console's. Offering a key it will refuse is
// a setting that fails at the last step, which is the failure people report as
// "the console does nothing".
test('the host helper will write every key the console offers', () => {
  const helper = fs.readFileSync(new URL('../../deploy/perch-hostd', import.meta.url), 'utf8');
  const body = helper.slice(helper.indexOf('do_env_set()'));
  const accepted = new Set(body.slice(0, body.indexOf('\n}')).match(/[A-Z][A-Z0-9_]{2,}/g) ?? []);
  for (const key of Object.keys(c.TUNING_KEYS)) {
    assert.ok(accepted.has(key), `${key} is offered by the console but not accepted by deploy/perch-hostd`);
  }
});

// The two figures for a tuning knob, which exist for the same reason the two
// figures for a size do: a value written into .env and not yet applied is the
// state somebody is in when they say a setting did nothing, and it has to be
// visible rather than inferred.
const HELPER = [
  'env\tOLLAMA_NUM_PARALLEL=4',
  'env\tOLLAMA_MAX_LOADED_MODELS=2',
  'env\tOLLAMA_KEEP_ALIVE=10m',
  'ollama\tOLLAMA_NUM_PARALLEL=2',
  'ollama\tOLLAMA_MAX_LOADED_MODELS=2',
  'ollama\tOLLAMA_KEEP_ALIVE=10m',
].join('\n');

test('a value written but not applied is reported as pending, not as applied', () => {
  const rows = c.tuningReport(HELPER, {});
  const parallel = rows.find((r) => r.key === 'OLLAMA_NUM_PARALLEL')!;
  assert.equal(parallel.configured, '4', 'what .env asks for');
  assert.equal(parallel.running, '2', 'what the container was created with');
  assert.equal(parallel.pending, true, 'and the difference is the whole point');

  const loaded = rows.find((r) => r.key === 'OLLAMA_MAX_LOADED_MODELS')!;
  assert.equal(loaded.pending, false, 'agreeing values are not a pending change');
});

test('an unknown running value is not treated as a difference', () => {
  // Nothing answered for the queue depth — podman absent, or the container
  // never created. "Unknown" is not "changed", and saying so would send
  // somebody to recreate a container to fix nothing.
  const rows = c.tuningReport(HELPER, {});
  const queue = rows.find((r) => r.key === 'OLLAMA_MAX_QUEUE')!;
  assert.equal(queue.configured, null);
  assert.equal(queue.running, null);
  assert.equal(queue.pending, false);
});

test('a running value is only believed from the container that reads the key', () => {
  // perch is passed OLLAMA_NUM_PARALLEL in its own environment in some
  // deployments; it is not what Ollama is running with, and reporting it as
  // such would be a confident wrong answer in the one case being diagnosed.
  const rows = c.tuningReport('env\tOLLAMA_NUM_PARALLEL=4\nperch\tOLLAMA_NUM_PARALLEL=4', {});
  const parallel = rows.find((r) => r.key === 'OLLAMA_NUM_PARALLEL')!;
  assert.equal(parallel.running, null, 'perch cannot answer for Ollama');
  assert.equal(parallel.pending, false);
});

test("perch answers for itself out of its own environment", () => {
  // The console is the perch container, so what it was created with is
  // readable without asking podman anything — and stays readable when the
  // host helper is not answering at all.
  const rows = c.tuningReport('env\tPERCH_MAX_CONCURRENT=6', { PERCH_MAX_CONCURRENT: '4' });
  const row = rows.find((r) => r.key === 'PERCH_MAX_CONCURRENT')!;
  assert.equal(row.configured, '6');
  assert.equal(row.running, '4');
  assert.equal(row.pending, true);
});

test('noise in the helper output is skipped rather than parsed into a value', () => {
  const rows = c.tuningReport([
    'podman: command not found',
    'env\tPATH=/usr/bin',
    'env\tOLLAMA_KV_CACHE_TYPE=',
    'env\tOLLAMA_FLASH_ATTENTION=1',
  ].join('\n'), {});
  assert.equal(rows.find((r) => r.key === 'OLLAMA_KV_CACHE_TYPE')!.configured, null, 'an empty value is not a value');
  assert.equal(rows.find((r) => r.key === 'OLLAMA_FLASH_ATTENTION')!.configured, '1');
  assert.equal(rows.length, Object.keys(c.TUNING_KEYS).length, 'every key is reported, and only the keys');
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
