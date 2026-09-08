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
  const sd = c.containerSizes().find((r) => r.id === 'sd')!;
  assert.equal(sd.configuredMem, null);
  assert.equal(sd.known, false, 'the console must be able to say it is showing the default');
  assert.equal(sd.defaultMem, '12g');
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

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
