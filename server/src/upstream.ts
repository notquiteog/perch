// How perch reaches the model server behind a service.
//
// Every service already has its own upstream address — PERCH_OLLAMA_URL,
// PERCH_WHISPER_URL, PERCH_COMFY_URL, PERCH_TTS_URL — because they are four
// different servers and usually four different containers. This file adds the
// other half of "how do we reach it": an optional proxy, per service.
//
// ── Why a proxy URL and not a "use Tor" switch ──────────────────────────────
//
// A boolean would have to be paired with a proxy address somewhere, and then
// perch would own an opinion about which port Tor listens on — 9050 for the C
// daemon, 9150 for Arti, something else entirely for a proxy in another
// container. A field that holds `socks5h://127.0.0.1:9150` says the same thing
// without the opinion, and says it in a form that is already familiar from
// every other tool that takes one.
//
// It also generalises for free. Tor is the reason this exists, but a service
// reached through a jump host, or through a SOCKS proxy on the far side of a
// WireGuard link, is the same mechanism and needs no second setting.
//
// ── Why this is hand-written ────────────────────────────────────────────────
//
// `socks-proxy-agent` would be four lines instead of ninety. It would also be
// the first runtime dependency in a component whose whole design is not having
// any — see CONTRIBUTING.md, which is explicit that this is the piece exposed
// to a tunnel and that a framework in it is a supply chain in it. SOCKS5
// CONNECT is a fixed-layout handshake of two short exchanges; it is a small
// enough thing to own outright.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

/** What a proxy field may hold. Anything else is refused when it is set. */
const SUPPORTED = new Set(['socks5:', 'socks5h:', 'socks:', 'socks4:', 'socks4a:']);

/**
 * Whether the PROXY resolves the hostname, or perch does.
 *
 * `socks5h` is the form that matters here and the one the docs recommend: the
 * proxy resolves, so an .onion name works at all, and — for an ordinary
 * hostname — this machine's resolver is never told which upstream is about to
 * be contacted. Routing the bytes through Tor while asking the local DNS for
 * the name is most of the cost of the setting and none of the benefit.
 *
 * Plain `socks5` is honoured as written, because somebody who typed it meant
 * it: a proxy on a private network with split-horizon DNS is a real setup.
 */
function resolvesRemotely(protocol: string): boolean {
  return protocol === 'socks5h:' || protocol === 'socks4a:' || protocol === 'socks:';
}

export interface ProxyConfig {
  host: string;
  port: number;
  protocol: string;
  /** Optional username/password, for a proxy that asks. */
  username: string;
  password: string;
}

/**
 * Parse a proxy field. Empty means direct, and is not an error.
 *
 * Throws on anything malformed rather than falling back to a direct
 * connection: silently ignoring a proxy an operator configured is the worst
 * possible failure for this setting, because the traffic still flows and
 * nothing says it took the wrong route.
 */
export function parseProxy(raw: string | undefined | null): ProxyConfig | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let u: URL;
  try { u = new URL(value); } catch { throw new Error(`"${value}" is not a valid proxy URL`); }
  if (!SUPPORTED.has(u.protocol)) {
    throw new Error(`proxy scheme ${u.protocol.replace(':', '')} is not supported; use socks5h:// (recommended), socks5://, socks4a:// or socks4://`);
  }
  const port = Number(u.port || 1080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`"${value}" has no usable port`);
  if (!u.hostname) throw new Error(`"${value}" has no host`);
  return {
    host: u.hostname,
    port,
    protocol: u.protocol,
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
}

/**
 * Reads a fixed number of bytes at a time during the handshake.
 *
 * One `data` listener for the whole exchange, with everything past the current
 * request held here. The obvious version — attach a listener, take what you
 * need, `socket.unshift()` the rest, detach — loses bytes, and loses them
 * intermittently, which is worse: `unshift` while the stream is flowing emits
 * the pushed-back data immediately, and between two steps of the handshake
 * there is no listener to receive it. A proxy that answers the greeting and
 * the CONNECT reply in one write hits it every time; one that answers in two
 * never does.
 *
 * At the end `release` hands whatever is left back to the socket, with the
 * stream paused first so it is still there when `node:http` starts reading.
 */
class HandshakeReader {
  private buf: Buffer = Buffer.alloc(0);

  private want = 0;

