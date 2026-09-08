// Connections: several machines can use one GPU, so the tests are mostly about
// keeping them independent — one connection's settings, key or removal must
// never disturb another's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-tunnel-test-'));
process.env.PERCH_STATE_DIR = stateDir;
process.env.PERCH_LOG_LEVEL = 'error';

const t = await import('./tunnel.js');

// ---------- the bind-address rail ----------

test('private addresses are accepted', () => {
  for (const ip of ['127.0.0.1', '10.89.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.254']) {
    assert.doesNotThrow(() => t.validate({ remoteBind: ip }), `${ip} should be allowed`);
  }
});

test('public addresses are refused', () => {
  for (const ip of ['8.8.8.8', '203.0.113.10', '172.15.0.1', '172.32.0.1', '0.0.0.0']) {
    assert.throws(() => t.validate({ remoteBind: ip }), /private address/, `${ip} should be refused`);
  }
});

test('hostnames, users, ports and proxies are checked', () => {
  assert.doesNotThrow(() => t.validate({ host: 'mail.example.com', user: 'perch', sshPort: 22 }));
  assert.doesNotThrow(() => t.validate({ host: `${'a'.repeat(56)}.onion` }));
  assert.throws(() => t.validate({ host: 'example.com; reboot' }), /hostname/);
  assert.throws(() => t.validate({ user: 'Perch User' }), /account name/);
  assert.throws(() => t.validate({ sshPort: 70000 }), /port number/);
  assert.throws(() => t.validate({ torProxy: '203.0.113.9:9050' }), /this machine or your own network/);
  assert.doesNotThrow(() => t.validate({ torProxy: '127.0.0.1:9050' }));
  assert.doesNotThrow(() => t.validate({ torProxy: '' }));
});

// ---------- pairing ----------

test('the pairing line is found in a full paste of the script output', () => {
  const output = ['==> sshd', '  wrote the drop-in', '', '    perch-pair:v1:10.89.0.1:11434', ''].join('\n');
  assert.deepEqual(t.parsePairing(output), { bind: '10.89.0.1', port: 11434 });
});

test('a paste with no pairing line, or a public one, is refused', () => {
  assert.throws(() => t.parsePairing('some unrelated output'), /No pairing line found/);
  assert.throws(() => t.parsePairing('perch-pair:v1:203.0.113.10:11434'), /private address/);
});

// ---------- ids ----------

test('names become filesystem- and unit-safe ids', () => {
  assert.equal(t.slugify('Mail VPS'), 'mail-vps');
  assert.equal(t.slugify('  ../../etc/passwd  '), 'etc-passwd');
  assert.equal(t.slugify('!!!'), 'tern');
  assert.match(t.slugify('A'.repeat(80)), /^[a-z0-9-]{1,32}$/);
});

// ---------- several connections ----------

test('two connections can exist side by side, each with its own id and key path', async () => {
  const a = await t.createConnection({ name: 'Mail VPS', host: 'mail.example.com' });
  const b = await t.createConnection({ name: 'Laptop', host: 'laptop.local' });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.keyPath, b.keyPath);
  assert.match(a.keyPath, new RegExp(`/ssh/${a.id}/id_ed25519$`));
  assert.equal(t.listConnections().length, 2);
});

test('a repeated name gets a distinct id rather than colliding', async () => {
  const a = await t.createConnection({ name: 'Mail VPS', host: 'other.example.com' });
  assert.notEqual(a.id, 'mail-vps');
  assert.match(a.id, /^mail-vps-\d+$/);
});

test('two connections may not forward the same port on the same host', async () => {
  await assert.rejects(
    () => t.createConnection({ name: 'Duplicate', host: 'mail.example.com', remotePort: 11434 }),
    /already forwards port 11434/,
  );
  // A different port on the same host is fine, as is the same port elsewhere.
  await assert.doesNotReject(() => t.createConnection({ name: 'Second slot', host: 'mail.example.com', remotePort: 11435 }));
  await assert.doesNotReject(() => t.createConnection({ name: 'Elsewhere', host: 'third.example.com', remotePort: 11434 }));
});

test('editing one connection leaves the others alone', async () => {
  const [a, b] = t.listConnections();
  const beforeB = { ...b! };
  await t.updateConnection(a!.id, { torProxy: '127.0.0.1:9050' });
  const afterB = t.listConnections().find((c) => c.id === b!.id)!;
  assert.equal(afterB.host, beforeB.host, "the other connection's host changed");
  assert.equal(afterB.torProxy, beforeB.torProxy, "the other connection's proxy changed");
  assert.equal(t.getConnection(a!.id).torProxy, '127.0.0.1:9050');
});

