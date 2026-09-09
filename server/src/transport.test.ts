// Every call that leaves this machine on a caller's behalf carries the
// service's proxy.
//
// ── Why this is a grep and not a mock ─────────────────────────────────────
//
// Because the failure is a line of code rather than a behaviour. A request
// written with plain `fetch`, or with `http.request` and no `agent`, does not
// fail — it SUCCEEDS, and it succeeds by going direct. The operator set
// `socks5h://127.0.0.1:9150` on that service, the console shows the proxy, the
// answer comes back, and the upstream learned this machine's address anyway.
// There is no assertion about the response that catches it, because the
// response is fine.
//
// So the assertion is about the source. Any construction of an outbound
// request under `server/src/` must either thread an agent through or carry an
// exemption naming the reason, which makes the reason reviewable and makes
// adding an unproxied call a deliberate act rather than an omission.
//
// The comment `// transport-exempt: <why>` on the same line or the line above
// is the exemption. `upstream.ts` explains at length why a proxy that will not
// parse is refused rather than ignored; this is the same argument applied to
// the code that forgets to ask for one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));


/**
 * The source tree, found rather than assumed.
 *
 * A guard anchored on its own file's location scans the wrong directory the
 * moment the tests are compiled: `npm test` builds to `dist-test/`, which
 * contains no `.ts` files at all, so `readdirSync(here)` returned an empty
 * list and every check below passed by having nothing to look at. It was green
 * in the suite and red only when run against the sources directly.
 *
 * That is the worst failure mode a guard can have — not wrong, but vacuous —
 * so `sources()` asserts it found something, and this walks up to the real
 * `src` wherever the compiled copy happens to be run from.
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

function sources(): string[] {
  const dir = srcRoot();
  const found = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(dir, f));
  // A guard that scans nothing must fail, not pass.
  assert.ok(found.length > 5, `only ${found.length} sources found under ${dir} — the scan is looking in the wrong place`);
  return found;
}

/** Anything that opens a socket to somewhere else. */
/**
 * Anything that opens a socket, in any library.
 *
 * The last three are here even though perch has no runtime dependencies and so
 * cannot currently use any of them — which is the point. A guard you can step
 * around by reaching for a different library is not a guard, and the moment
 * somebody adds one is exactly the moment they will not think to widen this.
 */
const OUTBOUND = /(?:^|[^.\w])fetch\(|https?\.request\(|\bmod\.request\(|\baxios\b|\bundici\b|\bgot\(/;

const EXEMPT = /\/\/\s*transport-exempt:/;

test('no outbound call is written without a proxy or a stated reason', () => {
  const offenders: string[] = [];
  for (const file of sources()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // A comment is prose about a call, not a call. Several files explain at
      // length why `fetch` cannot take an agent, or which library does what,
      // and flagging those would make the check cry wolf — which is how a
      // check gets deleted rather than fixed.
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      if (!OUTBOUND.test(line)) return;
      // The exemption may sit on the line itself or anywhere in the comment
      // block immediately above it. Only the line above is not enough: the
      // reason for an exemption is usually several sentences, and a rule that
      // forced it onto one line would be a rule that produced worse reasons.
      // The walk stops at the first line that is not a comment, so a comment
      // attached to something else cannot exempt a call below it.
      let context = line;
      for (let j = i - 1; j >= 0; j--) {
        const above = (lines[j] ?? '').trim();
        if (!above.startsWith('//') && !above.startsWith('*') && !above.startsWith('/*')) break;
        context += `\n${above}`;
      }
      if (EXEMPT.test(context)) return;
      // An `agent` on the same line, or anywhere in the request options that
      // follow, counts as threaded. The options object is multi-line, so the
      // window is the next twelve lines rather than the one.
      const window = lines.slice(i, i + 12).join('\n');
      if (/\bagent\b/.test(window)) return;
      offenders.push(`${path.basename(file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], [
    'an outbound call carries neither a proxy agent nor an exemption.',
    'A request written without one does not fail — it goes direct and succeeds,',
    'which is the exact failure the per-service proxy exists to prevent.',
    'Thread the agent through, or add `// transport-exempt: <why>`:',
    ...offenders,
  ].join('\n'));
});

test('every exemption says why, in words', () => {
  // An exemption with no reason is an exemption nobody can review, and the
  // next person to read it will assume it was load-bearing.
  const thin: string[] = [];
  for (const file of sources()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /\/\/\s*transport-exempt:(.*)$/.exec(line);
      if (!m) return;
      if ((m[1] ?? '').trim().length < 25) thin.push(`${path.basename(file)}:${i + 1}`);
    });
  }
  assert.deepEqual(thin, [], `an exemption has no usable reason on it: ${thin.join(', ')}`);
});
