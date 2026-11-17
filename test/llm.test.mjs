import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlm } from '../server/llm.mjs';

const cfg = { baseUrl: 'http://gateway.test/v1', apiKey: 'k', model: 'm' };
const candidate = {
  id: 'c1',
  url: 'https://example.com/play',
  origin: 'submit',
  analysis: { meta: { title: 'Example Game | Example', text: 'hello', canvasCount: 1 }, embed: { ok: true } },
};

// A fake chat-completions endpoint that answers with the given bodies in order.
function gateway(...answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const a = answers[Math.min(calls.length, answers.length) - 1];
    if (a.status) return new Response(a.text ?? '', { status: a.status });
    return Response.json({ choices: [{ finish_reason: a.finish ?? 'stop', message: { content: a.content } }] });
  };
  return { fetchImpl, calls };
}

const GOOD = {
  category: 'game',
  name: 'Example Game',
  tags: ['益智', '休闲'],
  blurb: '页面说这是一个小游戏。',
  flags: [],
  reject_reason: '',
  confidence: 'high',
};

test('without a key the draft is the page title, from the rules', async () => {
  const llm = createLlm({ ...cfg, apiKey: '' }, { fetchImpl: () => assert.fail('must not call out') });
  assert.equal(llm.enabled, false);
  const d = await llm.draft(candidate);
  assert.equal(d.source, 'fallback');
  assert.equal(d.name, 'Example Game');
});

test('a good answer becomes an llm draft; the request leaves room for reasoning models', async () => {
  const gw = gateway({ content: JSON.stringify(GOOD) });
  const d = await createLlm(cfg, { fetchImpl: gw.fetchImpl }).draft(candidate);
  assert.equal(d.source, 'llm');
  assert.equal(d.model, 'm');
  assert.equal(d.category, 'game');
  assert.equal(gw.calls[0].url, 'http://gateway.test/v1/chat/completions');
  assert.ok(gw.calls[0].body.max_tokens >= 1500, 'thinking tokens count against max_tokens');
});

test('JSON wrapped in a code fence is accepted', async () => {
  const gw = gateway({ content: '```json\n' + JSON.stringify(GOOD) + '\n```' });
  const d = await createLlm(cfg, { fetchImpl: gw.fetchImpl }).draft(candidate);
  assert.equal(d.source, 'llm');
  assert.equal(d.name, 'Example Game');
});

test('a cut-off or empty answer is retried once, then the draft falls back', async () => {
  const logs = [];
  const gw = gateway({ finish: 'length', content: '{"category":"ga' }, { content: '' });
  const d = await createLlm(cfg, { fetchImpl: gw.fetchImpl, log: (m) => logs.push(m) }).draft(candidate);
  assert.equal(gw.calls.length, 2);
  assert.equal(d.source, 'fallback');
  assert.match(logs[0], /cut off/);
  assert.match(logs[1], /empty/);
});

test('a gateway error on the first try is recovered by the second', async () => {
  const gw = gateway({ status: 502, text: 'bad gateway' }, { content: JSON.stringify(GOOD) });
  const d = await createLlm(cfg, { fetchImpl: gw.fetchImpl }).draft(candidate);
  assert.equal(d.source, 'llm');
  assert.equal(gw.calls.length, 2);
});

test('whatever the model invents outside the schema is dropped', async () => {
  const gw = gateway({
    content: JSON.stringify({
      category: 'weapons',
      name: 'X'.repeat(200),
      tags: ['a', 'b', 'c', 'd', 'e', 'f'],
      blurb: 'ok',
      flags: ['phishing', 'is_great', 'needs_download'],
      reject_reason: '需要下载安装包',
      confidence: 'certain',
    }),
  });
  const d = await createLlm(cfg, { fetchImpl: gw.fetchImpl }).draft(candidate);
  assert.equal(d.category, '');
  assert.equal(d.name.length, 40);
  assert.equal(d.tags.length, 4);
  assert.deepEqual(d.flags, ['phishing', 'needs_download']);
  assert.equal(d.confidence, 'low');
  assert.equal(d.rejectReason, '需要下载安装包');
});