test('saving one setting does not blank the rest', async () => {
  const c = await t.createConnection({ name: 'Partial', host: 'partial.example.com', sshPort: 2222, user: 'perch', remotePort: 11500 });
  // Exactly the shape an API handler builds from an optional request body.
  await t.updateConnection(c.id, {
    host: undefined, user: undefined, sshPort: undefined, remotePort: undefined, torProxy: '127.0.0.1:9050',
  });
  const after = t.getConnection(c.id);
  assert.equal(after.host, 'partial.example.com');
  assert.equal(after.sshPort, 2222);
  assert.equal(after.remotePort, 11500);
  assert.equal(after.torProxy, '127.0.0.1:9050');
});

test('a connection keeps its id and key path however it is edited', async () => {
  const c = t.listConnections()[0]!;
  await t.updateConnection(c.id, { id: 'hijacked', keyPath: '/etc/shadow' } as never);
  const after = t.getConnection(c.id);
  assert.equal(after.id, c.id);
  assert.match(after.keyPath, new RegExp(`/ssh/${c.id}/id_ed25519$`));
});

// ---------- removal ----------

test('removing a connection retires it, keeps the record, and leaves others running', async () => {
  const before = t.listConnections().filter((c) => !c.retiredAt).length;
  const victim = t.listConnections().find((c) => !c.retiredAt)!;
  await t.retireConnection(victim.id);
  const after = t.getConnection(victim.id);
  assert.ok(after.retiredAt, 'should be marked retired');
  assert.equal(t.listConnections().filter((c) => !c.retiredAt).length, before - 1);
});

test('removal is idempotent', async () => {
  const victim = t.listConnections().find((c) => c.retiredAt)!;
  await assert.doesNotReject(() => t.retireConnection(victim.id));
});

test('a retired connection still knows the command to clean up the far side', () => {
  // The record outlives the key precisely so this can be shown: perch cannot
  // run it, because the tunnel key is restricted to holding a port open.
  const retired = t.listConnections().find((c) => c.retiredAt)!;
  const cmd = t.uninstallCommand({ ...retired, publicKey: 'ssh-ed25519 AAAAC3Nz test' });
  assert.match(cmd!, /--uninstall/);
  assert.match(cmd!, /--key "ssh-ed25519 AAAAC3Nz test"/);
  assert.match(cmd!, new RegExp(`--user ${retired.user}`));
});

test('forgetting drops the record for good', () => {
  const retired = t.listConnections().find((c) => c.retiredAt)!;
  t.forgetConnection(retired.id);
  assert.equal(t.listConnections().some((c) => c.id === retired.id), false);
});

// One SSH session carries every service the connection is set up for, each on
// the port that service is normally found on, so Tern needs a token rather
// than a new number.
test('a chat-only connection forwards one port', async () => {
  const c = await t.createConnection({ name: 'Chat only', host: 'chatonly.example.com', remotePort: 11434 });
  const f = t.forwardsFor(c);
  assert.equal(f.length, 1);
  assert.deepEqual(f.map((x) => [x.id, x.remotePort]), [['chat', 11434]]);
});

// Each service lands on its own number at both ends, so what Tern dials is
// the port that service is normally found on. Chat is the exception: the far
// side may already run an Ollama on the usual port, so this one keeps the
// port the connection was given.
test('each service lands on its own port, chat on the one it was given', async () => {
  const c = await t.createConnection({
    name: 'Everything', host: 'everything.example.com', remotePort: 11500,
    services: ['chat', 'voice', 'video'],
  });
  assert.deepEqual(t.forwardsFor(c).map((x) => [x.id, x.remotePort]),
    [['chat', 11500], ['voice', 8080], ['video', 8188]]);
  // Both ends of a mirrored service agree, which is the point of the change.
  for (const f of t.forwardsFor(c)) {
    if (f.id !== 'chat') assert.equal(f.remotePort, f.localPort, `${f.id} must mirror`);
  }
});

// Ticking one service must not move another's port. It held under the old
// consecutive scheme because the offset was a position in a fixed list; it
// holds now because the port is not derived from the others at all. Either
// way the failure it guards against is silent — the tunnel comes up and lands
// on the wrong port.
test('a service keeps its port whatever else is switched on', async () => {
  const c = await t.createConnection({
    name: 'Chat and audio', host: 'chataudio.example.com', remotePort: 11600,
    services: ['chat', 'audio'],
  });
  assert.deepEqual(t.forwardsFor(c).map((x) => [x.id, x.remotePort]),
    [['chat', 11600], ['audio', 8880]]);

  const more = await t.updateConnection(c.id, { services: ['chat', 'voice', 'audio'] });
  const after = t.forwardsFor(more).find((f) => f.id === 'audio')!;
  assert.equal(after.remotePort, 8880, 'adding dictation must not move audio');
});

