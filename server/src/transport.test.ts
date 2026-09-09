// Every call that leaves this machine on a caller's behalf carries the
// service's proxy.
//
// ── Why this checks the source rather than a response ─────────────────────
//
// Because the failure is a line of code, not a behaviour. A request written
// with plain `fetch`, or with `http.request` and no `agent`, does not fail —
// it SUCCEEDS, and it succeeds by going direct. The operator set
// `socks5h://127.0.0.1:9150` on that service, the console shows the proxy, the
// answer comes back, and the upstream learned this machine's address anyway.
// No assertion about the response catches it, because the response is fine.
//
// `upstream.ts` already argues that a proxy which will not parse must be
// refused rather than ignored, since falling back to a direct connection would
// succeed and say nothing about it. This is that argument applied to the code
// that forgets to ask for a proxy at all — the same silent success, reached by
// omission instead of by error.
//
// ── Why the syntax tree and not a text scan ───────────────────────────────
//
// A text scan was tried first and immediately cried wolf: the widened pattern
// matched the word "undici" inside the paragraph in `upstream.ts` that
// explains why `fetch` cannot be given an agent. That is not a quirk to skip
// past — this codebase names these calls in prose *precisely where* it is
// describing the bug, so the comments most worth keeping are the ones most
// likely to trip a grep. Skipping comment lines still leaves template literals
// and string constants.
//
// Walking the syntax tree removes the whole class: a call named in a comment
// or quoted in a string is not a CallExpression, so it cannot trip anything
// and no exclusion list has to be maintained. It also makes the check sharper
// rather than merely quieter — the arguments of a call are exactly known, so
// an `agent` belonging to a DIFFERENT call nearby can no longer be read as
// this one's, which a text window could not rule out at any size.
//
// ── A guard must not pass by finding nothing ──────────────────────────────
//
// The first version of this passed while scanning an empty directory: `npm
// test` compiles to `dist-test/`, which holds no `.ts` at all, and the scan was
// anchored on its own file's location. Green in the suite, red only when run
// against the sources directly. Vacuous is worse than wrong, because it is
// indistinguishable from passing.
//
// The scan root was one hole. The match set is the other, and it survives
// fixing the first: if `isOutbound` stops matching, the walk finds nothing and
// every check below passes on an empty list, in exactly the same silent
// direction. So this asserts three things about ITSELF before it asserts
// anything about the code — that it found the sources, that it found a
// plausible number of calls, and that it found the ones that are certainly
// there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';
import ts from 'typescript';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/**
 * The source tree, found rather than assumed.
 *
 * Walked up to, so the compiled copy running from `dist-test/` scans the same
 * files as a direct run. See the header on why that mattered.
 */
function srcRoot(): string {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (path.basename(dir) === 'src') return dir;
    const candidate = path.join(dir, 'src');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`cannot find the source tree to scan, starting from ${here}`);
}

/** Callees that open a socket to somewhere else. */
function isOutbound(callee: string): boolean {
  return /(?:^|\.)fetch$/.test(callee)
    || /(?:^|\.)request$/.test(callee)
    // Here even though perch has no runtime dependencies and so cannot use any
    // of these — which is the point. A guard you can step around by reaching
    // for a different library is not a guard, and the moment somebody adds one
    // is the moment they will not think to widen this.
    || /^(axios|undici|got)(\.|$)/.test(callee);
}

interface Call {
  file: string;
  line: number;
  callee: string;
  /** The arguments, and only the arguments. Never a window of nearby text. */
  args: string;
  leading: string;
}

