// The chat service in front of something that is not Ollama.
//
// ── What this buys ────────────────────────────────────────────────────────
//
// Everything valuable about perch is the front door: one bearer token, one
// port per service, a route table that is the whole of what can be reached, a
// proxy per service, a concurrency backstop, and a console that says what has
// been asked. None of that is about Ollama. Until this file existed, an
// operator who wanted those properties in front of OpenAI, Groq, OpenRouter,
// Together, Fireworks, NanoGPT or Anthropic could not have them, because the
// upstream was assumed to speak Ollama's API.
//
// Now the upstream has a shape. Set it and perch becomes an authenticated,
// allowlisted, optionally Tor-routed front door for a hosted API — and clients
// written against Ollama's own API keep working, because the routes the
// upstream does not serve are translated rather than removed.
//
// ── What it costs, stated plainly ─────────────────────────────────────────
//
// proxy.ts opens with "it is a pipe, not a parser", and every security
// property it claims follows from that. A translated route cannot keep that
// promise — it has to read the request to rewrite it. `anthropic.ts` already
// made this trade for two routes; this widens it, so the same bounds are
// restated and hold here:
//
//   - Nothing is written anywhere and nothing is logged. The activity ring
//     records the path and the byte count exactly as it does for a piped
//     request, and never the content.
//   - The request body is read under the same hard ceiling and discarded when
//     the response ends.
//   - The RESPONSE is still streamed. Upstream events are translated one at a
//     time as they arrive, so a long generation still comes token by token and
//     the whole answer is never assembled in memory.
//   - On the default configuration — `api: 'ollama'` — NONE of this runs. Every
//     route is a pipe, exactly as before.
//
// ── What a hosted upstream cannot do ──────────────────────────────────────
//
// Refused rather than faked, because a plausible lie is worse than an error:
//
//   - `pull` and `delete` have no meaning. There is no model file on anybody's
//     disk to fetch or remove, so both answer 501 naming the setting.
//   - `resident` — `/api/ps` — answers an empty list, which is true: nothing
//     is loaded on this machine.
//   - Anthropic has no embeddings endpoint at all, so `embed` against it
//     answers 501 naming the setting rather than an empty vector, which would
//     silently index nothing.
import http from 'node:http';
import https from 'node:https';
import { config } from './config.js';
import { logger } from './log.js';
import type { ApiShape, Op } from './services.js';
import {
  anthropicToOllamaMessage,
  hostedModelsToTags,
  ollamaToAnthropicRequest,
  ollamaToOpenaiEmbedRequest,
  ollamaToOpenaiEmbedResponse,
  ollamaToOpenaiRequest,
  openaiToOllamaEmbedResponse,
  openaiToOllamaRequest,
  tagsToOpenaiModels,
  toOpenaiChunk,
  toOpenaiCompletion,
  completionId,
  finishReason,
} from './shapes.js';
import { toAnthropicMessage, toOllamaRequest } from './anthropic.js';

const log = logger('upstream');

type Block = Record<string, any>;

/** What perch will do with one request, decided by (route shape, upstream shape). */
export type Plan =
  | { kind: 'pipe' }
  | { kind: 'translate' }
  | { kind: 'refuse'; status: number; message: string };

/**
 * The dispatch table, as one function.
 *
 * Written as a decision rather than a matrix literal because most of the
 * matrix is one answer: if the upstream speaks the shape the client is using,
 * it is a pipe, and perch stays the parser-free proxy it prefers to be.
 */
export function planFor(op: Op | undefined, shape: ApiShape | undefined, upstream: ApiShape): Plan {
  // The default and every install that predates this setting. Ollama serves
  // its own shape and OpenAI's natively, and `anthropic.ts` already handles
  // the third, so nothing here changes anything.
  if (upstream === 'ollama') return { kind: 'pipe' };
  if (!op || !shape) return { kind: 'pipe' };

  if (op === 'pull' || op === 'delete') {
    return {
      kind: 'refuse',
      status: 501,
      message: `this perch is configured with a ${upstream} upstream, which has a catalogue rather than an installation — there is no model file here to ${op}. Point the chat service back at an Ollama to manage models.`,
    };
  }
  if (op === 'embed' && upstream === 'anthropic') {
    return {
      kind: 'refuse',
      status: 501,
      message: 'the Anthropic Messages API has no embeddings endpoint. Point a separate embedding client at an Ollama or an OpenAI-compatible server; this perch cannot make one out of Anthropic.',
    };
  }
  // The upstream already speaks what the client is speaking: still a pipe,
  // and the common reason to put perch in front of a hosted API in the first
  // place — the token and the allowlist without a translation.
  if (shape === upstream) return { kind: 'pipe' };
  return { kind: 'translate' };
}

