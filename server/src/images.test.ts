// The images translator, in the parts that have no socket in them.
//
// proxy.test.ts drives this endpoint end to end against a stand-in ComfyUI,
// which is what proves the three calls are wired together. What is left here
// is everything that decides *what* gets queued — and that matters more than
// it looks, because every failure in this file is silent. A graph with a
// mistyped link still validates; a size that rounds the wrong way still
// renders; a checkpoint matched too loosely still produces a picture. None of
// them error, they just quietly generate something other than what was asked
// for, which is the kind of bug that gets found weeks later or not at all.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PERCH_LOG_LEVEL = 'error';

const images = await import('./images.js');

const baseOptions = {
  ckptName: 'DreamShaper_8_pruned.safetensors',
  prompt: 'a heron on a post',
  negativePrompt: 'blurry',
  width: 512,
  height: 768,
  batchSize: 1,
  steps: 20,
  cfg: 7,
  sampler: 'euler',
  scheduler: 'normal',
  seed: 42,
};

// ---------- the graph ----------

// ComfyUI validates a graph before running it and rejects an unknown node or
// a missing input, so a structural mistake is caught upstream. What it cannot
// catch is a link pointing at the wrong output of the right node: CLIP and
// VAE are both valid things to hand a node, and swapping them produces a
// picture that is merely wrong.
test('the graph wires each node to the output it actually needs', () => {
  const wf = images.toWorkflow(baseOptions) as Record<string, any>;
  const nodes = Object.values(wf).map((n) => n.class_type);
  assert.deepEqual(nodes, [
    'CheckpointLoaderSimple', 'CLIPTextEncode', 'CLIPTextEncode',
    'EmptyLatentImage', 'KSampler', 'VAEDecode', 'PreviewImage',
  ]);

  const ckpt = Object.keys(wf).find((k) => wf[k].class_type === 'CheckpointLoaderSimple')!;
  const sampler = Object.entries(wf).find(([, n]) => (n as any).class_type === 'KSampler')!;
  const decode = Object.entries(wf).find(([, n]) => (n as any).class_type === 'VAEDecode')!;

  // CheckpointLoaderSimple returns MODEL, CLIP, VAE in that order.
  assert.deepEqual((sampler[1] as any).inputs.model, [ckpt, 0], 'the sampler needs the MODEL output');
  assert.deepEqual((decode[1] as any).inputs.vae, [ckpt, 2], 'the decoder needs the VAE output, not the CLIP one');
  for (const [, node] of Object.entries(wf)) {
    if ((node as any).class_type !== 'CLIPTextEncode') continue;
    assert.deepEqual((node as any).inputs.clip, [ckpt, 1], 'text encoding needs the CLIP output');
  }

  // The positive prompt must reach `positive` and the negative one `negative`.
  // Swapped, this generates the thing the caller asked to avoid.
  const positiveNode = (sampler[1] as any).inputs.positive[0];
  const negativeNode = (sampler[1] as any).inputs.negative[0];
  assert.equal(wf[positiveNode].inputs.text, 'a heron on a post');
  assert.equal(wf[negativeNode].inputs.text, 'blurry');
});

test('every value the caller chose reaches the graph', () => {
  const wf = images.toWorkflow({ ...baseOptions, steps: 8, cfg: 2.5, seed: 99, batchSize: 3 }) as Record<string, any>;
  const latent = Object.values(wf).find((n) => n.class_type === 'EmptyLatentImage')!;
  const sampler = Object.values(wf).find((n) => n.class_type === 'KSampler')!;
  assert.equal(latent.inputs.width, 512);
  assert.equal(latent.inputs.height, 768);
  assert.equal(latent.inputs.batch_size, 3);
  assert.equal(sampler.inputs.steps, 8);
  assert.equal(sampler.inputs.cfg, 2.5);
  assert.equal(sampler.inputs.seed, 99);
  assert.equal(sampler.inputs.denoise, 1, 'a text-to-image graph starts from pure noise');
});

// The output node is the one choice here a caller cannot see or override, so
// it is worth pinning: SaveImage would leave a copy of every generated image
// in the volume forever, which is a disk that fills up quietly.
test('the result is written to the temp directory, not kept forever', () => {
  const wf = images.toWorkflow(baseOptions) as Record<string, any>;
  const output = Object.values(wf).find((n) => n.class_type === 'PreviewImage');
  assert.ok(output, 'the graph must end in PreviewImage');
  assert.equal(Object.values(wf).some((n) => n.class_type === 'SaveImage'), false);
});

// ---------- the request ----------

test('a size is read, bounded, and rounded to something the VAE accepts', () => {
  assert.deepEqual(images.parseSize('512x512'), { width: 512, height: 512 });
  assert.deepEqual(images.parseSize('1024X768'), { width: 1024, height: 768 });
  assert.deepEqual(images.parseSize('1024 × 768'), { width: 1024, height: 768 });
  // Absent, explicitly null and "auto" all mean the caller did not choose,
  // and all get OpenAI's default.
  // A client that serialises unset fields as null is not making a mistake.
  assert.deepEqual(images.parseSize(undefined), { width: 1024, height: 1024 });
  assert.deepEqual(images.parseSize(null), { width: 1024, height: 1024 });
  assert.deepEqual(images.parseSize('auto'), { width: 1024, height: 1024 });

  // Latent dimensions must be multiples of 8; rounding down never crosses the
  // ceiling, which rounding up would.
  assert.deepEqual(images.parseSize('513x1023'), { width: 512, height: 1016 });
  assert.deepEqual(images.parseSize('2048x2048'), { width: 2048, height: 2048 });

  for (const bad of ['huge', '512', '512x', 'x512', '10x10', '4096x4096', 42]) {
    assert.ok('error' in images.parseSize(bad as unknown), `${JSON.stringify(bad)} must be refused`);
  }
});

