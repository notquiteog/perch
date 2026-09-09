// Turning one wire shape into another, both ways, through one hub.
//
// ── The hub is Ollama's shape, and that is a choice worth defending ────────
//
// Three shapes talking to three shapes is nine conversions written by hand and
// nine places for one of them to be subtly wrong. Through a hub it is six, and
// more importantly it is six that compose: every new shape added later costs
// two functions rather than six.
//
// Ollama's is the hub because perch already speaks it everywhere — the route
// table is written in it, `anthropic.ts` already converts to and from it, and
// on the default configuration it is also the upstream, so the common case
// converts nothing at all. Picking a neutral fourth shape would have meant a
// conversion on the path that today has none.
//
// The cost is honest and worth stating: a client speaking Anthropic to an
// upstream speaking OpenAI is converted twice, and anything neither shape
// carries is lost at the first hop rather than the second. What is actually
// lost is listed against each function.
//
// ── Everything here is pure ───────────────────────────────────────────────
//
// No sockets, no state, no config. `shapes.test.ts` asserts the wire shapes
// directly, which matters more than usual: a client written against one of
// these APIs fails closed on a malformed event — it does not degrade, it
// errors — so "nearly right" and "broken" are the same outcome.
import { flattenContent, imagesOf, toOllamaMessages, toOllamaTools } from './anthropic.js';

type Block = Record<string, any>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ── OpenAI → Ollama ───────────────────────────────────────────────────────

/**
 * One OpenAI content field, flattened to the text Ollama wants.
 *
 * OpenAI allows either a string or a list of typed parts, and the list is the
 * case that matters: a client sending `[{type:'text',...}]` and getting
 * `[object Object]` into the prompt produces plausible-looking nonsense rather
 * than an error, which is the worst kind to find later.
 */
export function openaiText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p: Block) => (p?.type === 'text' ? str(p.text) : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Base64 images out of one OpenAI content field, in Ollama's `images` form.
 *
 * Only `data:` URLs. A remote `https://` image URL is dropped rather than
 * fetched: perch would be the thing making that request, from inside the
 * operator's network, at the direction of whoever wrote the prompt. That is a
 * request forgery with extra steps, and no amount of translating is worth it.
 */
export function openaiImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p: Block) => p?.type === 'image_url' && /^data:[^;]+;base64,/.test(str(p.image_url?.url)))
    .map((p: Block) => str(p.image_url.url).replace(/^data:[^;]+;base64,/, ''));
}

/** The message list. OpenAI's `tool` role maps straight onto Ollama's. */
export function openaiToOllamaMessages(messages: unknown): Block[] {
  if (!Array.isArray(messages)) return [];
  const out: Block[] = [];
  for (const m of messages) {
    const role = str(m?.role) || 'user';
    const calls = Array.isArray(m?.tool_calls)
      ? m.tool_calls.map((c: Block) => ({
        function: {
          name: str(c?.function?.name),
          // OpenAI sends arguments as a JSON STRING; Ollama wants an object.
          // A string left unparsed reaches the model as a quoted blob it
          // cannot read, and the model then calls the tool with nothing.
          arguments: safeParse(str(c?.function?.arguments)),
        },
      }))
      : [];
    const text = openaiText(m?.content);
    const images = openaiImages(m?.content);
    if (!text && !images.length && !calls.length) continue;
    out.push({
      role: role === 'tool' ? 'tool' : role === 'assistant' ? 'assistant' : role === 'system' ? 'system' : 'user',
      content: text,
      ...(images.length ? { images } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(m?.tool_call_id ? { tool_call_id: str(m.tool_call_id) } : {}),
    });
  }
  return out;
}

function safeParse(s: string): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

/**
 * The whole `/api/chat` body for one OpenAI chat request.
 *
 * `/v1/completions` — the legacy single-`prompt` form — arrives here too, and
 * is turned into a one-message conversation rather than refused. A client
 * still using it is a client that will not be updated.
 */
export function openaiToOllamaRequest(body: Block): Block {
  const messages = Array.isArray(body.messages)
    ? openaiToOllamaMessages(body.messages)
    : [{ role: 'user', content: openaiText(body.prompt) }];
  const stop = typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop : undefined;
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((t: Block) => t?.function?.name).map((t: Block) => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: str(t.function.description),
        parameters: t.function.parameters ?? {},
      },
    }))
    : undefined;
  return {
    model: str(body.model),
    messages,
    stream: Boolean(body.stream),
    ...(tools?.length ? { tools } : {}),
    // `reasoning_effort` is OpenAI's switch and takes a level; Ollama's takes
    // a boolean or a level and understands the same words. `none` is the one
    // value that must not turn reasoning on.
    ...(body.reasoning_effort && body.reasoning_effort !== 'none' ? { think: body.reasoning_effort } : {}),
    options: {
      ...(body.max_tokens !== undefined || body.max_completion_tokens !== undefined
        ? { num_predict: Number(body.max_completion_tokens ?? body.max_tokens) } : {}),
      ...(body.temperature !== undefined ? { temperature: Number(body.temperature) } : {}),
      ...(body.top_p !== undefined ? { top_p: Number(body.top_p) } : {}),
      ...(body.presence_penalty !== undefined ? { presence_penalty: Number(body.presence_penalty) } : {}),
      ...(body.frequency_penalty !== undefined ? { frequency_penalty: Number(body.frequency_penalty) } : {}),
      ...(body.seed !== undefined ? { seed: Number(body.seed) } : {}),
      ...(stop?.length ? { stop } : {}),
    },
  };
}

