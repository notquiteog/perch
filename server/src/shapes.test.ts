// Turning one wire shape into another.
//
// Every case here names a refusal it prevents rather than a preference it
// encodes. That distinction matters more than usual on this path: a client
// written against one of these APIs fails closed on a malformed event — it
// does not render partial output, it throws — so "nearly right" and "broken"
// are the same outcome, and none of these APIs has a version of itself that
// runs on a developer's machine to catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicTakesSampling,
  anthropicToOllamaMessage,
  finishReason,
  hostedModelsToTags,
  ollamaToAnthropicMessages,
  ollamaToAnthropicRequest,
  ollamaToOpenaiEmbedResponse,
  ollamaToOpenaiRequest,
  openaiImages,
  openaiText,
  openaiToOllamaEmbedResponse,
  openaiToOllamaMessages,
  openaiToOllamaRequest,
  tagsToOpenaiModels,
  toOpenaiCompletion,
} from './shapes.js';
import { AnthropicOut, NdjsonReader, SseReader, ToOllamaStream, errorFor, planFor, upstreamHeaders } from './chatUpstream.js';

// ── The dispatch decision ─────────────────────────────────────────────────

test('an Ollama upstream is a pipe on every route, exactly as before', () => {
  // The default and every install that predates the setting. If this ever
  // stops being true, perch has started parsing bodies it used to stream.
  for (const [op, shape] of [
    ['chat', 'ollama'], ['chat', 'openai'], ['chat', 'anthropic'],
    ['embed', 'ollama'], ['models', 'openai'], ['pull', 'ollama'], ['delete', 'ollama'],
  ] as const) {
    assert.equal(planFor(op, shape, 'ollama').kind, 'pipe', `${op}/${shape}`);
  }
});

test('a hosted upstream still pipes the shape it already speaks', () => {
  // The main reason to put perch in front of a hosted API: the token, the
  // allowlist, the proxy and the activity ring with no translation at all.
  assert.equal(planFor('chat', 'openai', 'openai').kind, 'pipe');
  assert.equal(planFor('embed', 'openai', 'openai').kind, 'pipe');
  assert.equal(planFor('chat', 'anthropic', 'anthropic').kind, 'pipe');
  // ...and translates the ones it does not.
  assert.equal(planFor('chat', 'ollama', 'openai').kind, 'translate');
  assert.equal(planFor('chat', 'anthropic', 'openai').kind, 'translate');
  assert.equal(planFor('chat', 'openai', 'anthropic').kind, 'translate');
});

test('what a hosted upstream cannot do is refused rather than faked', () => {
  // A plausible lie is worse than an error here. An empty model list reads as
  // "you have no models"; an empty vector reads as a successful embedding and
  // is indexed against.
  for (const op of ['pull', 'delete'] as const) {
    const plan = planFor(op, 'ollama', 'openai');
    assert.equal(plan.kind, 'refuse');
    assert.equal(plan.kind === 'refuse' && plan.status, 501);
    // The message has to name the setting, or an operator goes looking at the
    // one thing that is fine.
    assert.match(plan.kind === 'refuse' ? plan.message : '', /upstream/i);
  }
  // The Messages API has no embeddings endpoint at all.
  const embed = planFor('embed', 'ollama', 'anthropic');
  assert.equal(embed.kind, 'refuse');
  assert.match(embed.kind === 'refuse' ? embed.message : '', /no embeddings endpoint/i);
  // ...but it does against an OpenAI-shaped one.
  assert.equal(planFor('embed', 'ollama', 'openai').kind, 'translate');
});

