// The Anthropic shape perch speaks, asserted directly.
//
// A client written against this API fails closed: a malformed event is an
// exception, not degraded output. So "nearly right" and "broken" are the same
// outcome, and the wire grammar is worth testing on its own rather than only
// through the proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MessageStream, estimateTokens, flattenContent, imagesOf, stopReason,
  toAnthropicContent, toAnthropicMessage, toOllamaMessages, toOllamaRequest, toOllamaTools,
} from './anthropic.js';

// One SSE chunk back into the events it carries, so a test can talk about
// order and shape rather than about string matching.
function events(sse: string): Array<Record<string, any>> {
  return sse.split('\n\n').filter(Boolean).map((block) => {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line!.slice(6));
  });
}

test('content is flattened whether it arrived as a string or as blocks', () => {
  // A client sending blocks and getting "[object Object]" into the prompt is
  // the bug that produces plausible nonsense rather than an error.
  assert.equal(flattenContent('hello'), 'hello');
  assert.equal(flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(flattenContent([{ type: 'image', source: { type: 'base64', data: 'AAA' } }]), '');
  assert.equal(flattenContent(undefined), '');
});

test('base64 images survive the crossing', () => {
  assert.deepEqual(imagesOf([{ type: 'image', source: { type: 'base64', data: 'AAA' } }, { type: 'text', text: 'x' }]), ['AAA']);
  // A URL source is not something Ollama can fetch, so it is not offered as
  // though it were: silently sending an empty image is worse than none.
  assert.deepEqual(imagesOf([{ type: 'image', source: { type: 'url', url: 'http://x/y.png' } }]), []);
});

test('the system prompt is folded back in as the first message', () => {
  // The mirror image of the lift every client-side adapter does. It must be
  // first: to a chat template a system message after a user turn is just an
  // instruction the model may ignore.
  const msgs = toOllamaMessages({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(msgs, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]);
});

test('a system prompt given as blocks is flattened, not stringified', () => {
  const msgs = toOllamaMessages({ system: [{ type: 'text', text: 'be brief' }], messages: [] });
  assert.equal(msgs[0]!.content, 'be brief');
});

test('a tool result becomes its own tool message, carrying its id', () => {
  // Anthropic puts the result inside a user turn. Left there, the model sees
  // the result of a call it does not believe it made.
  const msgs = toOllamaMessages({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_time', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '12:00' }] },
    ],
  });
  assert.equal(msgs[0]!.role, 'assistant');
  assert.deepEqual(msgs[0]!.tool_calls, [{ function: { name: 'get_time', arguments: {} } }]);
  assert.equal(msgs[1]!.role, 'tool');
  assert.equal(msgs[1]!.content, '12:00');
  assert.equal(msgs[1]!.tool_call_id, 'toolu_1');
  // And no empty user turn left behind: some chat templates render one as a
  // blank turn the model then tries to continue.
  assert.equal(msgs.length, 2);
});

test('tool definitions cross over, and server-side tools are dropped', () => {
  const tools = toOllamaTools([
    { name: 'get_time', description: 'the time', input_schema: { type: 'object', properties: {} } },
    // Anthropic's to run, and this is not Anthropic. Defining it would give
    // the model a tool nothing can answer, and the conversation would deadlock
    // waiting for a result that never comes.
    { type: 'web_search_20260209', name: 'web_search' },
  ]);
  assert.equal(tools?.length, 1);
  assert.equal(tools![0]!.function.name, 'get_time');
  assert.deepEqual(tools![0]!.function.parameters, { type: 'object', properties: {} });
  assert.equal(toOllamaTools([]), undefined);
});

test('max_tokens becomes num_predict, and thinking is a switch not a type', () => {
  const req = toOllamaRequest({ model: 'm', max_tokens: 512, messages: [], temperature: 0.5, stop_sequences: ['X'] });
  assert.equal(req.options.num_predict, 512);
  assert.equal(req.options.temperature, 0.5);
  assert.deepEqual(req.options.stop, ['X']);
  assert.equal(req.think, undefined);

  assert.equal(toOllamaRequest({ model: 'm', max_tokens: 1, messages: [], thinking: { type: 'adaptive' } }).think, true);
  // `disabled` is the value that must not turn reasoning on.
  assert.equal(toOllamaRequest({ model: 'm', max_tokens: 1, messages: [], thinking: { type: 'disabled' } }).think, undefined);
});

test('stop reasons are translated out of Ollama vocabulary', () => {
  // A client that meets an unknown stop_reason usually treats the turn as
  // unfinished, so an untranslated "stop" is a loop that never terminates.
  assert.equal(stopReason('stop', false), 'end_turn');
  assert.equal(stopReason('length', false), 'max_tokens');
  assert.equal(stopReason('stop', true), 'tool_use');
  assert.equal(stopReason(undefined, false), 'end_turn');
});

test('tool arguments reach the caller as an object even when Ollama sends a string', () => {
  // A client parses `input` as an object. A JSON string left unparsed here
  // arrives as a quoted blob it cannot read.
  const block = toAnthropicContent({ tool_calls: [{ function: { name: 'f', arguments: '{"a":1}' } }] })[0]!;
  assert.deepEqual(block.input, { a: 1 });
  assert.equal(block.type, 'tool_use');
  assert.match(block.id, /^toolu_/);
});

test('a finished answer carries the fields a client reads before the text', () => {
  const msg = toAnthropicMessage(
    { message: { content: 'hi' }, done_reason: 'stop', prompt_eval_count: 7, eval_count: 3 },
    'gemma4:12b',
  );
  assert.equal(msg.type, 'message');
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.model, 'gemma4:12b');
  assert.match(msg.id, /^msg_/);
  assert.deepEqual(msg.content, [{ type: 'text', text: 'hi' }]);
  assert.equal(msg.stop_reason, 'end_turn');
  assert.deepEqual(msg.usage, { input_tokens: 7, output_tokens: 3 });
});