export interface Result { status: number; bytes: number; tokens: number; ttftMs: number | null }

const NOTHING = { bytes: 0, tokens: 0, ttftMs: null };

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * An error in whichever envelope the CLIENT's own error handling reads.
 *
 * A raw upstream body here would be an error the client cannot classify —
 * every one of these SDKs branches on the envelope before it looks at the
 * message.
 */
export function errorFor(shape: ApiShape, status: number, message: string): Block {
  if (shape === 'anthropic') {
    const type = status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
    return { type: 'error', error: { type, message } };
  }
  if (shape === 'openai') {
    return { error: { message, type: status === 429 ? 'rate_limit_error' : 'invalid_request_error', code: null } };
  }
  return { error: message };
}

/** The body, under the same ceiling proxy.ts applies to a piped request. */
async function readBody(req: http.IncomingMessage, limit: number): Promise<Block> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export interface UpstreamTarget {
  api: ApiShape;
  url: string;
  key: string;
  agent?: http.Agent;
}

/** The credential header, in whichever form the upstream wants. */
export function upstreamHeaders(t: UpstreamTarget): http.OutgoingHttpHeaders {
  if (t.api === 'anthropic') {
    return {
      'anthropic-version': '2023-06-01',
      ...(t.key ? { 'x-api-key': t.key } : {}),
    };
  }
  return t.key ? { Authorization: `Bearer ${t.key}` } : {};
}

/**
 * One request to the upstream, streamed.
 *
 * `https` as well as `http`, unlike the buffered helper in upstream.ts and
 * unlike `anthropic.ts` before this existed — both assumed a container on the
 * compose network. A hosted upstream is always https, so a helper that could
 * only speak http would make every one of these fail at the socket.
 */
function open(
  t: UpstreamTarget,
  path: string,
  method: string,
  payload: string | null,
  onResponse: (res: http.IncomingMessage) => void,
  onError: (e: Error) => void,
): http.ClientRequest {
  const url = new URL(path, `${t.url}/`);
  const secure = url.protocol === 'https:';
  const mod = secure ? https : http;
  const req = mod.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (secure ? 443 : 80),
    method,
    path: url.pathname + url.search,
    headers: {
      ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      ...upstreamHeaders(t),
    },
    ...(t.agent ? { agent: t.agent } : {}),
  }, onResponse);
  req.setTimeout(config.upstreamIdleMs, () => req.destroy(new Error('the upstream did not answer in time')));
  req.on('error', onError);
  if (payload !== null) req.write(payload);
  req.end();
  return req;
}

/** Collect a whole upstream reply. Used for the small, non-generating calls. */
function collect(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => { raw += c; });
    res.on('end', () => resolve(raw));
    res.on('error', reject);
  });
}

// ── Line and event readers ────────────────────────────────────────────────

/**
 * Server-sent events, one at a time, out of a chunked response.
 *
 * SSE frames are separated by a blank line and may carry several `data:` lines
 * each. Splitting on newlines alone works right up until an upstream sends a
 * frame in two writes, which is exactly what happens under load — so the
 * remainder is held here rather than re-derived per chunk.
 */
export class SseReader {
  private buf = '';

  push(chunk: string, onEvent: (event: string, data: string) => void): void {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.search(/\r?\n\r?\n/);
      if (i < 0) return;
      const frame = this.buf.slice(0, i);
      this.buf = this.buf.slice(i).replace(/^\r?\n\r?\n/, '');
      let event = '';
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length) onEvent(event, data.join('\n'));
    }
  }
}

/** Newline-delimited JSON, one line at a time. */
export class NdjsonReader {
  private buf = '';

