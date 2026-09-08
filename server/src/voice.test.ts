// The speech model, which is the one model here with no API behind it.
//
// The thing worth testing is the distinction the card is built on: a
// transcriber that refuses the connection right after a model change is
// downloading weights, not broken. whisper-server does not open its port
// until the file is on disk, so "starting" and "not answering" are the same
// TCP result and only the reason tells them apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every test gets its own state directory. Without one, config.stateDir falls
// back to /var/lib/perch — the real one on a developer's machine — so the
// suite reads that install's settings and, worse, can reach its running host
// helper: a test asking what the speech model is got a real answer from a
// real container. Tests must not be able to drive the machine they run on.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-voice-test-'));
process.env.PERCH_STATE_DIR = stateDir;

process.env.PERCH_LOG_LEVEL = 'error';
process.env.PERCH_SERVICES = 'chat,voice';
process.env.WHISPER_MODEL = 'small';

// A stand-in whisper.cpp: it serves / and nothing else, exactly like the real
// one, which is why a 404 elsewhere still means "reachable".
const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end('whisper.cpp'); });
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const port = (upstream.address() as { port: number }).port;
process.env.PERCH_WHISPER_URL = `http://127.0.0.1:${port}`;

const voice = await import('./voice.js');

test('the model in use is read from the environment, not assumed', async () => {
  assert.equal(voice.currentSpeechModel(), 'small');
  const s = await voice.voiceStatus();
  assert.equal(s.model, 'small');
  assert.equal(s.modelKnown, true);
});

// Two different questions: what .env asks for next time, and what the
// container is running now. With no host helper there is nothing to ask about
// the second, and the honest answer is "unknown" — not "the same", which
// would report a pending change as already applied.
test('without a helper, what is running is unknown rather than assumed', async () => {
  const s = await voice.voiceStatus();
  assert.equal(s.running, null, 'nothing can say what the container was started with');
  assert.equal(s.pending, false, 'and no answer is not evidence of a mismatch');
});

test('a listening transcriber is answering', async () => {
  const s = await voice.voiceStatus();
  assert.equal(s.ok, true);
  assert.equal(s.starting, false);
});

test('a refused connection is a model still downloading, not a fault', () => {
  // whisper-server holds its port closed until the weights are on disk, so
  // these are what a first start or a model change looks like from here.
  for (const waiting of ['connect ECONNREFUSED 10.89.0.4:8080', 'fetch failed', 'The operation was aborted due to timeout', 'getaddrinfo ENOTFOUND whisper']) {
    assert.equal(voice.looksLikeStarting(waiting), true, waiting);
  }
  // Something answered and it went wrong. Calling this "starting" would be a
  // reassuring message about a container that has crashed.
  for (const broken of ['HTTP 500', 'certificate has expired', 'unexpected end of JSON input']) {
    assert.equal(voice.looksLikeStarting(broken), false, broken);
  }
});

// The value becomes part of a filename inside the container's start command,
// so anything not on the list has no business reaching the environment.
test('only models whisper.cpp publishes are accepted', () => {
  for (const ok of ['tiny', 'base', 'base.en', 'small', 'medium', 'large-v3', 'large-v3-turbo']) {
    assert.equal(voice.validSpeechModel(ok), true, ok);
  }
  for (const bad of ['', 'huge', '../../etc/passwd', 'base; rm -rf /', 'large-v9']) {
    assert.equal(voice.validSpeechModel(bad), false, bad);
  }
});

test('every model offered has a size and a note, so the card never shows a blank row', () => {
  for (const m of voice.SPEECH_MODELS) {
    assert.ok(m.sizeBytes > 0, m.name);
    assert.ok(m.needsBytes > m.sizeBytes, `${m.name} must want more than it downloads`);
    assert.ok(m.note.length > 20, m.name);
  }
});

test.after(() => { upstream.close(); });

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
