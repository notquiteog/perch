// The Anthropic shape, spoken by the chat service.
//
// perch already answers two of the three wire formats a client might have been
// written against — Ollama's own and OpenAI's — because Ollama serves both and
// the proxy can pipe them through untouched. Anthropic's Messages API is the
// third, and Ollama does not serve it, so this file is the difference.
//
// ── This is the one place perch parses a body, and that is a real cost ──────
//
// proxy.ts opens with "it is a pipe, not a parser", and every security
// property it claims follows from that: bodies are streamed through, so perch
// never holds anybody's prompt in memory, let alone on disk. A translator
// cannot keep that promise — it has to read the request to rewrite it.
//
// So the promise is narrowed rather than quietly broken. What is bounded here:
//
//   - Only two paths reach this code. Everything else on the chat service is
//     still piped, and the other four services never touch it.
//   - The request body is read with a hard ceiling and discarded when the
//     response ends. Nothing is written anywhere, and nothing is logged: the
//     activity ring records the path and the byte count, exactly as it does
//     for a piped request, and never the content.
//   - The RESPONSE is still streamed. Ollama's lines are translated one at a
//     time as they arrive, so a long generation still arrives token by token
//     and the whole answer is never assembled in memory.
//
// ── Everything here is a refusal if it is wrong ────────────────────────────
//
// The functions below are pure and exported so `anthropic.test.ts` can assert
// the wire shape directly. That matters more than usual: a client written
// against this API fails closed on a malformed event — it does not degrade, it
// errors — so "nearly right" and "broken" are the same outcome.
import http from 'node:http';
import { config } from './config.js';
import { logger } from './log.js';

const log = logger('anthropic');

/** Anthropic's version header. Sent by clients; accepted, not enforced. */
export const ANTHROPIC_VERSION = '2023-06-01';

// ── Request: Anthropic → Ollama ────────────────────────────────────────────

type Block = Record<string, any>;

/**
 * One Anthropic content field, flattened to the text Ollama wants.
 *
 * `content` is either a string or a list of blocks, and the list is the case
 * that matters: a client sending `[{type:'text',...}]` and getting `[object
 * Object]` into the prompt is a bug that produces plausible-looking nonsense
 * rather than an error, which is the worst kind to find later.
 */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: Block) => {
      if (b?.type === 'text') return String(b.text ?? '');
      // A tool result is the client reporting back. Ollama's chat API takes it
      // as a `tool` role message, which `toOllamaMessages` produces; here it
      // is only the text of one.
      if (b?.type === 'tool_result') return flattenContent(b.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Base64 images out of one Anthropic content field, in Ollama's `images` form. */
export function imagesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: Block) => b?.type === 'image' && b?.source?.type === 'base64' && b.source.data)
    .map((b: Block) => String(b.source.data));
}

/**
 * The message list, with the system prompt folded back in.
 *
 * Anthropic keeps `system` out of the messages and Ollama expects it as the
 * first one, so this is the mirror image of the lift every client-side adapter
 * does. It goes FIRST and there is only ever one, because a system message
 * after a user turn is not a system prompt to Ollama's chat template — it is
 * an instruction the model may well ignore.
 */
export function toOllamaMessages(body: Block): Block[] {
  const out: Block[] = [];
  const system = flattenContent(body.system);
  if (system) out.push({ role: 'system', content: system });
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    // A tool result arrives inside a user turn in this shape and has to leave
    // as its own `tool` message, or the model sees the result of a call it
    // does not believe it made.
    const results = Array.isArray(m.content) ? m.content.filter((b: Block) => b?.type === 'tool_result') : [];
    for (const r of results) {
      out.push({ role: 'tool', content: flattenContent(r.content), tool_call_id: r.tool_use_id });
    }
    const text = Array.isArray(m.content)
      ? flattenContent(m.content.filter((b: Block) => b?.type !== 'tool_result'))
      : flattenContent(m.content);
    const images = imagesOf(m.content);
    const calls = Array.isArray(m.content)
      ? m.content.filter((b: Block) => b?.type === 'tool_use').map((b: Block) => ({
        function: { name: b.name, arguments: b.input ?? {} },
      }))
      : [];
    // A turn that was nothing but tool results has already been emitted above;
    // adding an empty message after it makes some chat templates emit a blank
    // turn the model then tries to continue.
    if (!text && !images.length && !calls.length) continue;
    out.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: text,
      ...(images.length ? { images } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
    });
  }
  return out;
}

/**
 * Tool definitions, Anthropic's shape to Ollama's.
 *
 * The schema itself is the same JSON Schema on both sides; only the envelope
 * differs — `input_schema` against `function.parameters`.
 */
