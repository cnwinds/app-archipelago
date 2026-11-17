import test from 'node:test';
import assert from 'node:assert/strict';
import { GuardError, isPrivateAddress, resolvePublic } from '../shared/netguard.mjs';
import { checkTarget } from '../worker/egress-proxy.mjs';

const UNSAFE = [
  '127.0.0.1',
  '127.1.2.3',
  '10.0.0.5',
  '172.16.0.1',
  '172.17.0.2', // docker bridge
  '172.31.255.255',
  '192.168.1.1',
  '169.254.169.254', // cloud metadata (AWS, GCP, Azure)
  '100.100.100.200', // cloud metadata (Alibaba Cloud)
  '100.64.0.1',
  '0.0.0.0',
  '224.0.0.1',
  '255.255.255.255',
  '198.18.0.1',
  '::1',
  '::',
  'fe80::1',
  'fc00::1',
  'fd12:3456::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:169.254.169.254',
  '::ffff:a00:1',
  '64:ff9b::7f00:1',
  'not-an-address',
  '',
];

const PUBLIC = ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'];

test('isPrivateAddress refuses internal addresses in every spelling', () => {
  for (const a of UNSAFE) assert.equal(isPrivateAddress(a), true, `${a} should be refused`);
});

test('isPrivateAddress lets public addresses through', () => {
  for (const a of PUBLIC) assert.equal(isPrivateAddress(a), false, `${a} should be allowed`);
});

test('resolvePublic refuses names and literals that lead to internal addresses', async () => {
  for (const host of ['127.0.0.1', '169.254.169.254', '100.100.100.200', '10.1.2.3', '::1', 'localhost']) {
    await assert.rejects(resolvePublic(host), (e) => e instanceof GuardError, host);
  }
});

test('resolvePublic returns a public literal as it is', async () => {
  assert.deepEqual(await resolvePublic('8.8.8.8'), ['8.8.8.8']);
});

test('checkTarget only opens ports 80 and 443', async () => {
  for (const port of [22, 25, 3306, 6379, 8080, 2375]) {
    await assert.rejects(checkTarget('8.8.8.8', port), (e) => e instanceof GuardError && e.code === 'port', String(port));
  }
  assert.equal(await checkTarget('8.8.8.8', 80), '8.8.8.8');
  assert.equal(await checkTarget('8.8.8.8', 443), '8.8.8.8');
});

test('checkTarget refuses the metadata service and loopback', async () => {
  for (const host of ['169.254.169.254', '100.100.100.200', '127.0.0.1', '172.17.0.1']) {
    await assert.rejects(checkTarget(host, 80), (e) => e instanceof GuardError, host);
  }
});