  private pending: { resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;

  private failed: Error | null = null;

  private readonly onData = (chunk: Buffer): void => {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.settle();
  };

  private readonly onErr = (e: Error): void => { this.fail(e); };

  private readonly onEnd = (): void => {
    this.fail(new Error('the proxy closed the connection during the handshake'));
  };

  constructor(private readonly socket: net.Socket) {
    socket.on('data', this.onData);
    socket.on('error', this.onErr);
    socket.on('end', this.onEnd);
  }

  private settle(): void {
    if (!this.pending || this.buf.length < this.want) return;
    const out = this.buf.subarray(0, this.want);
    this.buf = this.buf.subarray(this.want);
    const { resolve } = this.pending;
    this.pending = null;
    resolve(out);
  }

  private fail(e: Error): void {
    this.failed = e;
    const p = this.pending;
    this.pending = null;
    p?.reject(e);
  }

  read(want: number): Promise<Buffer> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.want = want;
      this.settle();
    });
  }

  /** Stop reading and give the socket back whatever the handshake over-read. */
  release(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onErr);
    this.socket.off('end', this.onEnd);
    if (!this.buf.length) return;
    // Paused first: unshifting into a flowing stream is what this class exists
    // to avoid, and doing it here would move the bug rather than fix it.
    this.socket.pause();
    this.socket.unshift(this.buf);
    this.buf = Buffer.alloc(0);
  }
}

const SOCKS5_ERRORS: Record<number, string> = {
  1: 'general failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

/** The SOCKS5 CONNECT handshake, on an already-open socket to the proxy. */
async function socks5Connect(reader: HandshakeReader, socket: net.Socket, cfg: ProxyConfig, host: string, port: number): Promise<void> {
  const wantsAuth = Boolean(cfg.username || cfg.password);
  // Greeting: version 5, the methods we support.
  socket.write(wantsAuth
    ? Buffer.from([0x05, 0x02, 0x00, 0x02])
    : Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await reader.read(2);
  if (greeting[0] !== 0x05) throw new Error('the proxy did not answer as SOCKS5');
  const method = greeting[1];
  if (method === 0xff) throw new Error('the proxy rejected every authentication method offered');
  if (method === 0x02) {
    if (!wantsAuth) throw new Error('the proxy wants a username and password; put them in the proxy URL');
    const user = Buffer.from(cfg.username, 'utf8');
    const pass = Buffer.from(cfg.password, 'utf8');
    socket.write(Buffer.concat([
      Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass,
    ]));
    const auth = await reader.read(2);
    if (auth[1] !== 0x00) throw new Error('the proxy refused the username and password');
  } else if (method !== 0x00) {
    throw new Error(`the proxy asked for an authentication method perch does not implement (0x${method!.toString(16)})`);
  }

  // CONNECT. The hostname goes as a name rather than an address whenever the
  // scheme says the proxy resolves — see `resolvesRemotely`.
  const asName = resolvesRemotely(cfg.protocol) || !net.isIP(host);
  let addr: Buffer;
  if (asName) {
    const name = Buffer.from(host, 'utf8');
    if (name.length > 255) throw new Error('that hostname is too long for SOCKS5');
    addr = Buffer.concat([Buffer.from([0x03, name.length]), name]);
  } else if (net.isIPv4(host)) {
    addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))]);
  } else {
    const parts = host.replace(/^\[|\]$/g, '').split(':');
    const full = parts.flatMap((p) => {
      const n = Number.parseInt(p || '0', 16);
      return [(n >> 8) & 0xff, n & 0xff];
    });
    addr = Buffer.concat([Buffer.from([0x04]), Buffer.from(full)]);
  }
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));

  const reply = await reader.read(4);
  if (reply[0] !== 0x05) throw new Error('the proxy sent a malformed reply');
  if (reply[1] !== 0x00) {
    throw new Error(`the proxy refused the connection: ${SOCKS5_ERRORS[reply[1]!] ?? `code ${reply[1]}`}`);
  }
  // The bound address, which is of no use here but has to be read off the
  // socket before the tunnelled stream starts.
  const type = reply[3];
  if (type === 0x01) await reader.read(4 + 2);
  else if (type === 0x04) await reader.read(16 + 2);
  else if (type === 0x03) {
    const len = await reader.read(1);
    await reader.read(len[0]! + 2);
  } else throw new Error('the proxy sent an address type perch does not understand');
}