  push(chunk: string, onLine: (obj: Block) => void): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try { onLine(JSON.parse(line)); } catch { /* a partial or malformed line is skipped, as Ollama's own clients do */ }
    }
  }
}

// ── Upstream stream → the neutral (Ollama) shape ──────────────────────────

/**
 * One upstream event, as zero or more Ollama `/api/chat` lines.
 *
 * Stateful because both hosted shapes are: OpenAI streams tool arguments as
 * partial JSON strings spread over many deltas, and Anthropic's SSE opens and
 * closes a block around each one. Neither is usable until the last fragment
 * lands, so the accumulation happens here and the tool call is emitted once.
 */
export class ToOllamaStream {
  private toolName = '';

  private toolArgs = '';

  private toolId = '';

  private usage: Block = {};

  constructor(private readonly model: string) {}

  /** An OpenAI `chat.completion.chunk`. */
  openai(chunk: Block): Block[] {
    const out: Block[] = [];
    const choice = chunk?.choices?.[0];
    if (chunk?.usage) this.usage = chunk.usage;
    const delta = choice?.delta ?? {};
    if (delta.content) out.push(this.line({ content: String(delta.content) }));
    // Some OpenAI-compatible servers put reasoning here; the field is not in
    // OpenAI's own schema, so both spellings seen in the wild are accepted.
    const thinking = delta.reasoning_content ?? delta.reasoning;
    if (thinking) out.push(this.line({ content: '', thinking: String(thinking) }));
    for (const call of delta.tool_calls ?? []) {
      if (call?.id) this.toolId = String(call.id);
      if (call?.function?.name) this.toolName = String(call.function.name);
      if (call?.function?.arguments) this.toolArgs += String(call.function.arguments);
    }
    if (choice?.finish_reason) out.push(this.finish(choice.finish_reason === 'length' ? 'length' : 'stop'));
    return out;
  }

  /** One Anthropic SSE event. */
  anthropic(event: string, data: Block): Block[] {
    const out: Block[] = [];
    if (event === 'message_start' && data?.message?.usage) this.usage = { prompt_tokens: data.message.usage.input_tokens };
    if (event === 'content_block_start' && data?.content_block?.type === 'tool_use') {
      this.toolId = String(data.content_block.id ?? '');
      this.toolName = String(data.content_block.name ?? '');
      this.toolArgs = '';
    }
    if (event === 'content_block_delta') {
      const d = data?.delta ?? {};
      if (d.type === 'text_delta' && d.text) out.push(this.line({ content: String(d.text) }));
      if (d.type === 'thinking_delta' && d.thinking) out.push(this.line({ content: '', thinking: String(d.thinking) }));
      if (d.type === 'input_json_delta' && d.partial_json) this.toolArgs += String(d.partial_json);
    }
    if (event === 'message_delta') {
      if (data?.usage?.output_tokens) this.usage = { ...this.usage, completion_tokens: data.usage.output_tokens };
      if (data?.delta?.stop_reason) {
        out.push(this.finish(data.delta.stop_reason === 'max_tokens' ? 'length' : 'stop'));
      }
    }
    // `message_stop` carries nothing new; the terminating line was already
    // emitted on `message_delta`, which is where the stop reason lives.
    return out;
  }

  private line(message: Block): Block {
    return { model: this.model, created_at: new Date().toISOString(), message: { role: 'assistant', ...message }, done: false };
  }

  /** The final line, carrying the tool call if one accumulated. */
  private finish(reason: string): Block {
    const calls = this.toolName
      ? [{ id: this.toolId, function: { name: this.toolName, arguments: safeArgs(this.toolArgs) } }]
      : [];
    return {
      model: this.model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '', ...(calls.length ? { tool_calls: calls } : {}) },
      done: true,
      done_reason: calls.length ? 'stop' : reason,
      prompt_eval_count: Number(this.usage.prompt_tokens ?? 0),
      eval_count: Number(this.usage.completion_tokens ?? 0),
    };
  }
}

