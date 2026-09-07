// The proxy is the only part of perch that anything outside this machine can
// reach, so these tests are about what it refuses as much as what it allows.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A stand-in for Ollama, and a state directory that goes away with the test.
const upstreamCalls: Array<{ method: string; url: string; auth?: string }> = [];
const upstream = http.createServer((req, res) => {
  upstreamCalls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
  if (req.url === '/api/chat') {
    // Ollama's shape: one JSON object per line, one token each.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write('{"message":{"content":"one"},"done":false}\n');
    res.write('{"message":{"content":"two"},"done":false}\n');
    res.end('{"done":true}\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-test-'));
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = (upstream.address() as { port: number }).port;

process.env.PERCH_STATE_DIR = stateDir;
process.env.PERCH_OLLAMA_URL = `http://127.0.0.1:${upstreamPort}`;
process.env.PERCH_PROXY_PORT = '0';
process.env.PERCH_AUTH_FAIL_LIMIT = '3';
process.env.PERCH_LOG_LEVEL = 'error';

const { createProxyServer } = await import('./proxy.js');
const { mintToken, revokeToken, resetAuthFailures } = await import('./auth.js');
const { throughput, reset: resetMetrics } = await import('./metrics.js');

const proxy = createProxyServer();
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const port = (proxy.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const { token: useToken } = mintToken('test-use', ['use']);
const { token: manageToken } = mintToken('test-manage', ['use', 'manage']);

function call(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, init);
}

test('healthz needs no token and says nothing useful to a scanner', async () => {
  const res = await call('/healthz');
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'service']);
});

test('a request with no token is refused', async () => {
  resetAuthFailures();
  const res = await call('/api/tags');
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/);
});

test('a made-up token is refused', async () => {
  resetAuthFailures();
  const res = await call('/api/tags', { headers: { Authorization: 'Bearer perch_notarealtoken' } });
  assert.equal(res.status, 401);
});

test('a valid token gets through, and the token never reaches Ollama', async () => {
  resetAuthFailures();
  upstreamCalls.length = 0;
  const res = await call('/api/tags', { headers: { Authorization: `Bearer ${useToken}` } });
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls.length, 1);
  // Ollama has no authentication of its own; forwarding the caller's
  // credential would put it in a second process for no reason.
  assert.equal(upstreamCalls[0]!.auth, undefined);
});

test('endpoints outside the allowlist are not reachable, even with a good token', async () => {
  resetAuthFailures();
  upstreamCalls.length = 0;
  // /api/create can write a model onto this machine; /api/push can ship one
  // off it. Neither is in the table, so neither exists here.
  for (const p of ['/api/create', '/api/push', '/api/copy', '/api/blobs/sha256:abc']) {
    const res = await call(p, { method: 'POST', headers: { Authorization: `Bearer ${manageToken}` } });
    assert.equal(res.status, 404, `${p} should not be routable`);
  }
  assert.equal(upstreamCalls.length, 0, 'nothing should have reached Ollama');
});

test('the right path with the wrong method is not a way round the allowlist', async () => {
  resetAuthFailures();
  const res = await call('/api/tags', { method: 'DELETE', headers: { Authorization: `Bearer ${useToken}` } });
  assert.equal(res.status, 404);
});

test('a "use" token may not pull or delete models', async () => {
  resetAuthFailures();
  const pull = await call('/api/pull', {
    method: 'POST', headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x' }),
  });
  assert.equal(pull.status, 403);
  const del = await call('/api/delete', {
    method: 'DELETE', headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x' }),
  });
  assert.equal(del.status, 403);
});

test('a "manage" token may', async () => {
  resetAuthFailures();
  const res = await call('/api/pull', {
    method: 'POST', headers: { Authorization: `Bearer ${manageToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x' }),
  });
  assert.equal(res.status, 200);
});

test('a revoked token stops working at once', async () => {
  resetAuthFailures();
  const { token, record } = mintToken('short-lived', ['use']);
  assert.equal((await call('/api/tags', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  revokeToken(record.id);
  assert.equal((await call('/api/tags', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
});

test('an address that keeps guessing is refused outright', async () => {
  resetAuthFailures();
  for (let i = 0; i < 3; i += 1) {
    await call('/api/tags', { headers: { Authorization: 'Bearer perch_wrong' } });
  }
  const blocked = await call('/api/tags', { headers: { Authorization: 'Bearer perch_wrong' } });
  assert.equal(blocked.status, 429);
  // Even a good token is refused while the block stands: the block is on the
  // address, not on the credential.
  const good = await call('/api/tags', { headers: { Authorization: `Bearer ${useToken}` } });
  assert.equal(good.status, 429);
  resetAuthFailures();
});

test('a streamed answer arrives in pieces, and its tokens are counted without being read', async () => {
  resetAuthFailures();
  resetMetrics();
  const res = await call('/api/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test', messages: [] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"one"/);
  assert.match(text, /"two"/);
  // Three NDJSON lines went through, so three tokens were counted.
  const t = throughput();
  assert.equal(t.totalTokens, 3);
});

test('an oversized body is refused on the header, before any of it is read', async () => {
  resetAuthFailures();
  // Raw http rather than fetch: the point is to announce a body far larger
  // than the limit and check perch answers without waiting for it, which
  // means never sending it. fetch will not let a client lie like that.
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/api/chat', method: 'POST',
        headers: {
          Authorization: `Bearer ${useToken}`,
          'Content-Type': 'application/json',
          'Content-Length': String(9 * 1024 * 1024),
        },
      },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); },
    );
    req.on('error', reject);
    req.write('{"model":"test"}');
    // Deliberately not ended: the answer should arrive anyway.
  });
  assert.equal(status, 413);
});

test.after(() => {
  proxy.close();
  upstream.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
