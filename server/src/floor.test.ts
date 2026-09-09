// The floor is written down in three places, and they can disagree silently.
//
// ── Why this is a source scan ──────────────────────────────────────────────
//
// `FLOOR_BYTES` in system.ts, `FLOOR_MB` in install.sh and the table in
// docs/TERN.md are the same decision expressed three times, because they are
// read at three different moments: by the console at runtime, by the installer
// before any TypeScript exists to ask, and by a person choosing a model. There
// is no shared value they can all import.
//
// Drift between them does not fail. The installer recommends one model, the
// console sizes for another, and the docs name a third — each internally
// consistent, each answering as if it were the only one. The operator only
// finds out when a client's features quietly do not work, which is the exact
// failure the floor exists to prevent. So the check has to read the other two
// files as text and compare.
//
// ── A guard must not pass by finding nothing ──────────────────────────────
//
// Two ways this could go vacuous, and fixing the first does not fix the
// second: the scan could be anchored somewhere with no install.sh in it (the
// suite runs from `dist-test/`, so the tree is walked up to, not assumed), and
// the patterns could stop matching a file that has been reformatted. Both are
// asserted rather than assumed — the root is found or it throws, and every
// pattern must actually hit before its result is trusted.
//
// The absence assertion — "no bare floor literal is left in install.sh" — is
// the one that most needs help, because an empty result is what "clean",
// "scanned the wrong file" and "pattern died" all look like. It gets a
// positive control in the same test: a fixture carrying both a bare literal
// and a correctly written `$FLOOR_MB` reference, asserting exactly which comes
// back. The correctly-written half is the important one — a scanner reading
// too loosely would flag it, and a scanner reading nothing would report both
// halves clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-floor-'));
process.env.PERCH_STATE_DIR = stateDir;
process.env.PERCH_LOG_LEVEL = 'error';

const { MODELS, EMBED_MODELS, FLOOR_CHAT, FLOOR_EMBED, FLOOR_BYTES } = await import('./system.js');

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** The repository, found rather than assumed — see the header. */
function repoRoot(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'install.sh'))
      && fs.existsSync(path.join(dir, 'docs', 'TERN.md'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`cannot find the repository to scan, starting from ${here}`);
}

/** Read a file that must exist and must not be empty. */
function readReal(rel: string): string {
  const full = path.join(repoRoot(), rel);
  const text = fs.readFileSync(full, 'utf8');
  assert.ok(text.length > 500, `${rel} is too short to have been read properly`);
  return text;
}

test('the floor names models that exist, and marks exactly those', () => {
  const byName = new Map(MODELS.map((m) => [m.name, m]));
  for (const name of FLOOR_CHAT) {
    const m = byName.get(name);
    assert.ok(m, `FLOOR_CHAT names ${name}, which is not in the catalogue`);
    assert.equal(m.floor, true, `${name} is the floor but is not marked floor: true`);
  }
  // The other direction, so a model cannot be quietly promoted by adding a
  // flag without saying so in FLOOR_CHAT.
  const marked = MODELS.filter((m) => m.floor).map((m) => m.name).sort();
  assert.deepEqual(marked, [...FLOOR_CHAT].sort(),
    'the models marked floor: true and the FLOOR_CHAT list have drifted apart');
});

test('the embedding floor exists and is marked', () => {
  const m = EMBED_MODELS.find((x) => x.name === FLOOR_EMBED);
  assert.ok(m, `FLOOR_EMBED names ${FLOOR_EMBED}, which is not in EMBED_MODELS`);
  assert.equal(m.floor, true, `${FLOOR_EMBED} is the embedding floor but is not marked`);
  const marked = EMBED_MODELS.filter((x) => x.floor).map((x) => x.name);
  assert.deepEqual(marked, [FLOOR_EMBED], 'more than one embedding model claims to be the floor');
});

test('FLOOR_BYTES is derived from the catalogue, not typed in beside it', () => {
  const expected = Math.min(...MODELS.filter((m) => m.floor).map((m) => m.needsBytes));
  assert.equal(FLOOR_BYTES, expected);
  // And it is the smaller of the two, not the larger — a floor that quoted the
  // bigger model would tell a 10 GB card it cannot reach a floor it can.
  assert.ok(FLOOR_BYTES <= Math.max(...MODELS.filter((m) => m.floor).map((m) => m.needsBytes)));
});