function safeArgs(s: string): unknown {
  if (!s.trim()) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

// ── The neutral shape → what the client asked for ─────────────────────────

/**
 * Ollama lines rendered as the client's own stream.
 *
 * Stateful for OpenAI only in that the id and the role prelude must be
 * consistent across chunks; Anthropic's SSE is a grammar and its state machine
 * already exists in `anthropic.ts`, so this handles the OpenAI direction and
 * the Anthropic direction is composed through `MessageStream` there.
 */
export class FromOllamaStream {
  private readonly id = completionId();

  private opened = false;

  constructor(private readonly model: string) {}

  /** One Ollama line as zero or more `data:` frames. */
  openai(line: Block): string[] {
    const out: string[] = [];
    if (!this.opened) {
      this.opened = true;
      out.push(this.frame(toOpenaiChunk(this.model, this.id, { role: 'assistant', content: '' }, null)));
    }
    const msg = line?.message ?? {};
    if (msg.thinking) out.push(this.frame(toOpenaiChunk(this.model, this.id, { reasoning_content: String(msg.thinking) }, null)));
    if (msg.content) out.push(this.frame(toOpenaiChunk(this.model, this.id, { content: String(msg.content) }, null)));
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      out.push(this.frame(toOpenaiChunk(this.model, this.id, {
        tool_calls: msg.tool_calls.map((c: Block, i: number) => ({
          index: i,
          id: String(c?.id ?? `call_${i}`),
          type: 'function',
          function: {
            name: String(c?.function?.name ?? ''),
            arguments: typeof c?.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c?.function?.arguments ?? {}),
          },
        })),
      }, null)));
    }
    if (line?.done) {
      out.push(this.frame(toOpenaiChunk(this.model, this.id, {}, finishReason(line.done_reason, Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0))));
      // The terminator OpenAI clients wait for. A stream that simply ends
      // leaves several of them hanging until their own timeout.
      out.push('data: [DONE]\n\n');
    }
    return out;
  }

  private frame(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
  }
}

// ── The handler ───────────────────────────────────────────────────────────

export interface HandleArgs {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  target: UpstreamTarget;
  /** What the client is speaking, from the route table. */
  shape: ApiShape;
  op: Op;
  started: number;
}

/**
 * Answer one request against an upstream of a different shape.
 *
 * Everything before this — the token, the scope, the block list, the size
 * ceiling, the concurrency backstop — has already run in proxy.ts, exactly as
 * it does for a piped request.
 */
export async function handle(args: HandleArgs): Promise<Result> {
  const { req, res, target, shape, op } = args;
  try {
    switch (op) {
      case 'chat': return await chat(args);
      case 'embed': return await embed(args);
      case 'models': return await models(args);
      case 'resident': return residentNone(res, shape);
      case 'show': return await show(args);
      case 'version': return versionOf(res, target);
      case 'tokens': return await countTokens(args);
      default:
        send(res, 501, errorFor(shape, 501, `perch cannot serve ${op} against a ${target.api} upstream`));
        return { status: 501, ...NOTHING };
    }
  } catch (e) {
    const message = (e as Error).message;
    const tooLarge = message === 'request too large';
    if (!res.headersSent) {
      send(res, tooLarge ? 413 : 502, errorFor(shape, tooLarge ? 413 : 502, tooLarge ? 'request too large' : `the upstream could not be reached: ${message}`));
    } else {
      res.end();
    }
    log.warn(`${op} against ${target.api} failed`, message);
    return { status: tooLarge ? 413 : 502, ...NOTHING };
  } finally {
    // The body handed in was somebody's prompt. It does not outlive the call:
    // nothing here retains it, and this is the one path in perch that held it
    // at all.
    void req;
  }
}

/** The upstream path for one operation, in the upstream's own shape. */
function pathFor(op: Op, api: ApiShape): string {
  if (api === 'anthropic') return op === 'tokens' ? '/v1/messages/count_tokens' : op === 'models' ? '/v1/models' : '/v1/messages';
  if (op === 'embed') return '/v1/embeddings';
  if (op === 'models') return '/v1/models';
  return '/v1/chat/completions';
}

