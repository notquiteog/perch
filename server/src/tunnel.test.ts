// The rail that matters: the tunnel must never be told to land on an address
// the internet can reach. Getting this wrong would publish the model endpoint
// to the world, which is the single failure this design exists to prevent, so
// it is checked in three places — here, in deploy/perch-hostd, and in
// deploy/tern-side-setup.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-tunnel-test-'));
process.env.PERCH_STATE_DIR = stateDir;
process.env.PERCH_LOG_LEVEL = 'error';

const { validate, parsePairing } = await import('./tunnel.js');

test('private addresses are accepted', () => {
  for (const ip of ['127.0.0.1', '10.89.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.254']) {
    assert.doesNotThrow(() => validate({ remoteBind: ip }), `${ip} should be allowed`);
  }
});

test('public addresses are refused', () => {
  for (const ip of ['8.8.8.8', '203.0.113.10', '172.15.0.1', '172.32.0.1', '1.1.1.1', '198.51.100.7']) {
    assert.throws(() => validate({ remoteBind: ip }), /private address/, `${ip} should be refused`);
  }
});

test('0.0.0.0 is refused — it is every interface, including the public one', () => {
  assert.throws(() => validate({ remoteBind: '0.0.0.0' }), /private address/);
});

test('anything that is not a plain IPv4 address is refused', () => {
  for (const bad of ['::1', 'localhost', '10.0.0.1; rm -rf /', '', '10.0.0']) {
    assert.throws(() => validate({ remoteBind: bad }));
  }
});

test('hostnames, users and ports are checked', () => {
  assert.doesNotThrow(() => validate({ host: 'mail.example.com', user: 'perch', sshPort: 22 }));
  assert.throws(() => validate({ host: 'example.com; reboot' }), /hostname/);
  assert.throws(() => validate({ user: 'Perch User' }), /account name/);
  assert.throws(() => validate({ sshPort: 0 }), /port number/);
  assert.throws(() => validate({ sshPort: 70000 }), /port number/);
});

// The pairing line is what removes the "read an IP off a terminal and retype
// it" step, so it has to cope with being handed a whole screen of output.
test('the pairing line is found in a full paste of the script output', () => {
  const output = [
    '==> sshd',
    '  \u2713 wrote /etc/ssh/sshd_config.d/50-perch.conf',
    '  \u2713 sshd reloaded (your current session is untouched)',
    '',
    '  Done. The Tern box is ready.',
    '',
    '  Copy this line into perch, under Connect:',
    '',
    '    perch-pair:v1:10.89.0.1:11434',
    '',
  ].join('\n');
  assert.deepEqual(parsePairing(output), { bind: '10.89.0.1', port: 11434 });
});

test('the bare line works too', () => {
  assert.deepEqual(parsePairing('perch-pair:v1:127.0.0.1:11434'), { bind: '127.0.0.1', port: 11434 });
  assert.deepEqual(parsePairing('  perch-pair:v1:172.20.0.1:9999  '), { bind: '172.20.0.1', port: 9999 });
});

test('a paste with no pairing line says so usefully', () => {
  assert.throws(() => parsePairing('some unrelated terminal output'), /No pairing line found/);
  assert.throws(() => parsePairing(''), /No pairing line found/);
});

test('a pairing line naming a public address is refused, however it arrives', () => {
  // The rail applies to pasted input exactly as it applies to typed input:
  // this is the value that decides what gets bound.
  assert.throws(() => parsePairing('perch-pair:v1:203.0.113.10:11434'), /private address/);
  assert.throws(() => parsePairing('perch-pair:v1:8.8.8.8:11434'), /private address/);
});

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
