// The catalogue goes stale silently: the tags keep resolving, the numbers keep
// looking plausible, and the recommendation quietly points at a model from two
// generations ago. These tests are the tripwire for that.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-sizing-'));
process.env.PERCH_STATE_DIR = stateDir;
process.env.PERCH_LOG_LEVEL = 'error';

const { MODELS, EMBED_MODELS } = await import('./system.js');

/** What sizing() does, without needing a host-helper status file. */
function recommendFor(vramMb: number): string {
  const usable = vramMb * 1024 * 1024 * 0.9;
  const fits = MODELS.filter((m) => m.needsBytes <= usable).reverse();
  return (fits.find((m) => m.current) ?? fits[0] ?? MODELS[0]!).name;
}

test('a 16 GB card gets a 9B of the current generation, not a bigger older one', () => {
  // The failure this exists to catch: qwen3:14b is larger than qwen3.5:9b and
  // fits, so "largest that fits" would pick the previous generation.
  assert.equal(recommendFor(16311), 'qwen3.5:9b');
});

test('smaller and larger cards get something sensible', () => {
  assert.equal(recommendFor(8192), 'qwen3.5:4b');
  assert.equal(recommendFor(12288), 'qwen3.5:9b');
  assert.equal(recommendFor(24576), 'qwen3.5:27b');
});

test('a machine with no GPU still gets a usable suggestion', () => {
  assert.equal(recommendFor(2048), 'qwen3.5:2b');
});

test('nothing is recommended that cannot also run', () => {
  // needsBytes must exceed the download, or the sizing is promising a model
  // that fits on paper and swaps in practice.
  for (const m of [...MODELS, ...EMBED_MODELS]) {
    assert.ok(m.needsBytes > m.sizeBytes, `${m.name}: needsBytes must exceed the download size`);
  }
});

test('the catalogue is ordered smallest first, which the recommendation relies on', () => {
  for (let i = 1; i < MODELS.length; i += 1) {
    assert.ok(MODELS[i]!.needsBytes >= MODELS[i - 1]!.needsBytes, `${MODELS[i]!.name} is out of order`);
  }
});

test('every entry carries a real tag shape and a note worth reading', () => {
  for (const m of [...MODELS, ...EMBED_MODELS]) {
    assert.match(m.name, /^[a-z0-9.-]+(:[a-z0-9.]+)?$/, `${m.name} is not a plausible Ollama tag`);
    assert.ok(m.note.length > 40, `${m.name} needs a note that says what it is for`);
  }
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
