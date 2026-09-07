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

const { validate } = await import('./tunnel.js');

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

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