function callsIn(file: string): Call[] {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Call[] = [];

  /** The comment block above the statement this call sits in. */
  const leadingOf = (node: ts.Node): string => {
    let n: ts.Node = node;
    while (n.parent && !ts.isSourceFile(n.parent) && !ts.isBlock(n.parent)) n = n.parent;
    const ranges = ts.getLeadingCommentRanges(text, n.getFullStart()) ?? [];
    return ranges.map((r) => text.slice(r.pos, r.end)).join('\n');
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (isOutbound(callee)) {
        found.push({
          file: path.basename(file),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          callee,
          args: node.arguments.map((a) => a.getText(sf)).join(', '),
          leading: leadingOf(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * The files to scan — and the floor, checked here rather than beside here.
 *
 * The floors used to live in a test of their own, which every other check then
 * leaned on. That is a watcher, and a watcher is something a later edit can
 * delete or weaken without the checks it was protecting saying anything: they
 * would go straight back to reporting clean on an empty list. Inside the
 * helper the property is structural — every caller inherits it, and there is
 * no arrangement of the tests that gets a caller an unchecked empty list.
 *
 * The floor is far under the real figure (24 files when this was written), so
 * ordinary edits never approach it and a scan looking in the wrong place
 * cannot creep past it.
 */
function sources(): string[] {
  const dir = srcRoot();
  const found = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(dir, f));
  assert.ok(found.length >= 15, `only ${found.length} sources under ${dir} — the scan is looking in the wrong place, and every check that reads this would report clean on it`);
  return found;
}

const EXEMPT = /transport-exempt:/;

/**
 * Every outbound call in the scanned tree, with the same floor applied for the
 * same reason.
 *
 * A correct scan root does not save a dead match set: if `isOutbound` stops
 * matching, this returns an empty list and every filter over it is empty too,
 * which is exactly what "no problems" looks like. Naming two files that
 * certainly contain a call catches the case where the walk is finding the
 * wrong kind of node rather than none at all.
 */
function everyCall(): Call[] {
  const calls = sources().flatMap(callsIn);
  assert.ok(calls.length >= 6, `only ${calls.length} outbound calls found — the match set has stopped matching, and every check that reads this would report clean on it`);
  const seen = new Set(calls.map((c) => c.file));
  for (const expected of ['proxy.ts', 'upstream.ts']) {
    assert.ok(seen.has(expected), `no outbound call found in ${expected}, which certainly has one — the walk is finding the wrong kind of node`);
  }
  return calls;
}

test('the scan can actually see the code it is checking', () => {
  // The floors themselves live in `sources` and `everyCall`, so every check
  // in this file inherits them and none of them can be left reading an empty
  // list. This states the property out loud and fails first when it breaks —
  // it is the sentence a reader needs, not the mechanism.
  assert.ok(everyCall().length > 0);
});

test('no outbound call is written without a proxy or a stated reason', () => {
  const offenders = everyCall()
    .filter((c) => !EXEMPT.test(c.leading))
    // `agent` in the call's OWN arguments. Not a window: an agent belonging to
    // a different call nearby is not this one's.
    .filter((c) => !/\bagent\b/.test(c.args))
    .map((c) => `${c.file}:${c.line}  ${c.callee}(…)`);

  assert.deepEqual(offenders, [], [
    'an outbound call carries neither a proxy agent nor an exemption.',
    'Written without one it does not fail — it goes direct and succeeds, which',
    'is the exact failure the per-service proxy exists to prevent.',
    'Thread the agent through, or add `// transport-exempt: <why>`:',
    ...offenders,
  ].join('\n'));
});

test('every exemption says why, in words', () => {
  // An exemption with no reason is one nobody can review, and the next person
  // to read it will assume it was load-bearing.
  const exempted = everyCall().filter((c) => EXEMPT.test(c.leading));
  // The positive control, and it is not decoration. Without it this check
  // passes when `EXEMPT` stops matching, when `leading` stops finding the
  // comment block, and when nothing was scanned at all — because in every one
  // of those cases the list below is empty and an empty list is what "clean"
  // looks like. Any assertion whose expected result is absence is
  // indistinguishable from not running unless something in the same test
  // proves it ran.
  assert.ok(exempted.length >= 3, `only ${exempted.length} exemptions found, and this repository has four — the exemption scan has stopped working, and this check would report clean on that`);

  const thin = exempted
    .filter((c) => (/transport-exempt:([\s\S]*)/.exec(c.leading)?.[1] ?? '').replace(/\/\/|\s+/g, ' ').trim().length < 40)
    .map((c) => `${c.file}:${c.line}`);
  assert.deepEqual(thin, [], `an exemption has no usable reason on it: ${thin.join(', ')}`);
});

test('prose and strings are not calls, and real calls beside them still are', () => {
  // The false-positive class the text scan had, asserted rather than assumed:
  // both decoy shapes appear in this repository for real, which is the whole
  // reason the walk replaced the grep.
  //
  // The decoys and the real calls share one fixture ON PURPOSE, and the
  // assertion names exactly which lines come back. Testing the decoys alone
  // would be an assertion that a list is empty — which is also what happens if
  // the file was never written, if `callsIn` throws nothing and finds nothing,
  // or if the walk stopped recognising calls entirely. Absence cannot tell
  // those apart from success. Together, neither half can pass by absence: if
  // the scan never read the file the real calls are missing, and if a decoy
  // trips there is an extra one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-guard-'));
  const file = path.join(dir, 'sample.ts');
  try {
    fs.writeFileSync(file, [
      '// `fetch` cannot be given an http.Agent; its dispatcher is undici’s.',   // 1
      'const doc = `call http.request({ agent }) to reach it`;',                 // 2
      "const name = 'fetch(';",                                                  // 3
      'export async function real(u: string) { return fetch(u); }',              // 4
      "export function realToo() { return http.request({ host: 'x' }); }",       // 5
    ].join('\n'));
    assert.deepEqual(
      callsIn(file).map((c) => `${c.line}:${c.callee}`),
      ['4:fetch', '5:http.request'],
      'the decoys on lines 1-3 must not be read as calls, and the real ones on 4-5 must be',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