// Mirroring costs this: two connections to one machine would both try to bind
// the same port there. Chat can be moved out of the way with its own port,
// and the rest cannot, so the second one is refused rather than left to fail
// at connect time under ExitOnForwardFailure.
test('two connections to one machine may not both carry a service', async () => {
  await assert.rejects(
    () => t.createConnection({
      name: 'Second dictation', host: 'everything.example.com', remotePort: 11700,
      services: ['chat', 'voice'],
    }),
    /already carries dictation/,
  );
  // A different machine is fine, and so is a second connection carrying only
  // chat, which has a port of its own to move to.
  await assert.doesNotReject(() => t.createConnection({
    name: 'Chat as well', host: 'everything.example.com', remotePort: 11700, services: ['chat'],
  }));
});

// ---------- why a tunnel is not up ----------
//
// Restart=always means a tunnel that can never work looks exactly like one
// about to come up, and the two failures that follow a replaced key stay
// broken until somebody acts on them. So the reason ssh gave is carried
// through to the console rather than left in the journal.
function writeHostStatus(unit: string, active: string, reason: string): void {
  const dir = path.join(stateDir, 'host');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    at: new Date().toISOString(),
    tunnels: [{ unit, active, enabled: 'enabled', since: '', reason }],
  }));
}

test('a changed host key and a rejected key are told apart, and explained', async () => {
  const c = await t.createConnection({ name: 'Keys', host: 'keys.example.com', remotePort: 12000 });
  const unit = `perch-tunnel-${c.id}.service`;

  writeHostStatus(unit, 'activating', 'host-key-changed');
  let st = t.statusOf(t.getConnection(c.id));
  assert.equal(st.problem, 'host-key-changed');
  assert.match(st.problemSays, /machine in the middle/, 'must not present this as routine');

  writeHostStatus(unit, 'activating', 'key-rejected');
  st = t.statusOf(t.getConnection(c.id));
  assert.equal(st.problem, 'key-rejected');
  assert.match(st.problemSays, /setup command again/);

  // A reason the console does not know about must not become a problem code,
  // or a future helper string would render as an empty explanation.
  writeHostStatus(unit, 'activating', 'something-new');
  assert.equal(t.statusOf(t.getConnection(c.id)).problem, '');
  assert.equal(t.statusOf(t.getConnection(c.id)).problemSays, '');

  // A running tunnel says nothing at all.
  writeHostStatus(unit, 'active', '');
  assert.equal(t.statusOf(t.getConnection(c.id)).problem, '');
});

test('chat is always carried, even if a caller omits it', async () => {
  const c = await t.createConnection({ name: 'Voice only', host: 'voiceonly.example.com', services: ['voice'] });
  assert.ok(t.forwardsFor(c).some((f) => f.id === 'chat'), 'chat must always be forwarded');
});

// An address on its own does not tell anybody what to send it, and only two
// of these have a field in Tern to be pasted into. Every service must say
// what it speaks, or the Connect page hands out a port with no explanation.
test('every address says what it speaks', () => {
  const c = t.listConnections().find((x) => x.name === 'Everything')!;
  for (const u of t.ternUrls({ ...c, remoteBind: '10.89.0.1' })) {
    assert.ok(u.speaks.length > 10, `${u.id} does not say what it speaks`);
    assert.match(u.url, /^http:\/\/[a-z0-9.]+:\d+$/);
  }
});

test('the setup command permitlists every forwarded port', async () => {
  const c = t.listConnections().find((x) => x.name === 'Everything')!;
  const cmd = t.setupCommand({ ...c, publicKey: 'ssh-ed25519 AAAA test' });
  assert.match(cmd!, /--port 11500,8080,8188/);
});

test('the ssh command has one -R per service', () => {
  const c = t.listConnections().find((x) => x.name === 'Everything')!;
  const preview = t.sshCommandPreview({ ...c, remoteBind: '10.89.0.1' });
  assert.equal((preview.match(/-R /g) ?? []).length, 3);
  assert.match(preview, /-R 10\.89\.0\.1:8080:127\.0\.0\.1:8080/);
});

test('Tern gets a URL per service, and knows where each one goes', () => {
  const c = t.listConnections().find((x) => x.name === 'Everything')!;
  const urls = t.ternUrls({ ...c, remoteBind: '10.89.0.1' });
  assert.deepEqual(urls.map((u) => u.id), ['chat', 'voice', 'video']);
  assert.match(urls[0]!.url, /host\.containers\.internal:11500$/);
  assert.match(urls[1]!.ternField!, /Transcriber/);
  assert.equal(urls[2]!.ternField, null, 'Tern has no setting for images or video to point at');
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
