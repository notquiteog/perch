// Reaching an upstream through a proxy.
//
// The SOCKS5 handshake here is hand-written, because the server this belongs
// to has no runtime dependencies (CONTRIBUTING.md is explicit that it is the
// piece exposed to a tunnel, and that a framework in it is a supply chain in
// it). Hand-written means it is worth testing against a real socket rather
// than trusting the byte layout by eye — so these run a stub SOCKS5 proxy and
// a stub upstream and check what actually crossed.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { parseProxy, proxyAgent, requestUpstream, upstreamFor } from './upstream.js';

// ── a stub SOCKS5 proxy that records what it was asked for ─────────────────
interface Ask { host: string; port: number; atyp: number }
const asks: Ask[] = [];
let requireAuth = false;
const socks = net.createServer((client) => {
  let stage = 0;
  client.on('data', (chunk: Buffer) => {
    if (stage === 0) {
      // Greeting. 0x02 is username/password, 0x00 is none.
      const offered = Array.from(chunk.subarray(2, 2 + (chunk[1] ?? 0)));
      if (requireAuth) {
        if (!offered.includes(0x02)) { client.write(Buffer.from([0x05, 0xff])); client.end(); return; }
        client.write(Buffer.from([0x05, 0x02]));
        stage = 1;
        return;
      }
      client.write(Buffer.from([0x05, 0x00]));
      stage = 2;
      return;
    }
    if (stage === 1) {
      // Username/password sub-negotiation.
      const ulen = chunk[1] ?? 0;
      const user = chunk.subarray(2, 2 + ulen).toString();
      const plen = chunk[2 + ulen] ?? 0;
      const pass = chunk.subarray(3 + ulen, 3 + ulen + plen).toString();
      const ok = user === 'u' && pass === 'p';
      client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
      if (!ok) { client.end(); return; }
      stage = 2;
      return;
    }
    if (stage !== 2) return;
    const atyp = chunk[3]!;
    let host: string; let off: number;
    if (atyp === 0x03) { const len = chunk[4]!; host = chunk.subarray(5, 5 + len).toString(); off = 5 + len; }
    else if (atyp === 0x01) { host = Array.from(chunk.subarray(4, 8)).join('.'); off = 8; }
    else { client.end(); return; }
    const port = chunk.readUInt16BE(off);
    asks.push({ host, port, atyp });
    const up = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      client.pipe(up); up.pipe(client);
    });
    up.on('error', () => client.end());
    stage = 3;
  });
  client.on('error', () => {});
});

let served = 0;
const upstream = http.createServer((req, res) => {
  served += 1;
  req.resume();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});

await new Promise<void>((r) => socks.listen(0, '127.0.0.1', () => r()));
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
const socksPort = (socks.address() as net.AddressInfo).port;
const upPort = (upstream.address() as net.AddressInfo).port;
const upUrl = `http://127.0.0.1:${upPort}`;

test.after(() => { socks.close(); upstream.close(); });

test('an empty proxy field means direct, and is not an error', () => {
  // The default for every service, and what a machine hosting its own models
  // wants. It must not be mistaken for a misconfiguration.
  assert.equal(parseProxy(''), null);
  assert.equal(parseProxy(undefined), null);
  assert.equal(parseProxy('   '), null);
  assert.equal(upstreamFor(upUrl, '').agent, undefined);
});

test('a malformed proxy is refused rather than ignored', () => {
  // Silently going direct is the worst possible failure for this setting: the
  // traffic still flows, the answer still comes back, and nothing says it took
  // the route the operator specifically said not to.
  assert.throws(() => parseProxy('not a url'), /not a valid proxy URL/);
  assert.throws(() => parseProxy('http://127.0.0.1:8080'), /not supported/);
  assert.throws(() => parseProxy('socks5h://'), /valid proxy URL|no host/);
  assert.throws(() => upstreamFor(upUrl, 'https://proxy.example'), /not supported/);
});

test('a proxy URL is parsed into its parts, port and credentials included', () => {
  const p = parseProxy('socks5h://user:pa%40ss@127.0.0.1:9150')!;
  assert.equal(p.host, '127.0.0.1');
  assert.equal(p.port, 9150);
  assert.equal(p.protocol, 'socks5h:');
  assert.equal(p.username, 'user');
  // Percent-decoded, so a password containing @ or : survives the URL form.
  assert.equal(p.password, 'pa@ss');
  // SOCKS's own default port when none is given.
  assert.equal(parseProxy('socks5://127.0.0.1')!.port, 1080);
});

test('a request through the proxy actually reaches the upstream', async () => {
  asks.length = 0;
  const before = served;
  const agent = proxyAgent(parseProxy(`socks5h://127.0.0.1:${socksPort}`)!, false);
  const res = await requestUpstream(`${upUrl}/api/tags`, { agent });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body.toString('utf8')), { ok: true, path: '/api/tags' });
  assert.equal(served, before + 1);
  assert.equal(asks.length, 1, 'the request did not go through the proxy');
  assert.equal(asks[0]!.port, upPort);
});

test('socks5h hands the hostname to the proxy rather than resolving it here', async () => {
  // The property the scheme exists for. Resolving locally would tell this
  // machine's resolver — and its network — which upstream is about to be
  // contacted, while the bytes went through the proxy: most of the cost of the
  // setting and none of the benefit. It is also the only way an .onion address
  // works at all, since it has no DNS.
  asks.length = 0;
  const agent = proxyAgent(parseProxy(`socks5h://127.0.0.1:${socksPort}`)!, false);
  await requestUpstream(`http://localhost:${upPort}/`, { agent });
  assert.equal(asks[0]!.atyp, 0x03, 'the hostname was resolved locally instead of by the proxy');
  assert.equal(asks[0]!.host, 'localhost');
});

test('plain socks5 with a literal address sends the address', async () => {
  // Somebody who typed socks5:// meant it — a proxy on a private network with
  // split-horizon DNS is a real setup — so the scheme is honoured as written.
  asks.length = 0;
  const agent = proxyAgent(parseProxy(`socks5://127.0.0.1:${socksPort}`)!, false);
  await requestUpstream(`${upUrl}/`, { agent });
  assert.equal(asks[0]!.atyp, 0x01);
  assert.equal(asks[0]!.host, '127.0.0.1');
});

test('a proxy that wants a password gets one, and refuses a wrong one', async () => {
  requireAuth = true;
  try {
    const good = proxyAgent(parseProxy(`socks5h://u:p@127.0.0.1:${socksPort}`)!, false);
    const res = await requestUpstream(`${upUrl}/`, { agent: good });
    assert.equal(res.status, 200);

    const bad = proxyAgent(parseProxy(`socks5h://u:wrong@127.0.0.1:${socksPort}`)!, false);
    await assert.rejects(() => requestUpstream(`${upUrl}/`, { agent: bad }), /refused the username/);

    // And no credentials at all against a proxy that demands them fails with a
    // sentence naming the fix, not a socket error.
    const none = proxyAgent(parseProxy(`socks5h://127.0.0.1:${socksPort}`)!, false);
    await assert.rejects(() => requestUpstream(`${upUrl}/`, { agent: none }), /rejected every authentication method|wants a username/);
  } finally {
    requireAuth = false;
  }
});

test('a proxy that is not listening fails loudly rather than falling back', async () => {
  // The direct connection would very likely succeed, which is exactly why it
  // must not be attempted: an operator who set a proxy has said where this
  // traffic may go.
  const dead = proxyAgent(parseProxy('socks5h://127.0.0.1:1')!, false);
  await assert.rejects(() => requestUpstream(`${upUrl}/`, { agent: dead }));
});
