// Loading and unloading models, and the asymmetry that bit us: an embedding
// model has no generate endpoint, so the idiom for "load this and hold it"
// does not work on it. Pressing Load on all-minilm produced an unhandled
// error until this was handled.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface Seen { path: string; body: string }
const seen: Seen[] = [];

// A stand-in Ollama that refuses /api/generate for embedding models exactly
// the way the real one does.
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ path: req.url!, body });
    const model = (() => { try { return JSON.parse(body).model as string; } catch { return ''; } })();
    if (req.url === '/api/generate' && model.startsWith('all-minilm')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `"${model}" does not support generate` }));
      return;
    }
    // Any other failure — a model that simply is not there — must not be
    // mistaken for the embedding case and retried on a different endpoint.
    if (model.startsWith('nonexistent')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `model "${model}" not found` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-ollama-test-'));
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const port = (upstream.address() as { port: number }).port;

process.env.PERCH_STATE_DIR = stateDir;
process.env.PERCH_OLLAMA_URL = `http://127.0.0.1:${port}`;
process.env.PERCH_LOG_LEVEL = 'error';

const ollama = await import('./ollama.js');

test('a normal model is loaded through /api/generate', async () => {
  seen.length = 0;
  await ollama.loadModel('gemma4:12b');
  assert.deepEqual(seen.map((s) => s.path), ['/api/generate']);
});

test('an embedding model falls back to /api/embed instead of throwing', async () => {
  seen.length = 0;
  await assert.doesNotReject(() => ollama.loadModel('all-minilm:latest'));
  assert.deepEqual(seen.map((s) => s.path), ['/api/generate', '/api/embed'],
    'it should try generate, be refused, then warm through embed');
});

test('unloading an embedding model does the same', async () => {
  seen.length = 0;
  await assert.doesNotReject(() => ollama.unloadModel('all-minilm:latest'));
  assert.deepEqual(seen.map((s) => s.path), ['/api/generate', '/api/embed']);
  assert.match(seen[1]!.body, /"keep_alive":0/, 'unloading must ask for keep_alive 0');
});

test('a real failure still surfaces rather than being swallowed', async () => {
  seen.length = 0;
  await assert.rejects(() => ollama.loadModel('nonexistent-model'), /could not load/);
  // Only the "does not support generate" case may fall back; anything else
  // must fail where it failed rather than being retried somewhere it cannot
  // work and reported as a different problem.
  assert.deepEqual(seen.map((s) => s.path), ['/api/generate']);
});

test.after(() => {
  upstream.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
