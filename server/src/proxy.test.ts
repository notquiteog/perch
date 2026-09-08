// The proxy is the only part of perch that anything outside this machine can
// reach, so these tests are about what it refuses as much as what it allows.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A stand-in for Ollama, and a state directory that goes away with the test.
const upstreamCalls: Array<{ method: string; url: string; auth?: string; body?: string }> = [];
const upstream = http.createServer((req, res) => {
  const call: { method: string; url: string; auth?: string; body?: string } = {
    method: req.method!, url: req.url!, auth: req.headers.authorization,
  };
  upstreamCalls.push(call);
  if (req.url === '/api/chat') {
    // The body is collected so the translation tests can assert what Ollama
    // was actually asked for. It is read to the end before answering, which
    // is also what a real Ollama does.
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      call.body = Buffer.concat(chunks).toString('utf8');
      // A non-streaming request gets one object; a streaming one gets Ollama's
      // shape — one JSON object per line, one token each.
      let stream = true;
      try { stream = JSON.parse(call.body).stream !== false; } catch { /* the pipe tests send their own */ }
      if (!stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: { content: 'hello there' }, done: true, done_reason: 'stop',
          prompt_eval_count: 11, eval_count: 2,
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('{"message":{"content":"one"},"done":false}\n');
      res.write('{"message":{"content":"two"},"done":false}\n');
      res.end('{"done":true,"done_reason":"stop","eval_count":2}\n');
    });
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
const { serviceById } = await import('./services.js');
const { mintToken, revokeToken, resetAuthFailures } = await import('./auth.js');
const { throughput, reset: resetMetrics } = await import('./metrics.js');

const proxy = createProxyServer({ ...serviceById('chat'), upstream: `http://127.0.0.1:${upstreamPort}` });
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
  // Which endpoint this port is, and that perch is up. No version, no models.
  assert.deepEqual(Object.keys(body).sort(), ['endpoint', 'ok', 'service']);
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
  resetAuthFailures();
});

test('a valid token is honoured even while that address is blocked', async () => {
  // Everything arrives through the tunnel from one address, so a block by
  // address blocks everyone. One client with an empty API key field must not
  // lock out a correctly configured one — nor refuse the right token to
  // somebody who has just fixed their settings.
  resetAuthFailures();
  for (let i = 0; i < 4; i += 1) {
    await call('/api/tags', { headers: { Authorization: 'Bearer perch_wrong' } });
  }
  assert.equal((await call('/api/tags', { headers: { Authorization: 'Bearer perch_wrong' } })).status, 429,
    'the guesser is still blocked');

  const good = await call('/api/tags', { headers: { Authorization: `Bearer ${useToken}` } });
  assert.equal(good.status, 200, 'a valid token must get through the block');

  // And succeeding clears the counter, so the next mistake starts from zero.
  assert.equal((await call('/api/tags', { headers: { Authorization: 'Bearer perch_wrong' } })).status, 401,
    'after a success the block should be cleared, so this is a plain 401');
  resetAuthFailures();
});