async function chat(args: HandleArgs): Promise<Result> {
  const { req, res, target, shape, started } = args;
  const body = await readBody(req, config.maxBodyBytes);
  const model = String(body?.model ?? '');
  if (!model) {
    send(res, 400, errorFor(shape, 400, 'model is required'));
    return { status: 400, ...NOTHING };
  }
  const wantsStream = Boolean(body.stream);

  // Everything becomes the neutral shape first — see shapes.ts on why the hub
  // is Ollama's. A client already speaking it converts nothing.
  const neutral: Block = shape === 'ollama' ? body
    : shape === 'anthropic' ? toOllamaRequest(body)
      : openaiToOllamaRequest(body);
  neutral.stream = wantsStream;

  const outbound = target.api === 'anthropic'
    ? ollamaToAnthropicRequest(neutral)
    : ollamaToOpenaiRequest(neutral);
  const payload = JSON.stringify(outbound);

  return await new Promise<Result>((resolve) => {
    let bytes = 0;
    let tokens = 0;
    let ttftMs: number | null = null;
    let settled = false;
    const done = (status: number): void => {
      if (settled) return;
      settled = true;
      resolve({ status, bytes, tokens, ttftMs });
    };

    const toNeutral = new ToOllamaStream(model);
    const fromNeutral = new FromOllamaStream(model);
    const anthropicOut = shape === 'anthropic' ? new AnthropicOut(model) : null;
    const sse = new SseReader();

    // One Ollama line, written out in whatever the client is speaking.
    const emit = (line: Block): void => {
      if (line?.message?.content && ttftMs === null) ttftMs = Date.now() - started;
      if (line?.done) tokens = Number(line.eval_count ?? 0);
      const text = shape === 'ollama' ? `${JSON.stringify(line)}\n`
        : shape === 'openai' ? fromNeutral.openai(line).join('')
          : anthropicOut!.push(line);
      if (!text) return;
      bytes += Buffer.byteLength(text);
      res.write(text);
    };

    open(target, pathFor('chat', target.api), 'POST', payload, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      if (status >= 400) {
        void collect(upstreamRes).then((raw) => {
          send(res, status, errorFor(shape, status, raw.slice(0, 500) || `the upstream answered ${status}`));
          done(status);
        });
        return;
      }
      if (!wantsStream) {
        void collect(upstreamRes).then((raw) => {
          const parsed = safeJson(raw);
          // A non-streaming hosted answer comes back whole; it is converted to
          // the neutral shape and then to the client's, which is the same two
          // hops the streaming path takes one event at a time.
          const line = target.api === 'anthropic'
            ? anthropicToOllamaMessage(parsed, model)
            : fromOpenaiCompletion(parsed, model);
          tokens = Number(line.eval_count ?? 0);
          const out = shape === 'ollama' ? line
            : shape === 'openai' ? toOpenaiCompletion(line, model)
              : toAnthropicMessage(line, model);
          send(res, 200, out);
          bytes = Buffer.byteLength(JSON.stringify(out));
          done(200);
        });
        return;
      }

      res.writeHead(200, {
        'Content-Type': shape === 'ollama' ? 'application/x-ndjson' : 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      upstreamRes.setEncoding('utf8');
      upstreamRes.on('data', (chunk: string) => {
        sse.push(chunk, (event, data) => {
          if (data === '[DONE]') return;
          const parsed = safeJson(data);
          const lines = target.api === 'anthropic' ? toNeutral.anthropic(event, parsed) : toNeutral.openai(parsed);
          for (const line of lines) emit(line);
        });
      });
      upstreamRes.on('end', () => {
        if (anthropicOut) { const tail = anthropicOut.close(); if (tail) { bytes += Buffer.byteLength(tail); res.write(tail); } }
        res.end();
        done(200);
      });
      upstreamRes.on('error', () => { res.end(); done(502); });
    }, (err) => {
      if (!res.headersSent) send(res, 502, errorFor(shape, 502, `the upstream could not be reached: ${err.message}`));
      else res.end();
      done(502);
    });
  });
}

function safeJson(raw: string): Block {
  try { return JSON.parse(raw); } catch { return {}; }
}

/** An OpenAI completion back to the neutral shape. */
function fromOpenaiCompletion(body: Block, model: string): Block {
  const choice = body?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  return {
    model,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: String(msg.content ?? ''),
      ...(msg.reasoning_content ? { thinking: String(msg.reasoning_content) } : {}),
      ...(Array.isArray(msg.tool_calls) && msg.tool_calls.length
        ? {
          tool_calls: msg.tool_calls.map((c: Block) => ({
            id: String(c?.id ?? ''),
            function: { name: String(c?.function?.name ?? ''), arguments: safeArgs(String(c?.function?.arguments ?? '')) },
          })),
        }
        : {}),
    },
    done: true,
    done_reason: choice.finish_reason === 'length' ? 'length' : 'stop',
    prompt_eval_count: Number(body?.usage?.prompt_tokens ?? 0),
    eval_count: Number(body?.usage?.completion_tokens ?? 0),
  };
}