export function toOllamaTools(tools: unknown): Block[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = tools
    // Server-side tools (`type: 'web_search_...'`) are Anthropic's to run and
    // this is not Anthropic. Passing one to Ollama would define a tool the
    // model can call and nothing can answer, so they are dropped: a client
    // that asked for one gets a model that does not call it, rather than a
    // conversation that deadlocks on a tool result that never comes.
    .filter((t: Block) => t?.name && t?.input_schema)
    .map((t: Block) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema },
    }));
  return out.length ? out : undefined;
}

/** The whole `/api/chat` body for one Messages API request. */
export function toOllamaRequest(body: Block): Block {
  const stop = Array.isArray(body.stop_sequences) ? body.stop_sequences : undefined;
  return {
    model: String(body.model ?? ''),
    messages: toOllamaMessages(body),
    stream: Boolean(body.stream),
    ...(toOllamaTools(body.tools) ? { tools: toOllamaTools(body.tools) } : {}),
    // `think` is Ollama's own switch. Anthropic's `thinking` parameter carries
    // a type rather than a boolean, and `disabled` is the one value that must
    // not turn reasoning on.
    ...(body.thinking && body.thinking.type && body.thinking.type !== 'disabled' ? { think: true } : {}),
    options: {
      // Required on the way in, so it is always something on the way out.
      num_predict: Number.isFinite(body.max_tokens) ? Number(body.max_tokens) : 1024,
      ...(body.temperature !== undefined ? { temperature: Number(body.temperature) } : {}),
      ...(body.top_p !== undefined ? { top_p: Number(body.top_p) } : {}),
      ...(body.top_k !== undefined ? { top_k: Number(body.top_k) } : {}),
      ...(stop?.length ? { stop } : {}),
    },
  };
}

// ── Response: Ollama → Anthropic ───────────────────────────────────────────

