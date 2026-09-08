// What the Models page is allowed to believe.
//
// Two things used to be taken on trust and should not have been: that a 200
// from /api/delete meant the model was gone, and that a failure to list meant
// there was nothing to list. Both produced a page that was confidently wrong
// about the machine it was describing.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What the stand-in Ollama currently has. Tests move this around. */
let tags: Array<{ name: string; size: number }> = [];
/** Set to make /api/tags fail the way an Ollama that is down does. */
let listBroken = false;
/** Set to accept a delete without acting on it, which real proxies do. */
let deleteIsALie = false;
const seen: string[] = [];

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push(`${req.method} ${req.url}`);
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/api/version') { json(200, { version: '0.12.0' }); return; }
    if (req.url === '/api/ps') { json(200, { models: [] }); return; }
    if (req.url === '/api/tags') {
      if (listBroken) { res.writeHead(500); res.end('nope'); return; }
      json(200, { models: tags });
      return;
    }
    if (req.url === '/api/delete') {
      const asked = (() => { try { return JSON.parse(body) as { model?: string; name?: string }; } catch { return {}; } })();
      const wanted = asked.model ?? asked.name ?? '';
      if (!deleteIsALie) tags = tags.filter((m) => m.name !== wanted && m.name !== `${wanted}:latest`);
      json(200, { ok: true });
      return;
    }
    if (req.url === '/api/generate') { json(200, { ok: true }); return; }
    res.writeHead(404); res.end('{}');
  });
});

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-models-test-'));
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const port = (upstream.address() as { port: number }).port;

process.env.PERCH_STATE_DIR = stateDir;
process.env.PERCH_OLLAMA_URL = `http://127.0.0.1:${port}`;
process.env.PERCH_LOG_LEVEL = 'error';

const ollama = await import('./ollama.js');

test('a delete is believed only once the model list agrees', async () => {
  tags = [{ name: 'gemma3:1b', size: 1 }, { name: 'qwen3.5:4b', size: 2 }];
  deleteIsALie = false;
  const after = await ollama.deleteModel('gemma3:1b');
  assert.deepEqual(after.map((m) => m.name), ['qwen3.5:4b'], 'the answer is the list, not the status code');
});

test('an accepted delete that changed nothing is reported, not celebrated', async () => {
  tags = [{ name: 'gemma3:1b', size: 1 }];
  deleteIsALie = true;
  await assert.rejects(() => ollama.deleteModel('gemma3:1b'), /still on this machine/);
  deleteIsALie = false;
});

// `ollama rm gemma3:1b` removes the model stored as `gemma3:1b:latest`. A
// literal name comparison would say the model is still there and refuse a
// deletion that in fact worked.
test('a name that differs only by :latest is the same model', async () => {
  tags = [{ name: 'phi4-mini:latest', size: 1 }];
  deleteIsALie = false;
  const after = await ollama.deleteModel('phi4-mini');
  assert.deepEqual(after, []);
  assert.equal(ollama.sameModel('phi4-mini', 'phi4-mini:latest'), true);
  assert.equal(ollama.sameModel('qwen3.5:4b', 'qwen3.5:9b'), false);
  assert.equal(ollama.sameModel('', 'phi4-mini'), false);
});

test('a resident model is dropped from memory before its files go', async () => {
  tags = [{ name: 'gemma3:1b', size: 1 }];
  seen.length = 0;
  await ollama.deleteModel('gemma3:1b');
  assert.equal(seen[0], 'POST /api/generate', 'unload first, or the freed disk leaves the RAM still held');
  assert.ok(seen.includes('DELETE /api/delete'));
});

test('an Ollama that will not list is a failure, not an empty machine', async () => {
  tags = [{ name: 'gemma3:1b', size: 1 }];
  listBroken = true;
  const live = await ollama.liveModels();
  listBroken = false;
  assert.equal(live.ok, false);
  assert.equal(live.installed.length, 0);
  assert.ok(live.error, 'the reason has to survive, or the page says "no models"');
});

test('a working Ollama reports its version alongside the list', async () => {
  tags = [{ name: 'gemma3:1b', size: 1 }];
  const live = await ollama.liveModels();
  assert.equal(live.ok, true);
  assert.equal(live.version, '0.12.0');
  assert.deepEqual(live.installed.map((m) => m.name), ['gemma3:1b']);
});

test.after(() => {
  upstream.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
