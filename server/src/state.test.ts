// The upgrade path. Version 1 of the state file held a single `tunnel`
// object; version 2 holds a list of connections. Somebody with a working
// tunnel must not lose it — or their tokens — by installing a newer perch, so
// the migration gets its own test with its own state directory, written
// before state.js is imported because the state directory is read once at
// import time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-state-v1-'));
fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
  version: 1,
  tokens: [{
    id: 'tok-1', name: 'Tern', hash: 'abc', prefix: 'perch_aa',
    scopes: ['use', 'manage'], createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null, lastUsedIp: null, revokedAt: null,
  }],
  console: { passwordHash: 'scrypt$aaa$bbb' },
  tunnel: {
    host: 'mail.example.com', user: 'perch', sshPort: 2222,
    remoteBind: '10.89.0.1', remotePort: 11434, torProxy: '127.0.0.1:9050',
    publicKey: 'ssh-ed25519 AAAAC3Nz old@box', ternBaseUrl: 'http://host.containers.internal:11434',
    configuredAt: '2026-02-02T00:00:00.000Z',
  },
  settings: { allowManage: false, keepAlive: '30m', unloadWhenIdle: true },
}, null, 2));

process.env.PERCH_STATE_DIR = stateDir;
process.env.PERCH_LOG_LEVEL = 'error';

const { loadState } = await import('./state.js');

test('a v1 tunnel becomes the first connection, with its settings intact', () => {
  const s = loadState();
  assert.equal(s.version, 2);
  assert.equal(s.connections.length, 1);
  const c = s.connections[0]!;
  assert.equal(c.id, 'default', 'the id is fixed so the existing unit and key can still be found');
  assert.equal(c.host, 'mail.example.com');
  assert.equal(c.user, 'perch');
  assert.equal(c.sshPort, 2222);
  assert.equal(c.remoteBind, '10.89.0.1');
  assert.equal(c.remotePort, 11434);
  assert.equal(c.torProxy, '127.0.0.1:9050');
  assert.equal(c.publicKey, 'ssh-ed25519 AAAAC3Nz old@box');
  assert.equal(c.retiredAt, null);
});

test('the connection is named after its host rather than left blank', () => {
  assert.equal(loadState().connections[0]!.name, 'mail.example.com');
});

test('its key path is moved under the per-connection directory', () => {
  // The helper adopts the old shared key into this path on first keygen, so
  // the far side does not have to be told about a new one.
  assert.match(loadState().connections[0]!.keyPath, /\/ssh\/default\/id_ed25519$/);
});

test('tokens, the console password and settings all survive the upgrade', () => {
  const s = loadState();
  assert.equal(s.tokens.length, 1);
  assert.equal(s.tokens[0]!.name, 'Tern');
  assert.equal(s.console.passwordHash, 'scrypt$aaa$bbb');
  assert.equal(s.settings.allowManage, false);
  assert.equal(s.settings.keepAlive, '30m');
  assert.equal(s.settings.unloadWhenIdle, true);
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