test('numbers outside what the sampler accepts are clamped rather than passed on', () => {
  assert.equal(images.clampNumber(30, 20, 1, 150), 30);
  assert.equal(images.clampNumber(9999, 20, 1, 150), 150);
  assert.equal(images.clampNumber(-4, 20, 1, 150), 1);
  assert.equal(images.clampNumber('12', 20, 1, 150), 12);
  // Absent or unreadable both mean "the caller did not choose", which is the
  // default and not an error: OpenAI's API has no `steps` at all.
  assert.equal(images.clampNumber(undefined, 20, 1, 150), 20);
  assert.equal(images.clampNumber('nonsense', 20, 1, 150), 20);
  assert.equal(images.clampNumber(null, 20, 1, 150), 20);
});

test('a model name is matched the way somebody would actually type it', () => {
  const have = ['DreamShaper_8_pruned.safetensors', 'sd_xl_base_1.0.safetensors', 'SDXL/sd_xl_turbo_1.0_fp16.safetensors'];
  assert.equal(images.matchCheckpoint('DreamShaper_8_pruned.safetensors', have), have[0], 'exact');
  assert.equal(images.matchCheckpoint('dreamshaper_8_pruned', have), have[0], 'without the extension');
  assert.equal(images.matchCheckpoint('turbo', have), have[2], 'a fragment, including one in a subdirectory');
  assert.equal(images.matchCheckpoint(undefined, have), have[0], 'no model named means the first installed');
  assert.equal(images.matchCheckpoint('gpt-image-1', have), undefined, 'a model that is not here is not silently substituted');
  assert.equal(images.matchCheckpoint('anything', []), undefined, 'nothing installed matches nothing');

  // 'sd_xl' is in two of them. The shorter name is the closer match, and
  // picking arbitrarily would make the same request return different models.
  assert.equal(images.matchCheckpoint('sd_xl', have), 'sd_xl_base_1.0.safetensors');
});

// ---------- the answer ----------

const finished = (outputs: unknown): Record<string, any> => ({
  p1: { status: { completed: true, status_str: 'success' }, outputs },
});

test('images are collected from whatever node produced them', () => {
  const history = finished({
    7: { images: [{ filename: 'a.png', subfolder: '', type: 'temp' }, { filename: 'b.png', subfolder: 'x', type: 'temp' }] },
  });
  assert.deepEqual(images.imagesFromHistory(history, 'p1'), [
    { filename: 'a.png', subfolder: '', type: 'temp' },
    { filename: 'b.png', subfolder: 'x', type: 'temp' },
  ]);
  // A node that produced text rather than pictures is not an image, and an
  // entry for a different prompt is not this caller's.
  assert.deepEqual(images.imagesFromHistory(finished({ 9: { text: ['hello'] } }), 'p1'), []);
  assert.deepEqual(images.imagesFromHistory(history, 'p2'), []);
  assert.deepEqual(images.imagesFromHistory({}, 'p1'), []);
});

// Polling that only looked for images would wait out the full deadline on a
// job that died in the first second — fifteen minutes to report a failure
// ComfyUI knew about immediately.
test('a run that failed is finished, not still going', () => {
  assert.equal(images.historyOutcome(finished({ 7: { images: [{ filename: 'a.png' }] } }), 'p1'), 'done');
  assert.equal(images.historyOutcome({}, 'p1'), 'pending');
  assert.equal(images.historyOutcome({ p1: { status: { completed: false } } }, 'p1'), 'pending');
  assert.equal(images.historyOutcome({ p1: { status: { status_str: 'error' } } }, 'p1'), 'failed');
  // Some builds write the entry only once the run has ended and never set
  // `completed`; an entry carrying outputs is finished whatever it says.
  assert.equal(images.historyOutcome({ p1: { outputs: { 7: { images: [{ filename: 'a.png' }] } } } }, 'p1'), 'done');
});

test('a rejected workflow is explained in words the caller can act on', () => {
  const rejection = {
    error: { message: 'Prompt outputs failed validation' },
    node_errors: { 1: { class_type: 'CheckpointLoaderSimple', errors: [{ message: 'Value not in list', details: "ckpt_name: 'nope.safetensors' not in []" }] } },
  };
  const flat = images.flattenNodeErrors(rejection);
  assert.match(flat, /Prompt outputs failed validation/);
  assert.match(flat, /ckpt_name/, 'the useful half is the one buried in node_errors');
  // Never empty: a caller shown nothing has nothing to fix.
  assert.ok(images.flattenNodeErrors({}).length > 0);
});

test('errors come back in the envelope an OpenAI client reads', () => {
  const body = images.errorBody('invalid_request_error', 'prompt is required') as any;
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.message, 'prompt is required');
  assert.equal(body.error.param, null);
  assert.equal(body.error.code, null);
  assert.equal((images.errorBody('api_error', 'x', 'no_model') as any).error.code, 'no_model');
});