// ── Ollama → OpenAI ───────────────────────────────────────────────────────

/** A completion id in OpenAI's form. Clients match on the prefix. */
export function completionId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Why the model stopped, in OpenAI's vocabulary.
 *
 * A client reading an unknown `finish_reason` usually treats the turn as
 * unfinished, so an untranslated `"stop"` from the wrong vocabulary is not a
 * cosmetic difference — it is a loop that never ends.
 */
export function finishReason(doneReason: string | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_calls';
  if (doneReason === 'length') return 'length';
  return 'stop';
}

/** Ollama's tool calls in OpenAI's form: arguments back to a JSON string. */
export function toOpenaiToolCalls(msg: Block | undefined): Block[] {
  return (msg?.tool_calls ?? []).map((c: Block, i: number) => ({
    id: `call_${Date.now().toString(36)}${i}`,
    type: 'function',
    function: {
      name: str(c?.function?.name),
      arguments: typeof c?.function?.arguments === 'string'
        ? c.function.arguments
        : JSON.stringify(c?.function?.arguments ?? {}),
    },
  }));
}

/** The whole `/api/chat` body for one Ollama request, as an OpenAI request. */
export function ollamaToOpenaiRequest(body: Block): Block {
  const o: Block = body.options ?? {};
  const messages = (Array.isArray(body.messages) ? body.messages : []).map((m: Block) => {
    const images: string[] = Array.isArray(m.images) ? m.images : [];
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    const base: Block = { role: str(m.role) || 'user' };
    if (base.role === 'tool') {
      // OpenAI requires the id of the call being answered. Ollama does not
      // always carry one, and a `tool` message without it is a 400 that reads
      // like a malformed conversation — so an unanswerable one is demoted to a
      // user turn, which the model can still read.
      const id = str(m.tool_call_id);
      return id ? { role: 'tool', tool_call_id: id, content: str(m.content) } : { role: 'user', content: str(m.content) };
    }
    if (images.length) {
      base.content = [
        ...(m.content ? [{ type: 'text', text: str(m.content) }] : []),
        // Ollama carries raw base64 with no media type. PNG is the safe guess:
        // every vision endpoint tested sniffs the bytes and ignores the label,
        // and one that did not would reject a JPEG either way round.
        ...images.map((d) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${d}` } })),
      ];
    } else {
      base.content = str(m.content);
    }
    if (calls.length) base.tool_calls = toOpenaiToolCalls(m);
    return base;
  });

  // `/api/generate` is Ollama's single-`prompt` form; it becomes one user
  // turn, with `system` lifted in front where the caller sent one.
  const fromPrompt = !messages.length && (body.prompt !== undefined || body.system !== undefined)
    ? [
      ...(body.system ? [{ role: 'system', content: str(body.system) }] : []),
      { role: 'user', content: str(body.prompt) },
    ]
    : [];

  return {
    model: str(body.model),
    messages: messages.length ? messages : fromPrompt,
    stream: Boolean(body.stream),
    ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
    ...(body.think && body.think !== false ? { reasoning_effort: body.think === true ? 'medium' : String(body.think) } : {}),
    ...(o.num_predict !== undefined && o.num_predict > 0 ? { max_tokens: Number(o.num_predict) } : {}),
    ...(o.temperature !== undefined ? { temperature: Number(o.temperature) } : {}),
    ...(o.top_p !== undefined ? { top_p: Number(o.top_p) } : {}),
    ...(o.presence_penalty !== undefined ? { presence_penalty: Number(o.presence_penalty) } : {}),
    ...(o.frequency_penalty !== undefined ? { frequency_penalty: Number(o.frequency_penalty) } : {}),
    ...(o.seed !== undefined ? { seed: Number(o.seed) } : {}),
    ...(Array.isArray(o.stop) && o.stop.length ? { stop: o.stop } : {}),
    // Deliberately NOT forwarded: `top_k`, `min_p`, `repeat_penalty`,
    // `repeat_last_n`, `num_ctx`, `keep_alive`. Real OpenAI answers 400 to a
    // parameter it does not know, so forwarding an Ollama-only knob would turn
    // a working request into a failed one — and the failure would look like a
    // bad prompt rather than a bad translation. A dropped sampling knob costs
    // some control; a 400 costs the whole generation.
  };
}

/** The non-streaming response body, from one finished Ollama answer. */
export function toOpenaiCompletion(ollama: Block, model: string): Block {
  const calls = toOpenaiToolCalls(ollama?.message);
  return {
    id: completionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: str(ollama?.message?.content) || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      finish_reason: finishReason(ollama?.done_reason, calls.length > 0),
    }],
    usage: {
      prompt_tokens: Number(ollama?.prompt_eval_count ?? 0),
      completion_tokens: Number(ollama?.eval_count ?? 0),
      total_tokens: Number(ollama?.prompt_eval_count ?? 0) + Number(ollama?.eval_count ?? 0),
    },
  };
}

/** One streaming chunk, in OpenAI's `chat.completion.chunk` form. */
export function toOpenaiChunk(model: string, id: string, delta: Block, finish: string | null): Block {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

// ── Ollama → Anthropic (request) ──────────────────────────────────────────

/**
 * One Ollama message list as Anthropic's `system` plus `messages`.
 *
 * The mirror of `toOllamaMessages` in anthropic.ts. Three things the Messages
 * API insists on, each of which is a refusal rather than a degradation:
 *
 *   - `system` is a top-level field and the role is rejected outright.
 *   - Turns must alternate, and two user turns in a row are a 400. Ollama has
 *     no such rule, so consecutive same-role turns are merged.
 *   - A `tool` message becomes a `tool_result` block inside a USER turn; there
 *     is no tool role.
 */
export function ollamaToAnthropicMessages(messages: unknown): { system: string; messages: Block[] } {
  const list = Array.isArray(messages) ? messages : [];
  const systems: string[] = [];
  const out: Block[] = [];

  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) { last.content.push(...blocks); return; }
    out.push({ role, content: blocks });
  };

  for (const m of list) {
    const role = str(m?.role);
    if (role === 'system') { const t = str(m.content); if (t) systems.push(t); continue; }

    if (role === 'tool') {
      // Anthropic requires the id of the call being answered, and a
      // `tool_result` without one is a 400. Ollama does not always carry one,
      // so a result that cannot be attributed goes as plain text instead —
      // which the model can still read, unlike a rejected request.
      const id = str(m.tool_call_id);
      push('user', [id
        ? { type: 'tool_result', tool_use_id: id, content: str(m.content) }
        : { type: 'text', text: str(m.content) }]);
      continue;
    }

    const blocks: Block[] = [];
    if (m?.content) blocks.push({ type: 'text', text: str(m.content) });
    for (const d of Array.isArray(m?.images) ? m.images : []) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: str(d) } });
    }
    for (const [i, c] of (Array.isArray(m?.tool_calls) ? m.tool_calls : []).entries()) {
      blocks.push({
        type: 'tool_use',
        id: str(c?.id) || `toolu_${Date.now().toString(36)}${i}`,
        name: str(c?.function?.name),
        input: typeof c?.function?.arguments === 'string' ? safeParse(c.function.arguments) : (c?.function?.arguments ?? {}),
      });
    }
    push(role === 'assistant' ? 'assistant' : 'user', blocks);
  }

  // Several system messages are joined rather than the last one winning: a
  // dropped instruction produces a model that mostly behaves, which is much
  // harder to spot than one that plainly does not.
  return { system: systems.join('\n\n'), messages: out };
}

/** Ollama's tool definitions in Anthropic's form. */
export function ollamaToAnthropicTools(tools: unknown): Block[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = tools
    .filter((t: Block) => t?.function?.name)
    .map((t: Block) => ({
      name: t.function.name,
      description: str(t.function.description),
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  return out.length ? out : undefined;
}

/**
 * Models that still accept `temperature` on the Messages API.
 *
 * The trap for an adapter written from older documentation: `temperature`,
 * `top_p` and `top_k` were REMOVED on the current generation, and sending one
 * is not ignored — it is a 400 and the whole generation fails.
 *
 * An allowlist, so a model released after this was written is treated as not
 * taking it. That is the safe direction: omitting temperature costs some
 * control over how varied the answer is, while sending it to a model that
 * refuses it costs the answer.
 */
export function anthropicTakesSampling(model: string): boolean {
  return /^claude-(3|opus-4-[0-6]|sonnet-4|haiku-4)/i.test(str(model));
}

/** The whole `/v1/messages` body for one Ollama chat request. */
export function ollamaToAnthropicRequest(body: Block, defaultMaxTokens = 4096): Block {
  const o: Block = body.options ?? {};
  const { system, messages } = ollamaToAnthropicMessages(
    Array.isArray(body.messages) && body.messages.length
      ? body.messages
      : [
        ...(body.system ? [{ role: 'system', content: body.system }] : []),
        ...(body.prompt !== undefined ? [{ role: 'user', content: body.prompt }] : []),
      ],
  );
  const model = str(body.model);
  const tools = ollamaToAnthropicTools(body.tools);
  const sampling = anthropicTakesSampling(model);
  return {
    model,
    messages,
    ...(system ? { system } : {}),
    stream: Boolean(body.stream),
    // Required — there is no "as much as it takes" on this API, and a request
    // without it is refused rather than defaulted.
    max_tokens: Number.isFinite(o.num_predict) && o.num_predict > 0 ? Number(o.num_predict) : defaultMaxTokens,
    ...(tools ? { tools } : {}),
    // Anthropic's reasoning parameter carries a type, not a boolean.
    ...(body.think && body.think !== false ? { thinking: { type: 'adaptive' } } : {}),
    ...(sampling && o.temperature !== undefined ? { temperature: Number(o.temperature) } : {}),
    ...(sampling && o.top_p !== undefined ? { top_p: Number(o.top_p) } : {}),
    ...(sampling && o.top_k !== undefined ? { top_k: Number(o.top_k) } : {}),
    ...(Array.isArray(o.stop) && o.stop.length ? { stop_sequences: o.stop } : {}),
  };
}

// ── Anthropic → Ollama (response) ─────────────────────────────────────────

/** Why the model stopped, back in Ollama's vocabulary. */
export function ollamaDoneReason(stop: string | undefined): string {
  return stop === 'max_tokens' ? 'length' : 'stop';
}

/**
 * One finished Anthropic message as an Ollama `/api/chat` answer.
 *
 * Thinking blocks are dropped rather than concatenated into the content.
 * Ollama carries reasoning in a separate `thinking` field and every client
 * downstream reads it there; folding it into `content` would put the model's
 * working-out into somebody's email.
 */
export function anthropicToOllamaMessage(msg: Block, model: string): Block {
  const blocks: Block[] = Array.isArray(msg?.content) ? msg.content : [];
  const text = blocks.filter((b) => b?.type === 'text').map((b) => str(b.text)).join('');
  const thinking = blocks.filter((b) => b?.type === 'thinking').map((b) => str(b.thinking ?? b.text)).join('');
  const calls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({
    id: str(b.id),
    function: { name: str(b.name), arguments: b.input ?? {} },
  }));
  return {
    model,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: text,
      ...(thinking ? { thinking } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
    },
    done: true,
    done_reason: ollamaDoneReason(str(msg?.stop_reason)),
    prompt_eval_count: Number(msg?.usage?.input_tokens ?? 0),
    eval_count: Number(msg?.usage?.output_tokens ?? 0),
  };
}

// ── Embeddings ────────────────────────────────────────────────────────────

/**
 * Ollama's `/api/embed` request as an OpenAI `/v1/embeddings` one.
 *
 * `input` is a string or a list of strings in both, so this is nearly a
 * rename. `keep_alive` and `truncate` are Ollama's alone and are dropped:
 * there is no model of ours to keep alive on a hosted service, and OpenAI
 * truncates or refuses by its own rule either way.
 */
export function ollamaToOpenaiEmbedRequest(body: Block): Block {
  const input = body.input ?? body.prompt ?? [];
  return { model: str(body.model), input, encoding_format: 'float' };
}

/** An OpenAI embeddings reply as Ollama's `{ embeddings: [...] }`. */
export function openaiToOllamaEmbedResponse(body: Block, model: string): Block {
  // Sorted by index rather than trusted in order: the API documents the field,
  // and a reordered batch pairs every vector with the wrong text — which
  // produces an index that is wrong rather than empty, and nothing downstream
  // can detect it.
  const rows = [...(Array.isArray(body?.data) ? body.data : [])].sort((a: Block, b: Block) => (a.index ?? 0) - (b.index ?? 0));
  return {
    model,
    embeddings: rows.map((d: Block) => (Array.isArray(d?.embedding) ? d.embedding : [])),
    prompt_eval_count: Number(body?.usage?.prompt_tokens ?? 0),
  };
}

/** An Ollama embeddings reply as OpenAI's `{ data: [...] }`. */
export function ollamaToOpenaiEmbedResponse(body: Block, model: string): Block {
  const vectors: number[][] = Array.isArray(body?.embeddings) ? body.embeddings : [];
  return {
    object: 'list',
    model,
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    usage: { prompt_tokens: Number(body?.prompt_eval_count ?? 0), total_tokens: Number(body?.prompt_eval_count ?? 0) },
  };
}

// ── Catalogues ────────────────────────────────────────────────────────────

/**
 * An OpenAI or Anthropic model list as Ollama's `/api/tags`.
 *
 * The sizes are zero and `modified_at` is empty, and both are deliberate. A
 * hosted catalogue reports neither, and inventing a plausible number would put
 * a figure on a page an operator uses to decide what fits on a disk. Zero
 * reads as "not applicable", which is the truth.
 */
export function hostedModelsToTags(body: Block): Block {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return {
    models: rows
      .map((m: Block) => str(m?.id) || str(m?.name))
      .filter(Boolean)
      .sort((a: string, b: string) => a.localeCompare(b))
      .map((name: string) => ({
        name,
        model: name,
        size: 0,
        modified_at: '',
        details: {},
      })),
  };
}

/** Ollama's `/api/tags` as an OpenAI model list. */
export function tagsToOpenaiModels(body: Block): Block {
  const rows = Array.isArray(body?.models) ? body.models : [];
  return {
    object: 'list',
    data: rows
      .map((m: Block) => str(m?.name) || str(m?.model))
      .filter(Boolean)
      .map((id: string) => ({ id, object: 'model', created: 0, owned_by: 'library' })),
  };
}

// Re-exported so a caller converting Anthropic in either direction has one
// import rather than two, and so `anthropic.ts` stays the place those live.
export { flattenContent, imagesOf, toOllamaMessages, toOllamaTools };
