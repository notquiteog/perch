// Acting on one container rather than on all of them.
//
// The service name on these routes is the difference between restarting
// ComfyUI and restarting everything the machine runs, so the thing worth
// testing is what becomes of a name that is not one of perch's. It has to be
// refused. Quietly falling back to "no name given" — which is what the route
// did while every caller passed nothing — turns a typo in a stop into the
// whole stack going down, reported as success, with nothing in the answer to
// connect the two.
//
// The host helper is not running here, and that is what makes these readable:
// a name that gets past the check reaches the thing that would have acted and
// comes back 503, so 404 and 503 tell apart "refused by name" from "refused
// because there is no helper" without podman being involved at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-container-actions-'));
process.env.PERCH_STATE_DIR = stateDir;
process.env.PERCH_LOG_LEVEL = 'error';

const { buildApi, apiErrorHandler } = await import('./api.js');
const { HttpError } = await import('./http.js');

// The same wiring index.ts uses, minus the static files: the console has no
// password and this connects from loopback, which is what the routes ask for.
const api = buildApi();
const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      const hit = api.match((req.method || 'GET').toUpperCase(), url.pathname);
      if (!hit) throw new HttpError(404, 'no such endpoint');
      await hit.handler({ req, res, params: hit.params, url });
    } catch (err) {
      apiErrorHandler(res, err);
    }
  })();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

async function post(pathname: string, body: unknown): Promise<{ status: number; error: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: parsed.error ?? '' };
}

test('a container perch does not run is refused rather than read as "all of them"', async () => {
  for (const name of ['whisperr', 'ollama-2', 'postgres', '../perch']) {
    const r = await post('/api/containers/stop', { service: name });
    assert.equal(r.status, 404, `${name} must be refused, not stop the whole stack`);
  }
  assert.match((await post('/api/containers/stop', { service: 'whisperr' })).error, /whisperr/,
    'the answer has to name what it did not recognise, or the typo stays invisible');
});

test('a container perch does run gets past the name and reaches the helper', async () => {
  // 503 is as far as anything gets with no helper running, which is the
  // point: it was not the name that stopped it.
  for (const name of ['perch', 'ollama', 'whisper', 'comfy', 'kokoro']) {
    const r = await post('/api/containers/restart', { service: name });
    assert.equal(r.status, 503, `${name} is a container perch runs`);
  }
});

test('an action with no container named is still the whole stack', async () => {
  for (const action of ['start', 'stop', 'restart', 'pull']) {
    assert.equal((await post(`/api/containers/${action}`, {})).status, 503, action);
  }
});

// Rebuilding everything is ./bin/perch update, which also updates the source
// the perch image is built from. Half of that from the console would be an
// update that looks complete and is not, so the route asks for a name.
test('rebuild insists on a container', async () => {
  const bare = await post('/api/containers/rebuild', {});
  assert.equal(bare.status, 400);
  assert.match(bare.error, /bin\/perch update/, 'refusing is only useful if it says what to do instead');
  assert.equal((await post('/api/containers/rebuild', { service: 'comfy' })).status, 503);
});

test('an action that is not one of the five is not passed to the helper', async () => {
  for (const action of ['destroy', 'exec', 'recreate']) {
    assert.equal((await post(`/api/containers/${action}`, { service: 'ollama' })).status, 404, action);
  }
});

test.after(() => {
  server.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
