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

// ---- works whose page has no text: the vision model looks at the cover ----

const vcfg = { ...cfg, visionModel: 'vl' };
const IMAGE = Buffer.from('RIFF....WEBPfake');
const NO_TEXT = { ...GOOD, blurb: '', confidence: 'high' };
const SEEN = { blurb: '黑色背景上的金色线条插画，两个人在炉火旁。', category: 'creative', tags: ['插画'], confidence: 'high' };

test('no text on the page: the blurb is written from the cover picture and marked as such', async () => {
  const gw = gateway({ content: JSON.stringify(NO_TEXT) }, { content: JSON.stringify(SEEN) });
  const d = await createLlm(vcfg, { fetchImpl: gw.fetchImpl }).draft(candidate, { image: IMAGE });

  assert.equal(gw.calls.length, 2);
  assert.equal(gw.calls[1].body.model, 'vl');
  const parts = gw.calls[1].body.messages[1].content;
  assert.ok(Array.isArray(parts));
  assert.match(parts.find((p) => p.type === 'image_url').image_url.url, /^data:image\/webp;base64,/);
  assert.match(gw.calls[1].body.messages[0].content, /不可信/, 'text inside the picture is untrusted too');

  assert.equal(d.blurb, SEEN.blurb);
  assert.equal(d.blurbFrom, 'image');
  assert.equal(d.visionModel, 'vl');
  assert.equal(d.category, 'game', 'what the text model already decided is kept');
  assert.deepEqual(d.tags, ['益智', '休闲']);
  assert.equal(d.confidence, 'medium', 'a picture is never "high"');
});

test('category and tags still empty after the text model are taken from the picture', async () => {
  const gw = gateway({ content: JSON.stringify({ ...NO_TEXT, category: '', tags: [] }) }, { content: JSON.stringify(SEEN) });
  const d = await createLlm(vcfg, { fetchImpl: gw.fetchImpl }).draft(candidate, { image: IMAGE });
  assert.equal(d.category, 'creative');
  assert.deepEqual(d.tags, ['插画']);
});

test('the picture is not used when the page already gave a blurb, or when there is no vision model or no picture', async () => {
  for (const [c, opts] of [
    [vcfg, { image: IMAGE }, 'has blurb'],
    [cfg, { image: IMAGE }, 'no vision model'],
    [vcfg, {}, 'no picture'],
  ]) {
    const first = c === vcfg && opts.image ? GOOD : NO_TEXT;
    const gw = gateway({ content: JSON.stringify(first) }, { content: JSON.stringify(SEEN) });
    const d = await createLlm(c, { fetchImpl: gw.fetchImpl }).draft(candidate, opts);
    assert.equal(gw.calls.length, 1);
    assert.equal(d.blurbFrom, undefined);
  }
});

test('a vision model that fails or sees only a loading screen leaves the blurb empty, nothing else breaks', async () => {
  const logs = [];
  const down = gateway({ content: JSON.stringify(NO_TEXT) }, { status: 502, text: 'upstream' });
  const a = await createLlm(vcfg, { fetchImpl: down.fetchImpl, log: (m) => logs.push(m) }).draft(candidate, { image: IMAGE });
  assert.equal(a.source, 'llm');
  assert.equal(a.blurb, '');
  assert.equal(a.name, 'Example Game');
  assert.match(logs[0], /cover description failed/);

  const loading = gateway({ content: JSON.stringify(NO_TEXT) }, { content: JSON.stringify({ blurb: '', category: '', tags: [], confidence: 'low' }) });
  const b = await createLlm(vcfg, { fetchImpl: loading.fetchImpl }).draft(candidate, { image: IMAGE });
  assert.equal(b.blurb, '');
  assert.equal(b.blurbFrom, undefined);
});
