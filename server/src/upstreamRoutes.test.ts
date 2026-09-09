// The chat service in front of a hosted API, end to end through the real
// proxy.
//
// `shapes.test.ts` asserts the conversions. This asserts the thing an operator
// actually gets: a client written against Ollama's API, pointed at perch,
// working unchanged when what is behind perch is an OpenAI-shaped or
// Anthropic-shaped service — with the token, the allowlist and the activity
// ring still in front of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What the fake hosted service was asked for, so the translation is checkable. */
const seen: Array<{ method: string; url: string; auth?: string; version?: string; body?: any }> = [];

/**
 * A stand-in for a hosted API, answering both shapes.
 *
 * One server rather than two because the point of the tests below is the
 * translation, not the routing: which shape it answers is decided by the path,
 * exactly as it would be at a real provider serving both.
 */
const hosted = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* the GETs send nothing */ }
    seen.push({
      method: req.method!,
      url: req.url!,
      auth: req.headers.authorization,
      version: req.headers['anthropic-version'] as string | undefined,
      body,
    });

    const url = req.url!;
    if (url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5' }, { id: 'claude-opus-5' }] }));
      return;
    }
    if (url === '/v1/embeddings') {
      const n = Array.isArray(body?.input) ? body.input.length : 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Deliberately out of order, so the reordering is exercised on the real
      // path rather than only in the unit test.
      res.end(JSON.stringify({
        data: Array.from({ length: n }, (_, i) => ({ index: n - 1 - i, embedding: [n - 1 - i] })),
        usage: { prompt_tokens: 3 },
      }));
      return;
    }
    if (url === '/v1/chat/completions') {
      if (body?.stream === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', choices: [{ message: { role: 'assistant', content: 'whole answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 5 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (url === '/v1/messages') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const f = (e: string, d: unknown): void => { res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); };
      f('message_start', { message: { usage: { input_tokens: 4 } } });
      f('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      f('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi' } });
      f('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' there' } });
      f('content_block_stop', { index: 0 });
      f('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } });
      f('message_stop', {});
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such path' }));
  });
});

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-upstream-test-'));
await new Promise<void>((resolve) => hosted.listen(0, '127.0.0.1', resolve));
const hostedPort = (hosted.address() as { port: number }).port;
const hostedUrl = `http://127.0.0.1:${hostedPort}`;

process.env.PERCH_STATE_DIR = stateDir;
process.env.PERCH_PROXY_PORT = '0';
process.env.PERCH_LOG_LEVEL = 'error';

const { createProxyServer } = await import('./proxy.js');
const { serviceById } = await import('./services.js');
const { mintToken } = await import('./auth.js');
const { updateState } = await import('./state.js');

const proxy = createProxyServer(serviceById('chat'));
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const port = (proxy.address() as { port: number }).port;
const { token } = mintToken('test', ['use', 'manage']);

/** Point the chat service at the fake hosted service, in one shape or the other. */
function upstreamIs(api: 'ollama' | 'openai' | 'anthropic'): void {
  updateState((s) => {
    s.settings.upstreams.chat = { api, url: api === 'ollama' ? '' : hostedUrl, key: 'upstream-secret' };
  });
}

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, text: await res.text() };
}

test.beforeEach(() => { seen.length = 0; });

test('an Ollama client reaches an OpenAI-shaped upstream and gets Ollama back', async () => {
  // The whole point: a client written against Ollama's API, unchanged, when
  // the operator has moved the models to a hosted provider.
  upstreamIs('openai');
  const r = await call('POST', '/api/chat', { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(r.status, 200);

  // What went out was an OpenAI request, carrying PERCH's key — never the
  // caller's token, which is the property that lets the key be rotated here
  // without touching any client.
  const out = seen.at(-1)!;
  assert.equal(out.url, '/v1/chat/completions');
  assert.equal(out.auth, 'Bearer upstream-secret');
  assert.notEqual(out.auth, `Bearer ${token}`);
  assert.deepEqual(out.body.messages, [{ role: 'user', content: 'hi' }]);

  // What came back is newline-delimited JSON in Ollama's shape, token by
  // token, terminated by a `done` line.
  const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.map((l) => l.message?.content ?? '').join(''), 'Hello');
  assert.equal(lines.at(-1)!.done, true);
  assert.equal(lines.at(-1)!.eval_count, 5);
});

test('a non-streaming request comes back whole, in the shape it was asked in', async () => {
  upstreamIs('openai');
  const r = await call('POST', '/api/chat', { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream: false });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.message.content, 'whole answer');
  assert.equal(body.done, true);
  assert.equal(body.prompt_eval_count, 2);
});