test('the credential goes in the header form each upstream actually reads', () => {
  // Every one of these is a 401 on every request if it is wrong, and a console
  // reporting "unreachable" sends somebody to check a firewall over a header.
  assert.deepEqual(upstreamHeaders({ api: 'openai', url: 'x', key: 'k' }), { Authorization: 'Bearer k' });
  const anthropic = upstreamHeaders({ api: 'anthropic', url: 'x', key: 'k' });
  assert.equal(anthropic['x-api-key'], 'k');
  // Mandatory on every request or the whole lot is refused, and the failure
  // reads like a malformed body rather than a missing header.
  assert.equal(anthropic['anthropic-version'], '2023-06-01');
  assert.equal(anthropic.Authorization, undefined);
  // An empty key sends nothing, which is the shipped container.
  assert.deepEqual(upstreamHeaders({ api: 'ollama', url: 'x', key: '' }), {});
});

test('an error arrives in the envelope the caller’s own SDK reads', () => {
  // Each of these SDKs branches on the envelope before it looks at the
  // message, so a raw upstream body would be an error the client cannot
  // classify — which surfaces as an unhandled exception rather than a retry.
  assert.equal((errorFor('anthropic', 429, 'slow down') as any).error.type, 'rate_limit_error');
  assert.equal((errorFor('anthropic', 404, 'nope') as any).error.type, 'not_found_error');
  assert.equal((errorFor('openai', 400, 'bad') as any).error.message, 'bad');
  assert.equal((errorFor('ollama', 400, 'bad') as any).error, 'bad');
});

// ── OpenAI → Ollama ───────────────────────────────────────────────────────

test('OpenAI content parts are flattened rather than stringified', () => {
  // A client sending typed parts and getting "[object Object]" into the prompt
  // produces plausible nonsense rather than an error, which is the worst kind
  // to find later.
  assert.equal(openaiText('plain'), 'plain');
  assert.equal(openaiText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(openaiText(undefined), '');
});

test('only inline images cross; a remote image URL is dropped, not fetched', () => {
  // perch would be the thing making that request, from inside the operator's
  // network, at the direction of whoever wrote the prompt.
  const content = [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'image_url', image_url: { url: 'https://example.invalid/secret.png' } },
  ];
  assert.deepEqual(openaiImages(content), ['AAAA']);
});

test('OpenAI tool arguments are parsed on the way in and re-stringified on the way out', () => {
  // OpenAI sends arguments as a JSON string and Ollama wants an object. A
  // string left unparsed reaches the model as a quoted blob it cannot read,
  // and the model then calls the tool with nothing.
  const msgs = openaiToOllamaMessages([
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
  ]);
  assert.deepEqual(msgs[0]!.tool_calls[0].function.arguments, { q: 'x' });

  const back = toOpenaiCompletion({ message: { content: '', tool_calls: [{ function: { name: 'search', arguments: { q: 'x' } } }] } }, 'm');
  assert.equal(typeof back.choices[0].message.tool_calls[0].function.arguments, 'string');
  assert.equal(back.choices[0].finish_reason, 'tool_calls');

  // Malformed arguments become an empty object rather than throwing: a
  // truncated stream must not take the whole request down.
  const bad = openaiToOllamaMessages([{ role: 'assistant', tool_calls: [{ function: { name: 'f', arguments: '{"q":' } }] }]);
  assert.deepEqual(bad[0]!.tool_calls[0].function.arguments, {});
});

test('an Ollama-only sampling knob is never forwarded to a hosted upstream', () => {
  // Real OpenAI answers 400 to a parameter it does not know, so forwarding one
  // turns a working request into a failed one — and the failure looks like a
  // bad prompt rather than a bad translation.
  const out = ollamaToOpenaiRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    options: { temperature: 0.5, top_k: 40, min_p: 0.05, repeat_penalty: 1.1, num_ctx: 8192, num_predict: 100 },
    keep_alive: '10m',
  });
  assert.equal(out.temperature, 0.5);
  assert.equal(out.max_tokens, 100);
  for (const k of ['top_k', 'min_p', 'repeat_penalty', 'repeat_last_n', 'num_ctx', 'keep_alive', 'options']) {
    assert.equal((out as any)[k], undefined, `${k} reached a hosted upstream`);
  }
});

