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

const { MODELS, EMBED_MODELS, UNCENSORED_MODELS } = await import('./system.js');

/** What sizing() does, without needing a host-helper status file. */
function recommendFor(vramMb: number): string {
  const usable = vramMb * 1024 * 1024 * 0.9;
  const fits = MODELS.filter((m) => m.needsBytes <= usable).reverse();
  return (fits.find((m) => m.current) ?? fits[0] ?? MODELS[0]!).name;
}

test('a 16 GB card gets the current generation, not a bigger older one', () => {
  // Two failures this guards against, both of which pick the wrong model by
  // being larger: a previous-generation build that merely fits, and a nested
  // build whose file is bigger than a true 12B while only ~4B of it works.
  assert.equal(recommendFor(16311), 'gemma4:12b');
});

test('smaller and larger cards get something sensible', () => {
  assert.equal(recommendFor(8192), 'qwen3.5:4b');
  assert.equal(recommendFor(12288), 'gemma4:12b');
  assert.equal(recommendFor(24576), 'qwen3.8:27b');
  assert.equal(recommendFor(32768), 'gemma4:31b');
});

test('a machine with no GPU still gets a usable suggestion', () => {
  assert.equal(recommendFor(2048), 'qwen3.5:2b');
});

test('nested builds are listed but never recommended', () => {
  // gemma4:e4b is a 9.6 GB file with about 4B parameters active, and
  // gemma4:12b is a true 12B in 7.6 GB. Recommending by size would take the
  // worse model, so the nested ones must never be marked current.
  for (const m of MODELS.filter((x) => x.params.includes('effective'))) {
    assert.ok(!m.current, `${m.name} is a nested build and must not be marked current`);
  }
  for (const mb of [8192, 12288, 16311, 24576, 32768]) {
    assert.ok(!recommendFor(mb).includes(':e'), `${mb} MB should not land on a nested build`);
  }
});

test('a true 12B beats a nested build that has a bigger file', () => {
  const dense = MODELS.find((m) => m.name === 'gemma4:12b')!;
  const nested = MODELS.find((m) => m.name === 'gemma4:e4b')!;
  assert.ok(dense.sizeBytes < nested.sizeBytes, 'the premise of this trap has changed — recheck the catalogue');
  assert.ok(dense.current && !nested.current);
});

test('uncensored variants are never recommended by default', () => {
  // They are a choice, not a default: nothing in the sizing path may reach
  // them, so no card size can silently land on one.
  const names = new Set(MODELS.map((m) => m.name));
  for (const m of UNCENSORED_MODELS) {
    assert.ok(!names.has(m.name), `${m.name} must not be in the recommendable list`);
  }
  for (const mb of [2048, 8192, 12288, 16311, 24576, 49152]) {
    assert.ok(!recommendFor(mb).includes('abliterated'), `${mb} MB should not recommend an abliterated model`);
  }
});

test('nothing is recommended that cannot also run', () => {
  // needsBytes must exceed the download, or the sizing is promising a model
  // that fits on paper and swaps in practice.
  for (const m of [...MODELS, ...EMBED_MODELS, ...UNCENSORED_MODELS]) {
    assert.ok(m.needsBytes > m.sizeBytes, `${m.name}: needsBytes must exceed the download size`);
  }
});

test('the catalogue is ordered smallest first, which the recommendation relies on', () => {
  for (let i = 1; i < MODELS.length; i += 1) {
    assert.ok(MODELS[i]!.needsBytes >= MODELS[i - 1]!.needsBytes, `${MODELS[i]!.name} is out of order`);
  }
});

test('every entry carries a real tag shape and a note worth reading', () => {
  for (const m of [...MODELS, ...EMBED_MODELS, ...UNCENSORED_MODELS]) {
    // Namespaced tags (huihui_ai/…) are as valid as library ones.
    // namespace/name:tag — tags carry hyphens too (35b-a3b, gemma-4-abliterated).
    assert.match(m.name, /^([A-Za-z0-9_-]+\/)?[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)?$/, `${m.name} is not a plausible Ollama tag`);
    assert.ok(m.note.length > 40, `${m.name} needs a note that says what it is for`);
  }
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