/** A message id in Anthropic's form. Clients match on the prefix. */
export function messageId(): string {
  return `msg_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Why the model stopped, in the vocabulary the caller expects.
 *
 * A client that reads an unknown `stop_reason` usually treats the turn as
 * unfinished, so an untranslated `"stop"` is not a cosmetic difference — it is
 * a loop that never terminates.
 */
export function stopReason(doneReason: string | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_use';
  if (doneReason === 'length') return 'max_tokens';
  return 'end_turn';
}

/** The content blocks for one finished Ollama answer. */
export function toAnthropicContent(msg: Block | undefined): Block[] {
  const content: Block[] = [];
  const text = String(msg?.content ?? '');
  if (text) content.push({ type: 'text', text });
  for (const [i, call] of (msg?.tool_calls ?? []).entries()) {
    content.push({
      type: 'tool_use',
      id: `toolu_${Date.now().toString(36)}${i}`,
      name: call?.function?.name ?? '',
      // Ollama returns arguments as an object; some builds return a JSON
      // string. A client parses `input` as an object either way, so a string
      // that is never parsed here reaches it as a quoted blob it cannot read.
      input: typeof call?.function?.arguments === 'string'
        ? safeParse(call.function.arguments)
        : (call?.function?.arguments ?? {}),
    });
  }
  return content;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

/** The non-streaming response body. */
export function toAnthropicMessage(ollama: Block, model: string): Block {
  const content = toAnthropicContent(ollama?.message);
  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason(ollama?.done_reason, content.some((b) => b.type === 'tool_use')),
    stop_sequence: null,
    usage: {
      input_tokens: Number(ollama?.prompt_eval_count ?? 0),
      output_tokens: Number(ollama?.eval_count ?? 0),
    },
  };
}

// ── The streaming state machine ────────────────────────────────────────────

/**
 * SSE is a sequence with a grammar, not a series of independent lines.
 *
 * Every block must be opened before it is written to and closed before the
 * next one opens, and the message must be opened first and stopped last. A
 * client that receives a delta for a block it was never told about does not
 * render partial output — it throws. That is why this is a state machine with
 * a `started` flag rather than a per-line translation.
 */
export class MessageStream {
  private started = false;

  /**
   * Whether the closing events have already gone out.
   *
   * Both ends of the answer arrive: Ollama's `done` line closes the message,
   * and then the socket closing calls `end()` as the safety net for an answer
   * that was cut short. Without this flag the normal path — the common one —
   * sends `message_delta` and `message_stop` twice, and a client that has
   * already finished the message treats the second pair as events for a
   * message that does not exist.
   */
  private ended = false;

  private textOpen = false;

  private blocks = 0;

  private outputTokens = 0;

  constructor(private readonly model: string, private readonly id = messageId()) {}

  private static event(type: string, data: Block): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  }

  /** The events for one line of Ollama's NDJSON. */
  next(line: Block): string {
    let out = '';
    if (!this.started) {
      this.started = true;
      out += MessageStream.event('message_start', {
        message: {
          id: this.id,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: Number(line?.prompt_eval_count ?? 0), output_tokens: 0 },
        },
      });
    }

    const piece = String(line?.message?.content ?? '');
    if (piece) {
      if (!this.textOpen) {
        this.textOpen = true;
        out += MessageStream.event('content_block_start', { index: this.blocks, content_block: { type: 'text', text: '' } });
      }
      out += MessageStream.event('content_block_delta', { index: this.blocks, delta: { type: 'text_delta', text: piece } });
      this.outputTokens += 1;
    }

    const calls = line?.message?.tool_calls ?? [];
    if (calls.length) {
      // Text and tool calls are different blocks, so the text one closes here.
      if (this.textOpen) { out += MessageStream.event('content_block_stop', { index: this.blocks }); this.textOpen = false; this.blocks += 1; }
      for (const block of toAnthropicContent({ tool_calls: calls })) {
        out += MessageStream.event('content_block_start', { index: this.blocks, content_block: { ...block, input: {} } });
        // Ollama delivers a tool call complete rather than a token at a time,
        // so the arguments go out as one `input_json_delta`. The client
        // accumulates `partial_json` either way, so one delta is a valid
        // stream and not a special case it has to know about.
        out += MessageStream.event('content_block_delta', { index: this.blocks, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
        out += MessageStream.event('content_block_stop', { index: this.blocks });
        this.blocks += 1;
      }
    }

    if (line?.done) out += this.end(String(line.done_reason ?? 'stop'), calls.length > 0, Number(line?.eval_count ?? this.outputTokens));
    return out;
  }

  /**
   * Close the message.
   *
   * Also used when the upstream dies mid-answer: a client left waiting on a
   * `message_stop` that never arrives hangs until its own timeout, so a
   * truncated answer is closed properly and reported as `max_tokens` rather
   * than abandoned.
   */
  end(doneReason: string, hasToolCalls: boolean, outputTokens = this.outputTokens): string {
    let out = '';
    if (!this.started || this.ended) return out;
    this.ended = true;
    if (this.textOpen) { out += MessageStream.event('content_block_stop', { index: this.blocks }); this.textOpen = false; this.blocks += 1; }
    out += MessageStream.event('message_delta', {
      delta: { stop_reason: stopReason(doneReason, hasToolCalls), stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    out += MessageStream.event('message_stop', {});
    return out;
  }
}

// ── Token counting ─────────────────────────────────────────────────────────

/**
 * An ESTIMATE, and the honest thing is to say so here rather than in a doc.
 *
 * Ollama exposes no token counter, so there is nothing to proxy. The choice is
 * between answering 404 and answering approximately, and 404 is worse than it
 * looks: a client uses this endpoint to decide whether a conversation still
 * fits, and one that cannot ask usually assumes it does and then fails on the
 * real request instead.
 *
 * Four characters per token is the usual rule for English prose and is wrong
 * in the safe direction for code, which tokenises denser. Callers needing an
 * exact count need a tokeniser for the specific model, which is not something
 * this proxy can have for every model on the box.
 */
export function estimateTokens(body: Block): number {
  let chars = flattenContent(body.system).length;
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    chars += flattenContent(m?.content).length;
  }
  if (Array.isArray(body.tools)) chars += JSON.stringify(body.tools).length;
  return Math.max(1, Math.ceil(chars / 4));
}

// ── The HTTP handler ───────────────────────────────────────────────────────

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Anthropic's error envelope, which is what a client's error handling reads. */
export function errorBody(type: string, message: string): Block {
  return { type: 'error', error: { type, message } };
}

/**
 * Read the request body, with a ceiling.
 *
 * The content-length check in proxy.ts runs first, but a chunked request has
 * no content-length to check — so the ceiling is enforced again on the bytes
 * actually received. Without this second check the one code path in perch that
 * buffers is also the one an unbounded upload could target.
 */
async function readBody(req: http.IncomingMessage, limit: number): Promise<Block> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export interface MessagesResult { status: number; bytes: number; tokens: number; ttftMs: number | null }

/**
 * `POST /v1/messages` — the Messages API, answered out of Ollama.
 *
 * Returns what the caller needs for the activity ring and the throughput
 * gauges, so this path is measured exactly like a piped one.
 */
export async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamUrl: string,
  started: number,
  // How to reach the upstream, when that is not a direct connection.
  agent?: http.Agent,
): Promise<MessagesResult> {
  let body: Block;
  try {
    body = await readBody(req, config.maxBodyBytes);
  } catch (e) {
    const tooLarge = (e as Error).message === 'request too large';
    send(res, tooLarge ? 413 : 400, errorBody('invalid_request_error', tooLarge ? 'request too large' : 'the request body is not valid JSON'));
    return { status: tooLarge ? 413 : 400, bytes: 0, tokens: 0, ttftMs: null };
  }
  if (!body?.model) {
    send(res, 400, errorBody('invalid_request_error', 'model is required'));
    return { status: 400, bytes: 0, tokens: 0, ttftMs: null };
  }
  // Required by the API being imitated, and load-bearing here: it becomes
  // `num_predict`, and a client that omitted it would get Ollama's default
  // rather than the error it was expecting to get from Anthropic.
  if (!Number.isFinite(body.max_tokens)) {
    send(res, 400, errorBody('invalid_request_error', 'max_tokens is required'));
    return { status: 400, bytes: 0, tokens: 0, ttftMs: null };
  }

  const model = String(body.model);
  const wantsStream = Boolean(body.stream);
  const upstream = new URL('/api/chat', upstreamUrl);
  const payload = JSON.stringify(toOllamaRequest(body));

  return await new Promise<MessagesResult>((resolve) => {
    let bytes = 0;
    let tokens = 0;
    let ttftMs: number | null = null;
    const stream = new MessageStream(model);
    let settled = false;
    const done = (status: number): void => {
      if (settled) return;
      settled = true;
      resolve({ status, bytes, tokens, ttftMs });
    };

    const upstreamReq = http.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || 80,
      method: 'POST',
      path: upstream.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      ...(agent ? { agent } : {}),
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      if (status >= 400) {
        // Ollama's error, in the envelope the caller's error handling reads.
        // A raw Ollama body here would be a 400 the client cannot classify.
        let raw = '';
        upstreamRes.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
        upstreamRes.on('end', () => {
          const type = status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : 'invalid_request_error';
          send(res, status, errorBody(type, raw.slice(0, 500) || `the model server answered ${status}`));
          done(status);
        });
        return;
      }

      if (!wantsStream) {
        let raw = '';
        upstreamRes.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
        upstreamRes.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            const out = JSON.stringify(toAnthropicMessage(parsed, model));
            bytes = Buffer.byteLength(out);
            tokens = Number(parsed?.eval_count ?? 0);
            ttftMs = Date.now() - started;
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes });
            res.end(out);
            done(200);
          } catch {
            send(res, 502, errorBody('api_error', 'the model server sent an answer that could not be read'));
            done(502);
          }
        });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // Ollama's lines are small and a buffering proxy in front of this
        // would hold them until the generation ended, which turns a streaming
        // endpoint into a slow non-streaming one with no error to show for it.
        'X-Accel-Buffering': 'no',
      });
      let buf = '';
      upstreamRes.on('data', (c: Buffer) => {
        if (ttftMs === null) ttftMs = Date.now() - started;
        buf += c.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let parsed: Block;
          try { parsed = JSON.parse(line); } catch { continue; }
          if (parsed.error) {
            res.write(`event: error\ndata: ${JSON.stringify(errorBody('api_error', String(parsed.error)))}\n\n`);
            continue;
          }
          if (parsed.done) tokens = Number(parsed.eval_count ?? tokens);
          const events = stream.next(parsed);
          if (events) { bytes += Buffer.byteLength(events); res.write(events); }
        }
      });
      upstreamRes.on('end', () => {
        // If the upstream stopped without a `done` line the message is still
        // open, and a client waiting for `message_stop` would hang on it until
        // its own timeout. Closing it as truncated is the honest ending.
        const tail = stream.end('length', false);
        if (tail) { bytes += Buffer.byteLength(tail); res.write(tail); }
        res.end();
        done(200);
      });
      upstreamRes.on('error', () => { res.destroy(); done(502); });
    });

    upstreamReq.setTimeout(config.upstreamIdleMs, () => upstreamReq.destroy(new Error('upstream idle timeout')));
    upstreamReq.on('error', (err) => {
      log.warn('upstream /api/chat failed', (err as Error).message);
      if (!res.headersSent) send(res, 502, errorBody('api_error', 'the model server is not answering'));
      else res.end();
      done(502);
    });
    // A caller that hangs up mid-generation should not leave the GPU working
    // on an answer nobody will read.
    res.on('close', () => { if (!res.writableFinished) { upstreamReq.destroy(); done(499); } });
    upstreamReq.end(payload);
  });
}

/** `POST /v1/messages/count_tokens`. See `estimateTokens` for what it can promise. */
export async function handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse): Promise<number> {
  try {
    const body = await readBody(req, config.maxBodyBytes);
    send(res, 200, { input_tokens: estimateTokens(body) });
    return 200;
  } catch {
    send(res, 400, errorBody('invalid_request_error', 'the request body is not valid JSON'));
    return 400;
  }
}