test('a tool message without an id is demoted rather than sent as a 400', () => {
  // OpenAI requires the id of the call being answered, and Ollama does not
  // always carry one. A `tool` message without it is a 400 that reads like a
  // malformed conversation; as a user turn the model can still read it.
  const out = ollamaToOpenaiRequest({ model: 'm', messages: [{ role: 'tool', content: 'result' }] });
  assert.equal(out.messages[0].role, 'user');
  const kept = ollamaToOpenaiRequest({ model: 'm', messages: [{ role: 'tool', content: 'r', tool_call_id: 'c1' }] });
  assert.equal(kept.messages[0].role, 'tool');
  assert.equal(kept.messages[0].tool_call_id, 'c1');
});

test('an unknown finish reason is not passed through', () => {
  // A client reading one it does not know usually treats the turn as
  // unfinished, which is a loop that never terminates rather than a cosmetic
  // difference.
  assert.equal(finishReason('length', false), 'length');
  assert.equal(finishReason('stop', false), 'stop');
  assert.equal(finishReason(undefined, true), 'tool_calls');
});

// ── Ollama → Anthropic ────────────────────────────────────────────────────

test('the system prompt is lifted out and consecutive turns are merged', () => {
  // Two things the Messages API insists on, each a refusal rather than a
  // degradation: the system role is rejected outright, and two user turns in
  // a row are a 400. Ollama has no such rule.
  const { system, messages } = ollamaToAnthropicMessages([
    { role: 'system', content: 'One.' },
    { role: 'system', content: 'Two.' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
  ]);
  // Joined rather than last-one-wins: a dropped instruction produces a model
  // that mostly behaves, which is harder to spot than one that plainly does not.
  assert.equal(system, 'One.\n\nTwo.');
  assert.deepEqual(messages.map((m: any) => m.role), ['user', 'assistant']);
  assert.equal(messages[0]!.content.length, 2);
  assert.ok(!messages.some((m: any) => m.role === 'system'), 'a system role reached the message list');
});

test('a tool result becomes a block inside a user turn, and an unattributable one becomes text', () => {
  // There is no tool role on this API, and a `tool_result` without the id of
  // the call it answers is a 400.
  const withId = ollamaToAnthropicMessages([{ role: 'tool', content: 'r', tool_call_id: 'c1' }]);
  assert.equal(withId.messages[0]!.role, 'user');
  assert.equal(withId.messages[0]!.content[0]!.type, 'tool_result');
  assert.equal(withId.messages[0]!.content[0]!.tool_use_id, 'c1');

  const without = ollamaToAnthropicMessages([{ role: 'tool', content: 'r' }]);
  assert.equal(without.messages[0]!.content[0]!.type, 'text');
});

test('max_tokens is always sent, because the Messages API refuses a request without it', () => {
  const out = ollamaToAnthropicRequest({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(Number.isFinite(out.max_tokens) && out.max_tokens > 0);
  const explicit = ollamaToAnthropicRequest({ model: 'claude-x', messages: [], options: { num_predict: 77 } });
  assert.equal(explicit.max_tokens, 77);

  // A client that asked for no ceiling gets the MODEL's ceiling, supplied by
  // the caller, rather than a number this file invented. perch must not impose
  // a limit nobody asked for: a client speaking Ollama routinely omits
  // num_predict, and the old 4096 default truncated every long hosted answer
  // for all of them — a well-formed response with the stop reason buried,
  // which reads as the model simply stopping.
  const supplied = ollamaToAnthropicRequest({ model: 'claude-x', messages: [] }, 64_000);
  assert.equal(supplied.max_tokens, 64_000);

  // An explicit request still wins over the model's ceiling: a client that
  // asked for a short answer wanted a short answer.
  const both = ollamaToAnthropicRequest({ model: 'claude-x', messages: [], options: { num_predict: 77 } }, 64_000);
  assert.equal(both.max_tokens, 77);
});

test('temperature is withheld from the models that answer 400 to it', () => {
  // The trap for an adapter written from older documentation: temperature,
  // top_p and top_k were removed on the current generation, and sending one
  // fails the whole request rather than being ignored.
  assert.equal(anthropicTakesSampling('claude-3-5-sonnet-20241022'), true);
  assert.equal(anthropicTakesSampling('claude-sonnet-4-20250514'), true);
  assert.equal(anthropicTakesSampling('claude-opus-5'), false);
  assert.equal(anthropicTakesSampling('claude-fable-5-1'), false);

  const old = ollamaToAnthropicRequest({ model: 'claude-3-5-haiku', messages: [], options: { temperature: 0.4, top_k: 40 } });
  assert.equal(old.temperature, 0.4);
  assert.equal(old.top_k, 40);
  const current = ollamaToAnthropicRequest({ model: 'claude-opus-5', messages: [], options: { temperature: 0.4, top_k: 40 } });
  assert.equal(current.temperature, undefined);
  assert.equal(current.top_k, undefined);
});

test('reasoning survives as reasoning rather than being folded into the answer', () => {
  // Ollama carries the working-out in its own field and every client
  // downstream reads it there. Folded into `content` it would end up in
  // somebody's email.
  const line = anthropicToOllamaMessage({
    content: [{ type: 'thinking', thinking: 'weighing it up' }, { type: 'text', text: 'the answer' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 7 },
  }, 'claude-x');
  assert.equal(line.message.content, 'the answer');
  assert.equal(line.message.thinking, 'weighing it up');
  assert.equal(line.done_reason, 'stop');
  assert.equal(line.prompt_eval_count, 5);
  assert.equal(line.eval_count, 7);
  // `max_tokens` has to come back as Ollama's own word for it.
  assert.equal(anthropicToOllamaMessage({ content: [], stop_reason: 'max_tokens' }, 'x').done_reason, 'length');
});

// ── Streaming ─────────────────────────────────────────────────────────────

test('an SSE frame split across two writes is still one event', () => {
  // Exactly what happens under load, and splitting on newlines alone works
  // right up until it does.
  const r = new SseReader();
  const seen: Array<[string, string]> = [];
  r.push('event: message_delta\nda', (e, d) => seen.push([e, d]));
  assert.equal(seen.length, 0, 'a half frame was emitted');
  r.push('ta: {"a":1}\n\n', (e, d) => seen.push([e, d]));
  assert.deepEqual(seen, [['message_delta', '{"a":1}']]);
});

test('a malformed NDJSON line is skipped rather than throwing', () => {
  const r = new NdjsonReader();
  const seen: any[] = [];
  r.push('{"a":1}\nnot json\n{"b":2}\n', (o) => seen.push(o));
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
});

test('OpenAI tool arguments are accumulated and emitted once', () => {
  // They arrive as partial JSON spread over many deltas and are useless until
  // the last one lands; emitting each fragment would produce a tool call with
  // arguments that do not parse.
  const s = new ToOllamaStream('m');
  assert.deepEqual(s.openai({ choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }] } }] }), []);
  assert.deepEqual(s.openai({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"x"}' } }] } }] }), []);
  const end = s.openai({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  assert.equal(end.length, 1);
  assert.deepEqual(end[0]!.message.tool_calls[0].function.arguments, { q: 'x' });
  assert.equal(end[0]!.done, true);
});

test('an Anthropic stream becomes Ollama lines, thinking kept separate', () => {
  const s = new ToOllamaStream('claude-x');
  s.anthropic('message_start', { message: { usage: { input_tokens: 3 } } });
  const think = s.anthropic('content_block_delta', { delta: { type: 'thinking_delta', thinking: 'hmm' } });
  assert.equal(think[0]!.message.thinking, 'hmm');
  assert.equal(think[0]!.message.content, '');
  const text = s.anthropic('content_block_delta', { delta: { type: 'text_delta', text: 'hi' } });
  assert.equal(text[0]!.message.content, 'hi');
  const end = s.anthropic('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } });
  assert.equal(end[0]!.done, true);
  assert.equal(end[0]!.done_reason, 'length');
  assert.equal(end[0]!.prompt_eval_count, 3);
  assert.equal(end[0]!.eval_count, 9);
});

test('the Anthropic SSE grammar is respected, and a dropped upstream still closes it', () => {
  // A client that receives a delta for a block it was never told about does
  // not render partial output — it throws.
  const out = new AnthropicOut('m');
  const first = out.push({ message: { content: 'hi' }, prompt_eval_count: 4 });
  assert.match(first, /event: message_start/);
  assert.match(first, /event: content_block_start/);
  assert.match(first, /event: content_block_delta/);
  const second = out.push({ message: { content: ' there' } });
  // The block is already open; it must not be opened twice.
  assert.doesNotMatch(second, /content_block_start/);
  const last = out.push({ done: true, done_reason: 'stop', eval_count: 2 });
  assert.match(last, /content_block_stop/);
  assert.match(last, /event: message_stop/);

  // An upstream that dies mid-answer must not leave the client waiting for a
  // terminator that never comes.
  const dropped = new AnthropicOut('m');
  dropped.push({ message: { content: 'partial' } });
  const tail = dropped.close();
  assert.match(tail, /content_block_stop/);
  assert.match(tail, /event: message_stop/);
  // Closing a stream that already ended emits nothing.
  assert.equal(dropped.close(), '');
});

// ── Catalogues and embeddings ─────────────────────────────────────────────

test('a hosted catalogue becomes Ollama tags without inventing a size', () => {
  // A hosted catalogue reports no size, and a plausible number here would land
  // on a page an operator uses to decide what fits on a disk.
  const tags = hostedModelsToTags({ data: [{ id: 'gpt-5' }, { id: 'claude-opus-5' }] });
  assert.deepEqual(tags.models.map((m: any) => m.name), ['claude-opus-5', 'gpt-5']);
  assert.equal(tags.models[0].size, 0);
  assert.equal(tags.models[0].modified_at, '');

  const models = tagsToOpenaiModels({ models: [{ name: 'qwen3.5:4b' }] });
  assert.equal(models.data[0].id, 'qwen3.5:4b');
  assert.equal(models.object, 'list');
});

test('embedding batches are reordered by index, never trusted in arrival order', () => {
  // The API documents the field, and a reordered batch pairs every vector with
  // the wrong text — an index that is wrong rather than empty, which nothing
  // downstream can detect.
  const ollama = openaiToOllamaEmbedResponse({
    data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }],
    usage: { prompt_tokens: 4 },
  }, 'e');
  assert.deepEqual(ollama.embeddings, [[1], [2]]);
  assert.equal(ollama.prompt_eval_count, 4);

  const openai = ollamaToOpenaiEmbedResponse({ embeddings: [[1], [2]], prompt_eval_count: 4 }, 'e');
  assert.deepEqual(openai.data.map((d: any) => d.index), [0, 1]);
  assert.deepEqual(openai.data[1].embedding, [2]);
});

test('an OpenAI request round-trips through the hub without losing the conversation', () => {
  // The double conversion the module header warns about, asserted rather than
  // assumed: a client speaking one hosted shape to an upstream speaking the
  // other goes through Ollama's in the middle.
  const original = {
    model: 'm',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'again' },
    ],
    max_tokens: 50,
  };
  const neutral = openaiToOllamaRequest(original);
  assert.deepEqual(neutral.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'user']);
  const anthropic = ollamaToAnthropicRequest(neutral);
  assert.equal(anthropic.system, 'be brief');
  assert.deepEqual(anthropic.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
  assert.equal(anthropic.max_tokens, 50);
});