/** SOCKS4/4a CONNECT, for the older proxies that only speak it. */
async function socks4Connect(reader: HandshakeReader, socket: net.Socket, cfg: ProxyConfig, host: string, port: number): Promise<void> {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  const user = Buffer.from(cfg.username, 'utf8');
  let head: Buffer;
  if (net.isIPv4(host) && !resolvesRemotely(cfg.protocol)) {
    head = Buffer.concat([
      Buffer.from([0x04, 0x01]), portBuf, Buffer.from(host.split('.').map(Number)), user, Buffer.from([0x00]),
    ]);
  } else {
    // SOCKS4a: an address of 0.0.0.x means "the hostname follows".
    const name = Buffer.from(host, 'utf8');
    head = Buffer.concat([
      Buffer.from([0x04, 0x01]), portBuf, Buffer.from([0, 0, 0, 1]), user, Buffer.from([0x00]),
      name, Buffer.from([0x00]),
    ]);
  }
  socket.write(head);
  const reply = await reader.read(8);
  if (reply[1] !== 0x5a) throw new Error(`the proxy refused the connection (SOCKS4 code ${reply[1]})`);
}

/**
 * An agent that dials every connection through the configured proxy.
 *
 * Implemented by overriding `createConnection`, which is the documented seam
 * in `node:http`'s own Agent: the pooling, keep-alive and socket accounting
 * stay Node's, and the only thing replaced is how a socket comes into being.
 */
export function proxyAgent(cfg: ProxyConfig, secure: boolean): http.Agent {
  const Base = secure ? https.Agent : http.Agent;
  const agent = new Base({ keepAlive: false });
  (agent as unknown as { createConnection: unknown }).createConnection = (
    options: { host?: string; port?: number; servername?: string },
    callback: (err: Error | null, socket?: net.Socket | tls.TLSSocket) => void,
  ): void => {
    const target = options.host ?? '';
    const targetPort = options.port ?? (secure ? 443 : 80);
    const socket = net.connect(cfg.port, cfg.host);
    socket.once('error', (e) => callback(e));
    socket.once('connect', () => {
      const reader = new HandshakeReader(socket);
      const shake = cfg.protocol.startsWith('socks4')
        ? socks4Connect(reader, socket, cfg, target, targetPort)
        : socks5Connect(reader, socket, cfg, target, targetPort);
      shake.then(() => {
        reader.release();
        socket.removeAllListeners('error');
        if (!secure) { callback(null, socket); return; }
        // The tunnel carries bytes; TLS still has to be negotiated end to end
        // with the real upstream, over the socket the proxy opened.
        const secured = tls.connect({ socket, servername: options.servername ?? target });
        secured.once('secureConnect', () => callback(null, secured));
        secured.once('error', (e) => callback(e));
      }).catch((e: Error) => { reader.release(); socket.destroy(); callback(e); });
    });
  };
  return agent;
}

/**
 * How to reach one upstream: the address, and an agent when a proxy is set.
 *
 * Throws on a malformed proxy rather than quietly going direct — see
 * `parseProxy`. The caller turns that into a 502 naming the setting, which is
 * the only honest answer when the route an operator asked for is unavailable.
 */
export function upstreamFor(upstreamUrl: string, proxy: string | undefined | null): {
  url: URL; agent: http.Agent | undefined;
} {
  const url = new URL(upstreamUrl);
  const cfg = parseProxy(proxy);
  if (!cfg) return { url, agent: undefined };
  return { url, agent: proxyAgent(cfg, url.protocol === 'https:') };
}


// ── A buffered request, so every upstream call can carry the agent ─────────
//
// `fetch` cannot be given an `http.Agent`; its dispatcher is undici's and is
// not part of the stable builtin surface. That is a real constraint rather
// than a preference: a call left on `fetch` is a call that silently ignores
// the service's proxy, which is the exact failure this whole file exists to
// prevent — the request succeeds, the picture comes back, and it went direct.
//
// So the calls that need the proxy use this instead. Buffered rather than
// streamed because its two callers want a whole JSON document or a whole
// generated image; the streaming path stays in proxy.ts where it belongs.

export interface UpstreamReply { status: number; body: Buffer }

export function requestUpstream(target: string, opts: {
  agent?: http.Agent;
  method?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string | Buffer;
  timeoutMs?: number;
  /** Refuse a response larger than this, so one upstream cannot exhaust us. */
  maxBytes?: number;
} = {}): Promise<UpstreamReply> {
  const url = new URL(target);
  const mod = url.protocol === 'https:' ? https : http;
  const { method = 'GET', headers = {}, body, timeoutMs = 30_000, agent, maxBytes = 64 * 1024 * 1024 } = opts;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }),
      },
      ...(agent ? { agent } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('the upstream sent more than perch will hold')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('the upstream did not answer in time')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