test('a missing key says so, and says where to get one', async () => {
  resetAuthFailures();
  const res = await call('/api/tags');
  assert.equal(res.status, 401);
  const body = await res.json() as { error: string };
  assert.match(body.error, /no API key was sent/);
  assert.match(body.error, /Settings . API tokens/);
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

// ── The Anthropic shape ────────────────────────────────────────────────────
//
// The only routes perch translates rather than pipes. These go through the
// real proxy, so they are also the check that a translated route is still
// behind the token, the allowlist and the concurrency backstop — the four
// things the pipe's guarantees do not automatically extend to.

test('the Messages API is behind the same token as everything else', async () => {
  resetAuthFailures();
  upstreamCalls.length = 0;
  const res = await call('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 401);
  assert.equal(upstreamCalls.length, 0, 'an unauthenticated request reached Ollama');
  resetAuthFailures();
});

test('a non-streaming request is translated both ways', async () => {
  resetAuthFailures();
  upstreamCalls.length = 0;
  const res = await call('/v1/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'test',
      max_tokens: 16,
      system: 'be brief',
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  });
  assert.equal(res.status, 200);

  // What Ollama was asked for: its own shape, with the system prompt folded
  // back into the message list and max_tokens become num_predict.
  const sent = JSON.parse(upstreamCalls.at(-1)!.body!);
  assert.equal(upstreamCalls.at(-1)!.url, '/api/chat');
  assert.deepEqual(sent.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(sent.options.num_predict, 16);
  // And the caller's token stopped here, exactly as on a piped route.
  assert.equal(upstreamCalls.at(-1)!.auth, undefined);

  // What the caller got back: Anthropic's envelope, not Ollama's.
  const body = await res.json() as Record<string, any>;
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.match(body.id, /^msg_/);
  assert.deepEqual(body.content, [{ type: 'text', text: 'hello there' }]);
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 11, output_tokens: 2 });
});

test('a streamed request arrives as a well-formed SSE sequence', async () => {
  resetAuthFailures();
  resetMetrics();
  const res = await call('/v1/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'test', max_tokens: 16, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await res.text();
  const types = text.split('\n\n').filter(Boolean)
    .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).type);
  // The grammar, in order: a client that meets a delta for a block it was
  // never told about throws rather than rendering partial output.
  assert.deepEqual(types, [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.match(text, /"one"/);
  assert.match(text, /"two"/);
  // A translated generation is still measured. It counts what Ollama reported
  // rather than newlines, because there are no newlines to count once the
  // answer has become SSE.
  assert.equal(throughput().totalTokens, 2);
});

test('the required fields are required, and refused in Anthropic\'s error envelope', async () => {
  resetAuthFailures();
  upstreamCalls.length = 0;
  for (const body of [{ max_tokens: 16, messages: [] }, { model: 'test', messages: [] }]) {
    const res = await call('/v1/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400);
    // The envelope a client's error handling reads. A bare `{error: "..."}`
    // is not something it can classify.
    const j = await res.json() as Record<string, any>;
    assert.equal(j.type, 'error');
    assert.equal(j.error.type, 'invalid_request_error');
  }
  assert.equal(upstreamCalls.length, 0, 'an invalid request still reached Ollama');
});

test('count_tokens answers rather than 404ing, because a client uses it to decide', async () => {
  resetAuthFailures();
  const res = await call('/v1/messages/count_tokens', {
    method: 'POST',
    headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hello world' }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { input_tokens: number };
  assert.ok(body.input_tokens > 0);
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
          // Above the 64 MB limit, which is sized for a minute of dictation
          // audio and an img2img source rather than for text.
          'Content-Length': String(70 * 1024 * 1024),
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

// Each service exposes its own API and only its own. The chat port must not
// accept a transcription, and the voice port must not accept a chat — the
// allowlist is per service, not one shared list with a filter on top.
test('a service refuses another service\'s endpoints', async () => {
  resetAuthFailures();
  const onChat = await call('/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${useToken}` },
  });
  assert.equal(onChat.status, 404, 'the chat port must not accept transcription');

  const voice = createProxyServer({ ...serviceById('voice'), upstream: `http://127.0.0.1:${upstreamPort}` });
  await new Promise<void>((resolve) => voice.listen(0, '127.0.0.1', resolve));
  const vPort = (voice.address() as { port: number }).port;
  const onVoice = await fetch(`http://127.0.0.1:${vPort}/api/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  assert.equal(onVoice.status, 404, 'the voice port must not accept chat');

  const allowed = await fetch(`http://127.0.0.1:${vPort}/v1/audio/transcriptions`, {
    method: 'POST', headers: { Authorization: `Bearer ${useToken}` },
  });
  assert.equal(allowed.status, 200, 'the voice port must accept its own endpoint');
  voice.close();
});

test('the image service exposes generation but not the rest of the A1111 API', async () => {
  const image = createProxyServer({ ...serviceById('image'), upstream: `http://127.0.0.1:${upstreamPort}` });
  await new Promise<void>((resolve) => image.listen(0, '127.0.0.1', resolve));
  const port2 = (image.address() as { port: number }).port;
  const hit = (p: string, m = 'POST'): Promise<Response> =>
    fetch(`http://127.0.0.1:${port2}${p}`, { method: m, headers: { Authorization: `Bearer ${useToken}` } });

  assert.equal((await hit('/sdapi/v1/txt2img')).status, 200);
  // These reconfigure the server or run code on it. Not exposed.
  for (const p of ['/sdapi/v1/options', '/sdapi/v1/refresh-checkpoints', '/sdapi/v1/reload-checkpoint', '/docs']) {
    assert.equal((await hit(p)).status, 404, `${p} must not be routable`);
  }
  image.close();
});

// ComfyUI's API is small, and the dangerous part of it is not the generating.
// The manager extension installs code from the internet, and the userdata
// routes read and write arbitrary files under its home directory — either
// would turn a leaked token into arbitrary code on the GPU box.
test('the video service queues work but cannot install or read files', async () => {
  const video = createProxyServer({ ...serviceById('video'), upstream: `http://127.0.0.1:${upstreamPort}` });
  await new Promise<void>((resolve) => video.listen(0, '127.0.0.1', resolve));
  const vPort = (video.address() as { port: number }).port;
  const hit = (p: string, m = 'POST'): Promise<Response> =>
    fetch(`http://127.0.0.1:${vPort}${p}`, { method: m, headers: { Authorization: `Bearer ${useToken}` } });

  assert.equal((await hit('/prompt')).status, 200, 'queueing a workflow is the point');
  assert.equal((await hit('/history', 'GET')).status, 200);
  assert.equal((await hit('/view', 'GET')).status, 200, 'a result has to be readable');
  for (const p of ['/api/manager/queue/install', '/userdata/x', '/api/userdata/x', '/system_stats/../etc']) {
    assert.equal((await hit(p)).status, 404, `${p} must not be routable`);
    assert.equal((await hit(p, 'GET')).status, 404, `${p} must not be routable`);
  }
  video.close();
});

test('the audio service speaks only the OpenAI speech shape', async () => {
  const audio = createProxyServer({ ...serviceById('audio'), upstream: `http://127.0.0.1:${upstreamPort}` });
  await new Promise<void>((resolve) => audio.listen(0, '127.0.0.1', resolve));
  const aPort = (audio.address() as { port: number }).port;
  const hit = (p: string, m = 'POST'): Promise<Response> =>
    fetch(`http://127.0.0.1:${aPort}${p}`, { method: m, headers: { Authorization: `Bearer ${useToken}` } });

  assert.equal((await hit('/v1/audio/speech')).status, 200);
  assert.equal((await hit('/v1/audio/voices', 'GET')).status, 200);
  // Speech out, not speech in, and nothing that writes to the server.
  for (const p of ['/v1/audio/transcriptions', '/v1/models/download', '/docs']) {
    assert.equal((await hit(p)).status, 404, `${p} must not be routable`);
  }
  audio.close();
});

test.after(() => {
  proxy.close();
  upstream.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
