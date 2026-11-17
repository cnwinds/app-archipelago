import test from 'node:test';
import assert from 'node:assert/strict';
import { UserError, checkSubmittedUrl } from '../server/urlcheck.mjs';
import { normalizeUrl, slugFor } from '../shared/url.mjs';

const check = (u) => checkSubmittedUrl(u, { resolveDns: false });

test('accepts an ordinary address and fills in https', async () => {
  assert.equal(await check('example.com'), 'https://example.com/');
  assert.equal(await check('  https://Example.com/play  '), 'https://example.com/play');
});

test('the same work submitted in different spellings gets one id', async () => {
  const a = await check('https://www.Example.com/game/?utm_source=hn#top');
  const b = await check('example.com/game');
  assert.equal(slugFor(a), slugFor(b));
});

test('ids stay what the earlier pipeline produced', () => {
  assert.equal(slugFor(normalizeUrl('https://ncase.me/trust/')), 'ncase-me-trust');
  assert.equal(slugFor(normalizeUrl('https://guitoro.com/')), 'guitoro-com');
});

const REFUSED = [
  ['', 'empty'],
  ['ftp://example.com/file', 'scheme'],
  ['javascript:alert(1)', 'invalid'], // has no "//", so it is read as a host name with a bad port
  ['https://user:secret@example.com/', 'credentials'],
  ['http://127.0.0.1/', 'literal'],
  ['http://2130706433/', 'literal'], // 127.0.0.1 as one number
  ['http://0x7f.1/', 'literal'],
  ['http://169.254.169.254/latest/meta-data/', 'literal'],
  ['http://100.100.100.200/', 'literal'],
  ['http://[::1]/', 'literal'],
  ['http://localhost/', 'internal'],
  ['http://intranet/', 'internal'],
  ['http://printer.local/', 'internal'],
  ['http://app.internal/', 'internal'],
  ['https://example.com:8080/', 'port'],
  ['https://example.com:22/', 'port'],
  ['https://isle.ai-news.top/', 'own'],
  ['https://sub.isle.ai-news.top/', 'own'],
  ['https://github.com/someone/repo', 'not_playable'],
  ['https://example.com/setup.exe', 'not_playable'],
];

for (const [input, code] of REFUSED) {
  test(`refuses ${JSON.stringify(input)} (${code})`, async () => {
    await assert.rejects(check(input), (e) => e instanceof UserError && e.code === code, `${input} -> ${code}`);
  });
}

test('refuses absurdly long input', async () => {
  await assert.rejects(check(`https://example.com/${'a'.repeat(3000)}`), (e) => e instanceof UserError && e.code === 'too_long');
});