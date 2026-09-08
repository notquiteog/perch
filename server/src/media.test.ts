// The image, video and audio catalogue.
//
// The catalogue is the part of this that goes stale silently: the sizes stay
// plausible, the notes stay readable, and the URLs quietly stop resolving —
// and nobody finds out until a 17 GB download 404s an hour in. Nothing here
// can check the network, so what it checks instead is everything that would
// make such a failure worse: that the sizes agree with the files they are
// made of, that every file has somewhere to go, and that the console cannot
// claim a model is installed on the strength of half of it being there.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every test gets its own state directory. Without one, config.stateDir falls
// back to /var/lib/perch — the real one on a developer's machine — so the
// suite reads that install's settings and, worse, can reach its running host
// helper: a test asking what the speech model is got a real answer from a
// real container. Tests must not be able to drive the machine they run on.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-media-test-'));
process.env.PERCH_STATE_DIR = stateDir;

process.env.PERCH_LOG_LEVEL = 'error';
process.env.PERCH_SERVICES = 'chat,image';

// A stand-in Stable Diffusion: /internal/ping to say it is up, and the
// checkpoint list, which is the only way the console learns what is there.
let checkpoints: Array<{ title: string; model_name: string; filename: string }> = [];
const upstream = http.createServer((req, res) => {
  if (req.url === '/internal/ping') { res.writeHead(200); res.end('{}'); return; }
  if (req.url === '/sdapi/v1/sd-models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(checkpoints));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const port = (upstream.address() as { port: number }).port;
process.env.PERCH_SD_URL = `http://127.0.0.1:${port}`;
// Nothing listens here, which is what a service that is switched on but still
// unpacking its image looks like.
process.env.PERCH_COMFY_URL = 'http://127.0.0.1:1';

const media = await import('./media.js');

test('every entry is complete enough to put on a page', () => {
  const ids = new Set<string>();
  for (const m of media.MEDIA_MODELS) {
    assert.ok(!ids.has(m.id), `${m.id} is listed twice`);
    ids.add(m.id);
    assert.match(m.id, /^[a-z0-9][a-z0-9.-]*$/, `${m.id} has to be usable as a command argument`);
    assert.ok(m.note.length > 40, `${m.id} needs a note that says what it is for`);
    assert.ok(m.needsBytes > 0, `${m.id} has no memory figure, so nothing can say whether it fits`);
  }
});

test('the stated download is the sum of the files it is made of', () => {
  for (const m of media.MEDIA_MODELS) {
    if (m.bundled) continue;
    assert.ok(m.files.length > 0, `${m.id} is not bundled, so it must say what to fetch`);
    const sum = m.files.reduce((n, f) => n + f.bytes, 0);
    // Within 10 MB: the entries are written to two decimal places of a
    // gigabyte, and the point is to catch a file added without its size being
    // added to the total, not to police rounding.
    assert.ok(Math.abs(sum - m.sizeBytes) < 1e7, `${m.id} says ${m.sizeBytes} but its files add up to ${sum}`);
  }
});

test('every file has a real address and a directory to land in', () => {
  for (const m of media.MEDIA_MODELS) {
    for (const f of m.files) {
      assert.match(f.url, /^https:\/\//, `${m.id} must fetch over https`);
      assert.ok(f.dest.includes('/'), `${m.id} puts ${f.dest} at the root of the volume, where no backend looks for it`);
      assert.ok(!f.dest.includes('..'), `${m.id} has a destination that climbs out of the volume`);
      assert.ok(f.bytes > 1e6, `${m.id} claims ${f.dest} is ${f.bytes} bytes, which is not a model`);
    }
  }
});

// A model is only useful if the container that runs it has somewhere to keep
// it. Getting this wrong means `perch fetch` writing a file into a volume
// nothing reads.
test('anything fetchable belongs to a service with a model store', () => {
  for (const m of media.MEDIA_MODELS) {
    if (m.bundled) continue;
    const store = media.MODEL_VOLUMES[m.service];
    assert.ok(store, `${m.id} runs on the ${m.service} service, which has nowhere to put weights`);
  }
});

test('a live backend reports what it can see, and only that', async () => {
  checkpoints = [{ title: 'v1-5-pruned-emaonly.safetensors [abc]', model_name: 'v1-5-pruned-emaonly', filename: '/models/Stable-diffusion/v1-5-pruned-emaonly.safetensors' }];
  const status = await media.mediaStatus('image');
  assert.equal(status.ok, true);
  assert.deepEqual(status.installed, ['v1-5-pruned-emaonly.safetensors']);

  const sd15 = media.MEDIA_MODELS.find((m) => m.id === 'sd15')!;
  const turbo = media.MEDIA_MODELS.find((m) => m.id === 'sdxl-turbo')!;
  assert.equal(media.isInstalled(sd15, status), true);
  assert.equal(media.isInstalled(turbo, status), false);
});

// The one that matters for a multi-file model: LTX-Video is a checkpoint and
// a text encoder, and it does not run with one of them. Calling that
// "installed" sends somebody to debug a workflow instead of finishing a
// download.
test('a model with a file missing is not installed', async () => {
  const ltx = media.MEDIA_MODELS.find((m) => m.id === 'ltxv-2b')!;
  const half = { ...(await media.mediaStatus('image')), ok: true, installed: [ltx.files[0]!.dest.split('/').pop()!] };
  assert.equal(media.isInstalled(ltx, half), false);
  const whole = { ...half, installed: ltx.files.map((f) => f.dest.split('/').pop()!) };
  assert.equal(media.isInstalled(ltx, whole), true);
});

test('a service that is off says so rather than looking broken', async () => {
  // 'video' is not in PERCH_SERVICES for this test run.
  const status = await media.mediaStatus('video');
  assert.equal(status.enabled, false);
  assert.equal(status.ok, false);
  assert.equal(status.starting, false);
  assert.match(status.error!, /not switched on/);
  assert.deepEqual(status.installed, []);
});

// Nothing is installed until the backend answers, and a backend that has
// never answered is usually one still unpacking several gigabytes of image.
// Guessing "installed" from a cached list would tell somebody to go looking
// for a fault that does not exist.
test('nothing is installed while the backend is unreachable', async () => {
  const model = media.MEDIA_MODELS.find((m) => m.id === 'sd15')!;
  const down = { ...(await media.mediaStatus('image')), ok: false, installed: [model.files[0]!.dest.split('/').pop()!] };
  assert.equal(media.isInstalled(model, undefined), false);
  assert.equal(media.isInstalled(model, down), false, 'a stale list from a backend that is not answering is not evidence');
});

test.after(() => { upstream.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