/**
 * The Anthropic SSE grammar, for a client that asked in that shape.
 *
 * Its own small state machine rather than a reuse of `anthropic.ts`'s, because
 * that one drives a socket directly and this one has to return strings for the
 * caller to write — the same events, produced by something composable. The
 * grammar is the point: a client that receives a delta for a block it was
 * never told about does not render partial output, it throws.
 */
class AnthropicOut {
  private started = false;

  private textOpen = false;

  private readonly id = `msg_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  constructor(private readonly model: string) {}

  push(line: Block): string {
    let out = '';
    if (!this.started) {
      this.started = true;
      out += frame('message_start', {
        type: 'message_start',
        message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: Number(line.prompt_eval_count ?? 0), output_tokens: 0 } },
      });
    }
    const content = String(line?.message?.content ?? '');
    if (content) {
      if (!this.textOpen) {
        this.textOpen = true;
        out += frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      }
      out += frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } });
    }
    if (line?.done) {
      if (this.textOpen) { out += frame('content_block_stop', { type: 'content_block_stop', index: 0 }); this.textOpen = false; }
      out += frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: line.done_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: Number(line.eval_count ?? 0) },
      });
      out += frame('message_stop', { type: 'message_stop' });
      this.started = false;
    }
    return out;
  }

  /** Closes an unterminated stream, so a dropped upstream is not a hung client. */
  close(): string {
    if (!this.started) return '';
    let out = '';
    if (this.textOpen) out += frame('content_block_stop', { type: 'content_block_stop', index: 0 });
    out += frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
    out += frame('message_stop', { type: 'message_stop' });
    this.started = false;
    this.textOpen = false;
    return out;
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function embed(args: HandleArgs): Promise<Result> {
  const { req, res, target, shape } = args;
  const body = await readBody(req, config.maxBodyBytes);
  const model = String(body?.model ?? '');
  const neutral = shape === 'openai' ? { model, input: body.input } : body;
  const payload = JSON.stringify(ollamaToOpenaiEmbedRequest(neutral));

  return await new Promise<Result>((resolve) => {
    open(target, '/v1/embeddings', 'POST', payload, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      void collect(upstreamRes).then((raw) => {
        if (status >= 400) {
          send(res, status, errorFor(shape, status, raw.slice(0, 500) || `the upstream answered ${status}`));
          resolve({ status, ...NOTHING });
          return;
        }
        const parsed = safeJson(raw);
        // The client asked in its own shape and gets its own shape back. Both
        // conversions go through the neutral one, which for embeddings is a
        // list of vectors and nothing else.
        const out = shape === 'openai'
          ? parsed
          : openaiToOllamaEmbedResponse(parsed, model);
        send(res, 200, out);
        resolve({ status: 200, bytes: Buffer.byteLength(JSON.stringify(out)), tokens: 0, ttftMs: null });
      });
    }, (err) => {
      send(res, 502, errorFor(shape, 502, `the upstream could not be reached: ${err.message}`));
      resolve({ status: 502, ...NOTHING });
    });
  });
}

async function models(args: HandleArgs): Promise<Result> {
  const { res, target, shape } = args;
  return await new Promise<Result>((resolve) => {
    open(target, pathFor('models', target.api), 'GET', null, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      void collect(upstreamRes).then((raw) => {
        if (status >= 400) {
          send(res, status, errorFor(shape, status, raw.slice(0, 500) || `the upstream answered ${status}`));
          resolve({ status, ...NOTHING });
          return;
        }
        const parsed = safeJson(raw);
        // Both hosted shapes answer `{data:[{id}]}`. A client asking in
        // Ollama's shape wants `{models:[{name}]}`, and one asking in OpenAI's
        // gets the upstream's own answer unchanged.
        const out = shape === 'ollama' ? hostedModelsToTags(parsed) : parsed;
        send(res, 200, out);
        resolve({ status: 200, bytes: Buffer.byteLength(JSON.stringify(out)), tokens: 0, ttftMs: null });
      });
    }, (err) => {
      send(res, 502, errorFor(shape, 502, `the upstream could not be reached: ${err.message}`));
      resolve({ status: 502, ...NOTHING });
    });
  });
}

/**
 * `/api/ps` against a hosted upstream: nothing is resident.
 *
 * An empty list rather than a 501, because it is TRUE — no model is loaded on
 * this machine — and because a client polling it treats an error as "the
 * server is broken" and an empty list as "nothing loaded", which is what has
 * actually happened.
 */
function residentNone(res: http.ServerResponse, _shape: ApiShape): Result {
  const out = { models: [] };
  send(res, 200, out);
  return { status: 200, bytes: Buffer.byteLength(JSON.stringify(out)), tokens: 0, ttftMs: null };
}

/**
 * `/api/show` against a hosted upstream.
 *
 * A hosted catalogue publishes no per-model metadata at all — no parameter
 * count, no quantisation, no context length, no capability list. What comes
 * back is the shape of Ollama's answer with the fields it cannot know left
 * empty, which is honest and is what a client checks for. Inventing a context
 * length here would be worse than saying nothing: a client sizing a window
 * from it would size it from a guess.
 */
async function show(args: HandleArgs): Promise<Result> {
  const { req, res } = args;
  const body = await readBody(req, config.maxBodyBytes);
  const out = {
    model_info: {},
    details: { family: '', parameter_size: '', quantization_level: '' },
    capabilities: [] as string[],
    model: String(body?.model ?? ''),
  };
  send(res, 200, out);
  return { status: 200, bytes: Buffer.byteLength(JSON.stringify(out)), tokens: 0, ttftMs: null };
}

/** `/api/version`. perch's own, since the upstream is not an Ollama. */
function versionOf(res: http.ServerResponse, target: UpstreamTarget): Result {
  const out = { version: `perch/${config.version} (${target.api} upstream)` };
  send(res, 200, out);
  return { status: 200, bytes: Buffer.byteLength(JSON.stringify(out)), tokens: 0, ttftMs: null };
}

/**
 * `/v1/messages/count_tokens` against an upstream that is not Anthropic.
 *
 * Estimated rather than asked, because neither the OpenAI shape nor Ollama has
 * an endpoint for it. Four characters per token is the usual rule of thumb and
 * is what `anthropic.ts` already uses against Ollama, so the answer is at
 * least consistent across both upstreams rather than differing by which one
 * happens to be configured.
 */
async function countTokens(args: HandleArgs): Promise<Result> {
  const { req, res, target, shape } = args;
  if (target.api === 'anthropic') {
    // The real thing is available; ask it rather than guessing.
    const body = await readBody(req, config.maxBodyBytes);
    const payload = JSON.stringify(body);
    return await new Promise<Result>((resolve) => {
      open(target, '/v1/messages/count_tokens', 'POST', payload, (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        void collect(upstreamRes).then((raw) => {
          send(res, status, status >= 400 ? errorFor(shape, status, raw.slice(0, 500)) : safeJson(raw));
          resolve({ status, bytes: Buffer.byteLength(raw), tokens: 0, ttftMs: null });
        });
      }, (err) => {
        send(res, 502, errorFor(shape, 502, err.message));
        resolve({ status: 502, ...NOTHING });
      });
    });
  }
  const body = await readBody(req, config.maxBodyBytes);
  const chars = JSON.stringify(body?.messages ?? []).length + String(body?.system ?? '').length;
  const out = { input_tokens: Math.max(1, Math.ceil(chars / 4)) };
  send(res, 200, out);
  return { status: 200, bytes: Buffer.byteLength(JSON.stringify(out)), tokens: 0, ttftMs: null };
}

// Exported for the tests, which assert the wire shapes directly.
export { tagsToOpenaiModels, fromOpenaiCompletion, AnthropicOut };
