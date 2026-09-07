// A router small enough to read in one sitting. perch has no runtime
// dependencies — the process that faces the tunnel should not be carrying a
// framework's worth of code it never uses — so this is the whole of it.
import type http from 'node:http';
import { config } from './config.js';

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  url: URL;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface Entry { method: string; parts: string[]; handler: Handler }

export class Router {
  private entries: Entry[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.entries.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(p: string, h: Handler): this { return this.add('GET', p, h); }
  post(p: string, h: Handler): this { return this.add('POST', p, h); }
  put(p: string, h: Handler): this { return this.add('PUT', p, h); }
  delete(p: string, h: Handler): this { return this.add('DELETE', p, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const e of this.entries) {
      if (e.method !== method || e.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < e.parts.length; i += 1) {
        const pat = e.parts[i]!;
        const got = parts[i]!;
        if (pat.startsWith(':')) params[pat.slice(1)] = decodeURIComponent(got);
        else if (pat !== got) { ok = false; break; }
      }
      if (ok) return { handler: e.handler, params };
    }
    return null;
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m: string): HttpError => new HttpError(400, m);
export const notFound = (m = 'not found'): HttpError => new HttpError(404, m);
export const forbidden = (m: string): HttpError => new HttpError(403, m);

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > config.maxBodyBytes) throw badRequest('request too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw badRequest('the request body is not valid JSON');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** A server-sent-events channel, for pull progress and the live monitors. */
export function openEventStream(res: http.ServerResponse): {
  send: (event: string, data: unknown) => void;
  close: () => void;
} {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Nothing in front of perch buffers, but say so anyway in case somebody
    // puts a proxy there.
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');
  let closed = false;
  return {
    send(event, data) {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      if (!res.writableEnded) res.end();
    },
  };
}
