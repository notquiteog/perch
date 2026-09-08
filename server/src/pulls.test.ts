// The two things about a download that were wrong before it became a job:
// the percentage, and what happened to it when the page went away.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PERCH_LOG_LEVEL = 'error';

const { cancelPull, getPull, listPulls, resetPulls, startPull, watchPull } = await import('./pulls.js');
type Emit = Parameters<Parameters<typeof startPull>[1]>[0];

const settled = async (name: string) => {
  for (let i = 0; i < 200; i += 1) {
    const v = getPull(name);
    if (v && v.state !== 'running') return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('never settled');
};

test('progress is the sum of every layer, not whichever one is current', async () => {
  resetPulls();
  let emit!: Emit;
  let release!: () => void;
  startPull('a:1', async (e) => { emit = e; await new Promise<void>((r) => { release = r; }); });
  await new Promise((r) => setTimeout(r, 5));
  emit({ status: 'pulling manifest' });
  // Nothing sized yet: no percentage rather than a made-up zero.
  assert.equal(getPull('a:1')!.pct, null);
  emit({ status: 'pulling aaa', digest: 'aaa', total: 100, completed: 100 });
  assert.equal(getPull('a:1')!.pct, 100);
  // A second layer starts. The old bar reported this as 0% because it only
  // looked at the line in front of it; the sum says 100 of 400.
  emit({ status: 'pulling bbb', digest: 'bbb', total: 300, completed: 0 });
  const v = getPull('a:1')!;
  assert.equal(v.total, 400);
  assert.equal(v.completed, 100);
  assert.equal(v.pct, 25);
  release();
  assert.equal((await settled('a:1')).state, 'done');
});

test('a layer never goes backwards when its final size is re-sent', async () => {
  resetPulls();
  let emit!: Emit;
  startPull('b:1', async (e) => { emit = e; await new Promise((r) => setTimeout(r, 30)); });
  await new Promise((r) => setTimeout(r, 5));
  emit({ digest: 'x', total: 100, completed: 80 });
  emit({ digest: 'x', total: 100, completed: 40 });
  assert.equal(getPull('b:1')!.completed, 80);
  await settled('b:1');
});

test('a download outlives everyone watching it', async () => {
  resetPulls();
  let emit!: Emit;
  startPull('c:1', async (e) => { emit = e; await new Promise((r) => setTimeout(r, 40)); });
  await new Promise((r) => setTimeout(r, 5));
  const seen: number[] = [];
  const detach = watchPull('c:1', (v) => { if (v.pct !== null) seen.push(v.pct); })!;
  emit({ digest: 'x', total: 10, completed: 5 });
  detach();
  emit({ digest: 'x', total: 10, completed: 10 });
  assert.deepEqual(seen, [50], 'a detached watcher stops hearing');
  assert.equal(getPull('c:1')!.completed, 10, 'but the job carries on');
  assert.equal((await settled('c:1')).state, 'done');
});

test('watching an already-running job replays where it is at once', async () => {
  resetPulls();
  let emit!: Emit;
  startPull('d:1', async (e) => { emit = e; await new Promise((r) => setTimeout(r, 40)); });
  await new Promise((r) => setTimeout(r, 5));
  emit({ status: 'pulling', digest: 'x', total: 8, completed: 4 });
  let first: { pct: number | null; state: string } | null = null;
  watchPull('d:1', (v) => { first ??= v; });
  assert.equal(first!.pct, 50);
  assert.equal(first!.state, 'running');
  await settled('d:1');
});

test('asking for the same model twice attaches rather than downloading it twice', async () => {
  resetPulls();
  let runs = 0;
  const run = async (): Promise<void> => { runs += 1; await new Promise((r) => setTimeout(r, 30)); };
  startPull('e:1', run);
  startPull('e:1', run);
  assert.equal(runs, 1);
  assert.equal(listPulls().length, 1);
  await settled('e:1');
});

test('a cancel is the only thing that stops one', async () => {
  resetPulls();
  startPull('f:1', async (_e, signal) => {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 5000);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    });
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cancelPull('f:1'), true);
  assert.equal(getPull('f:1')!.state, 'cancelled');
  assert.equal(cancelPull('f:1'), false, 'cancelling what is not running is false, not an error');
});

test('a failure is kept, so a console that reconnects is told why', async () => {
  resetPulls();
  startPull('g:1', async () => { throw new Error('registry said no'); });
  const v = await settled('g:1');
  assert.equal(v.state, 'error');
  assert.equal(v.error, 'registry said no');
  assert.equal(listPulls().some((p) => p.name === 'g:1'), true);
  resetPulls();
});