test('the installer and the catalogue agree about the floor', () => {
  const sh = readReal('install.sh');

  const floorMb = /^FLOOR_MB=(\d+)/m.exec(sh);
  assert.ok(floorMb, 'install.sh no longer defines FLOOR_MB — the guard cannot see the floor');
  const embedMb = /^FLOOR_EMBED_MB=(\d+)/m.exec(sh);
  assert.ok(embedMb, 'install.sh no longer defines FLOOR_EMBED_MB');

  // Rounding, not equality: FLOOR_BYTES is bytes computed from a GB figure and
  // FLOOR_MB is the round number a shell script can carry. Anything inside
  // 100 MB is the same decision; anything outside it is drift.
  const fromTs = FLOOR_BYTES / 1e6;
  assert.ok(Math.abs(Number(floorMb[1]) - fromTs) < 100,
    `install.sh says FLOOR_MB=${floorMb[1]}, system.ts computes ${Math.round(fromTs)}`);

  const embedNeeds = EMBED_MODELS.find((m) => m.name === FLOOR_EMBED)!.needsBytes / 1e6;
  assert.ok(Math.abs(Number(embedMb[1]) - embedNeeds) < 100,
    `install.sh says FLOOR_EMBED_MB=${embedMb[1]}, the catalogue says ${Math.round(embedNeeds)}`);
});

/**
 * Places in install.sh that compare against the floor with a bare number
 * instead of `$FLOOR_MB`. Returns the offending lines.
 *
 * Deliberately narrow: it looks for the floor's own value written as a literal
 * in arithmetic or a comparison, which is how it was written before it had a
 * name, and how it will be written again by anyone who does not know the name
 * exists. A `FLOOR_MB=9400` assignment is the definition and is not a finding.
 */
function bareFloorLiterals(sh: string, mb: number): string[] {
  const out: string[] = [];
  for (const line of sh.split('\n')) {
    if (new RegExp(`^\\s*FLOOR(_EMBED)?_MB=`).test(line)) continue;
    if (line.trimStart().startsWith('#')) continue;
    if (new RegExp(`(\\$\\(\\(|-lt|-ge|-gt|-le)[^#]*\\b${mb}\\b`).test(line)) out.push(line.trim());
  }
  return out;
}

test('the floor is not written as a bare number anywhere in the installer', () => {
  const mb = Math.round(FLOOR_BYTES / 1e6 / 100) * 100; // 9400

  // ── Positive control, in the same test so it cannot be deleted separately ──
  // One fixture, both halves. The correctly-written line is the one that
  // catches a scanner reading too loosely; the bare one catches a scanner that
  // has stopped reading at all. Asserting exactly which comes back
  // distinguishes "clean" from "not looking".
  const fixture = [
    '  [ "$USABLE_MB" -lt $(( need + 9400 )) ] || return 0',      // must be found
    '  [ "$USABLE_MB" -lt $(( need + FLOOR_MB )) ] || return 0',  // must NOT be found
    'FLOOR_MB=9400',                                              // the definition
    '# a chat model wants about 9400 MB',                         // prose
  ].join('\n');
  const caught = bareFloorLiterals(fixture, mb);
  assert.deepEqual(caught, ['[ "$USABLE_MB" -lt $(( need + 9400 )) ] || return 0'],
    'the scanner no longer distinguishes a bare floor literal from a named one');

  // ── The real file ──
  const found = bareFloorLiterals(readReal('install.sh'), mb);
  assert.deepEqual(found, [],
    `install.sh compares against the floor by literal instead of $FLOOR_MB:\n${found.join('\n')}`);
});

test('the documented table names the floor models as the floor', () => {
  const doc = readReal('docs/TERN.md');
  for (const name of FLOOR_CHAT) {
    assert.ok(doc.includes(name), `docs/TERN.md does not mention ${name}`);
  }
  assert.ok(doc.includes(FLOOR_EMBED), `docs/TERN.md does not mention ${FLOOR_EMBED}`);
  // The word has to be doing work in the table, not only in a heading — the
  // rows are what somebody choosing a model actually reads.
  const rows = doc.split('\n').filter((l) => l.startsWith('|') && /floor/i.test(l));
  assert.ok(rows.length >= 2,
    'docs/TERN.md has fewer than two table rows calling a model the floor');
  for (const name of FLOOR_CHAT) {
    assert.ok(rows.some((r) => r.includes(name)),
      `docs/TERN.md has no table row marking ${name} as the floor`);
  }
});

test('the ceiling is documented too, so the floor is not read as a target', () => {
  // The floor is the easy half to write and the easy half to over-apply. If
  // nothing says frontier models are a first-class target, "tested against
  // gemma4:12b" quietly becomes "designed for gemma4:12b".
  const doc = readReal('docs/TERN.md');
  assert.match(doc, /thinking/i, 'docs/TERN.md does not mention thinking models');
  assert.match(readReal('README.md'), /PERCH_CHAT_UPSTREAM_API/,
    'the README no longer says a hosted frontier model can be fronted');
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