test('the stream opens the message and the block before writing to either', () => {
  // SSE here is a grammar, not a series of independent lines: a delta for a
  // block the client was never told about is an exception, not partial output.
  const s = new MessageStream('m');
  const first = events(s.next({ message: { content: 'one' }, prompt_eval_count: 4 }));
  assert.deepEqual(first.map((e) => e.type), ['message_start', 'content_block_start', 'content_block_delta']);
  assert.equal(first[0]!.message.role, 'assistant');
  assert.equal(first[0]!.message.usage.input_tokens, 4);
  assert.equal(first[1]!.content_block.type, 'text');
  assert.deepEqual(first[2]!.delta, { type: 'text_delta', text: 'one' });

  // The second token opens nothing: one block, many deltas.
  const second = events(s.next({ message: { content: 'two' } }));
  assert.deepEqual(second.map((e) => e.type), ['content_block_delta']);

  const last = events(s.next({ done: true, done_reason: 'stop', eval_count: 2 }));
  assert.deepEqual(last.map((e) => e.type), ['content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(last[1]!.delta.stop_reason, 'end_turn');
  assert.equal(last[1]!.usage.output_tokens, 2);
});

test('a tool call closes the text block before opening its own', () => {
  // Two blocks may not be open at once, and the indices must not collide.
  const s = new MessageStream('m');
  s.next({ message: { content: 'let me check' } });
  const out = events(s.next({
    message: { content: '', tool_calls: [{ function: { name: 'get_time', arguments: { tz: 'UTC' } } }] },
    done: true,
    done_reason: 'stop',
  }));
  assert.deepEqual(out.map((e) => e.type), [
    'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ]);
  assert.equal(out[0]!.index, 0);
  assert.equal(out[1]!.index, 1);
  assert.equal(out[1]!.content_block.type, 'tool_use');
  // The arguments arrive as `partial_json`, which the client accumulates —
  // one delta is a valid stream, not a special case it must know about.
  assert.equal(out[2]!.delta.type, 'input_json_delta');
  assert.deepEqual(JSON.parse(out[2]!.delta.partial_json), { tz: 'UTC' });
  assert.equal(out[4]!.delta.stop_reason, 'tool_use');
});

test('an answer cut short is still closed properly', () => {
  // A client waiting on a message_stop that never comes hangs until its own
  // timeout. Closing a truncated answer is the honest ending.
  const s = new MessageStream('m');
  s.next({ message: { content: 'half' } });
  const tail = events(s.end('length', false));
  assert.deepEqual(tail.map((e) => e.type), ['content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(tail[1]!.delta.stop_reason, 'max_tokens');
});

test('the message is closed once, however many times the ending is reached', () => {
  // Both ends of an answer arrive: Ollama's `done` line closes the message,
  // and then the socket closing calls end() as the safety net for a truncated
  // one. Emitted twice, a client that has already finished the message gets a
  // second message_delta and message_stop for a message that no longer exists.
  const s = new MessageStream('m');
  s.next({ message: { content: 'hi' } });
  const closing = events(s.next({ done: true, done_reason: 'stop', eval_count: 1 }));
  assert.deepEqual(closing.map((e) => e.type), ['content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(s.end('length', false), '', 'the ending was sent a second time');
});

test('closing a stream that never started emits nothing', () => {
  // Otherwise an upstream that died before its first byte would send a
  // message_stop for a message the client was never told had begun.
  assert.equal(new MessageStream('m').end('length', false), '');
});

test('token counting is an estimate over everything that will be sent', () => {
  // Ollama exposes no counter, so this is a rule of thumb rather than a
  // measurement — but it must at least grow with the prompt, and count the
  // system prompt and the tool schemas that a naive version forgets.
  const small = estimateTokens({ messages: [{ role: 'user', content: 'hi' }] });
  const large = estimateTokens({ messages: [{ role: 'user', content: 'hi'.repeat(500) }] });
  assert.ok(large > small * 10, 'the estimate does not track the prompt');
  assert.ok(estimateTokens({ system: 'x'.repeat(400), messages: [] }) >= 100);
  assert.ok(
    estimateTokens({ messages: [], tools: [{ name: 'f', input_schema: { type: 'object' } }] })
    > estimateTokens({ messages: [] }),
    'tool schemas are sent and so must be counted',
  );
});