test('an Ollama client reaches an Anthropic upstream, and the version header goes with it', async () => {
  upstreamIs('anthropic');
  const r = await call('POST', '/api/chat', { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(r.status, 200);

  const out = seen.at(-1)!;
  assert.equal(out.url, '/v1/messages');
  // Mandatory on every request or the whole lot is refused, and the failure
  // reads like a malformed body rather than a missing header.
  assert.equal(out.version, '2023-06-01');
  assert.equal(out.auth, undefined, 'Anthropic does not read Authorization');
  // `max_tokens` is required by that API and has no default.
  assert.ok(Number.isFinite(out.body.max_tokens));

  const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.map((l) => l.message?.content ?? '').join(''), 'Hi there');
  assert.equal(lines.at(-1)!.done, true);
});

test('an OpenAI client reaches an Anthropic upstream and gets OpenAI SSE back', async () => {
  // The double conversion the shapes module warns about, on the real path.
  upstreamIs('anthropic');
  const r = await call('POST', '/v1/chat/completions', {
    model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 40,
  });
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1)!.url, '/v1/messages');

  const frames = r.text.split('\n\n').filter(Boolean);
  const text = frames
    .filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
    .map((f) => JSON.parse(f.slice(6)))
    .map((c: any) => c.choices?.[0]?.delta?.content ?? '')
    .join('');
  assert.equal(text, 'Hi there');
  // The terminator OpenAI clients wait for; without it several of them hang
  // until their own timeout rather than finishing.
  assert.ok(r.text.includes('data: [DONE]'));
});

test('an Anthropic client reaches an OpenAI upstream and gets a well-formed SSE grammar', async () => {
  upstreamIs('openai');
  const r = await call('POST', '/v1/messages', {
    model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 40,
  });
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1)!.url, '/v1/chat/completions');

  // A client that receives a delta for a block it was never told about
  // throws, so the order is the assertion.
  const events = r.text.split('\n\n').filter(Boolean)
    .map((f) => (/^event: (\S+)/.exec(f) ?? [])[1])
    .filter(Boolean);
  assert.equal(events[0], 'message_start');
  assert.ok(events.indexOf('content_block_start') < events.indexOf('content_block_delta'));
  assert.ok(events.indexOf('content_block_delta') < events.indexOf('content_block_stop'));
  assert.equal(events.at(-1), 'message_stop');
});

test('the model list is the upstream’s, in whichever shape was asked for', async () => {
  upstreamIs('openai');
  const tags = await call('GET', '/api/tags');
  assert.equal(tags.status, 200);
  const names = JSON.parse(tags.text).models.map((m: any) => m.name);
  assert.deepEqual(names, ['claude-opus-5', 'gpt-5']);
  // No invented size: a hosted catalogue reports none, and a plausible number
  // would land on a page an operator uses to decide what fits on a disk.
  assert.equal(JSON.parse(tags.text).models[0].size, 0);

  // The OpenAI-shaped route is piped, so it is the upstream's own answer.
  const models = await call('GET', '/v1/models');
  assert.equal(models.status, 200);
  assert.deepEqual(JSON.parse(models.text).data.map((m: any) => m.id), ['gpt-5', 'claude-opus-5']);
});

test('embeddings are reordered by index on the real path', async () => {
  upstreamIs('openai');
  const r = await call('POST', '/api/embed', { model: 'text-embedding-3-large', input: ['a', 'b', 'c'] });
  assert.equal(r.status, 200);
  // The fake service answers deliberately out of order; a reader trusting
  // arrival order would pair every vector with the wrong text.
  assert.deepEqual(JSON.parse(r.text).embeddings, [[0], [1], [2]]);
});

test('what a hosted upstream cannot do is refused, and the message names the setting', async () => {
  upstreamIs('openai');
  for (const [method, p] of [['POST', '/api/pull'], ['DELETE', '/api/delete']] as const) {
    const r = await call(method, p, { model: 'gpt-5' });
    assert.equal(r.status, 501, `${method} ${p}`);
    assert.match(JSON.parse(r.text).error, /upstream/i);
  }
  // Nothing is loaded on this machine, which is true — and an empty list is
  // what a polling client reads as "nothing loaded" rather than "broken".
  const ps = await call('GET', '/api/ps');
  assert.equal(ps.status, 200);
  assert.deepEqual(JSON.parse(ps.text).models, []);

  upstreamIs('anthropic');
  const embed = await call('POST', '/api/embed', { model: 'x', input: ['a'] });
  assert.equal(embed.status, 501);
  assert.match(JSON.parse(embed.text).error, /no embeddings endpoint/i);
});

test('an unauthenticated request is refused before anything is translated', async () => {
  // The order matters: the token, the scope, the allowlist and the size
  // ceiling all run before the body is read, exactly as they do for a piped
  // request. A translator that ran first would be an unauthenticated parser.
  upstreamIs('openai');
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5', messages: [] }),
  });
  assert.equal(res.status, 401);
  assert.equal(seen.length, 0, 'an unauthenticated request reached the upstream');

  // A path that is not on the allowlist is still 404, whatever the upstream is.
  const off = await call('POST', '/api/create', { model: 'x' });
  assert.equal(off.status, 404);
  assert.equal(seen.length, 0);
});

test('a state file naming a shape the service cannot front falls back to its native one', async () => {
  // `state.json` is a file a script can write, and an unrecognised shape must
  // not fall through to a translator that does not exist. Ollama is the chat
  // service's first entry, so that is what an unknown value means.
  //
  // The ADDRESS is still honoured — the two settings are independent, and an
  // operator who has moved the upstream has moved it whatever the shape says.
  // So the assertion is that the request went out in Ollama's shape, at the
  // configured address, rather than being translated.
  updateState((s) => { s.settings.upstreams.chat = { api: 'nonsense', url: hostedUrl, key: '' }; });
  await call('GET', '/api/tags');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, '/api/tags', 'an unknown shape was translated instead of piped');
});

test.after(() => {
  proxy.close();
  hosted.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
