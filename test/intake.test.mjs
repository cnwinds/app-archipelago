// The rules of the intake service, run against an in-memory database and a temp directory:
// what happens to a candidate from submission to publication, and what must never happen.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanListing } from '../server/intake.mjs';
import { minutesAgo } from '../server/store.mjs';
import { UserError } from '../server/urlcheck.mjs';
import { b64, bad, good, setup, tick, webp } from './helpers.mjs';

const is = (Class) => (e) => e instanceof Class;

// Submit a url, let a worker claim it, and report `result`.
async function analyse(ctx, url, result, { cover = webp(4000), embedShot } = {}) {
  const { id } = await ctx.intake.submit({ url, submitter: 'v1' });
  const job = ctx.intake.claim('w1');
  assert.equal(job.candidate.id, id);
  const outcome = ctx.intake.handleResult(job.id, { result, cover: cover && b64(cover), embedShot: embedShot && b64(embedShot) });
  await tick();
  return { id, job, outcome };
}

const listing = { category: 'game', name: '示例游戏', blurb: '一句话介绍。' };

// ---- getting in ---------------------------------------------------------------------------

test('a submission becomes one queued candidate with one urgent job; the same address again adds nothing', async (t) => {
  const { intake, store } = setup(t);
  const first = await intake.submit({ url: 'https://Play.Example.com/?utm_source=x', submitter: 'v1' });
  assert.equal(first.created, true);
  assert.equal(first.state, 'queued');
  const again = await intake.submit({ url: 'https://play.example.com/', submitter: 'v2' });
  assert.equal(again.created, false);
  assert.equal(again.id, first.id);
  assert.equal(store.queueLength(), 1);
  assert.equal(store.get(first.id).job.kind, 'analyze');
});

test('submissions that are not public websites are refused before anything is stored', async (t) => {
  const { intake, store } = setup(t);
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'https://user:pw@example.com/', 'ftp://example.com/', 'not a url', 'http://localhost/', 'https://intranet.local/']) {
    await assert.rejects(intake.submit({ url }), is(UserError), url);
  }
  assert.equal(store.queueLength(), 0);
  assert.equal(store.countSubmissions({ since: minutesAgo(60) }), 0);
});

test('quota: per visitor and per day', async (t) => {
  const { intake } = setup(t); // 2 per visitor, 3 per day
  const send = async (host, who) => {
    intake.checkQuota(who);
    return intake.submit({ url: `https://${host}.example.com/`, submitter: who });
  };
  await send('a', 'v1');
  await send('b', 'v1');
  assert.throws(() => intake.checkQuota('v1'), (e) => e instanceof UserError && e.status === 429 && e.code === 'quota');
  await send('c', 'v2');
  assert.throws(() => intake.checkQuota('v3'), (e) => e instanceof UserError && e.status === 429 && e.code === 'busy');
});

// ---- a good visit -------------------------------------------------------------------------

test('a good visit puts the candidate in the review queue with a cover and a draft', async (t) => {
  const ctx = setup(t);
  const { id, outcome } = await analyse(ctx, 'https://play.example.com/', good(), { embedShot: webp(500) });
  assert.deepEqual(outcome, { ok: true });
  const c = ctx.store.get(id);
  assert.equal(c.state, 'pending_review');
  assert.equal(c.analysis.ok, true);
  assert.equal(c.title, 'Play Example', 'the page title replaces the hostname for submissions');
  assert.ok(c.analysis.coverBytes > 4000);
  assert.ok(existsSync(join(ctx.paths.shots, `${id}.webp`)));
  assert.ok(existsSync(join(ctx.paths.shots, `${id}.embed.webp`)));
  assert.equal(c.curation.ai.source, 'test');
  assert.deepEqual([c.curation.category, c.curation.name, c.curation.blurb], ['game', 'Drafted', '草稿介绍']);
  assert.equal(c.job.state, 'done');
  assert.equal(ctx.store.queueLength(), 0);
});

test('a draft fills in only what the reviewer has not written', async (t) => {
  const ctx = setup(t);
  const { id } = await analyse(ctx, 'https://play.example.com/', good());
  ctx.intake.edit(id, { name: '我改的名字' });
  await ctx.intake.draft(id, { force: true });
  const c = ctx.store.get(id);
  assert.equal(c.curation.name, '我改的名字');
  assert.equal(ctx.drafts(), 2);
  await ctx.intake.draft(id); // not forced: one draft per candidate is enough
  assert.equal(ctx.drafts(), 2);
});

test('the worker cannot upload something that is not a webp image, or answer a job twice', async (t) => {
  const ctx = setup(t);
  const { id } = await ctx.intake.submit({ url: 'https://play.example.com/' });
  const job = ctx.intake.claim('w1');
  assert.throws(
    () => ctx.intake.handleResult(job.id, { result: good(), cover: b64(Buffer.from('<?php system($_GET[0]); ?>')) }),
    (e) => e instanceof UserError && e.code === 'bad_image',
  );
  assert.equal(ctx.store.get(id).state, 'analyzing', 'a refused upload changes nothing');
  ctx.intake.handleResult(job.id, { result: good(), cover: b64(webp(100)) });
  assert.throws(() => ctx.intake.handleResult(job.id, { result: good() }), (e) => e instanceof UserError && e.status === 409);
  assert.throws(() => ctx.intake.handleResult(99999, { result: good() }), (e) => e instanceof UserError && e.status === 409);
});

// ---- failures and retries -----------------------------------------------------------------

test('a flaky page is retried later; a page with a bad certificate is not', async (t) => {
  const ctx = setup(t);
  const net = await ctx.intake.submit({ url: 'https://flaky.example.com/' });
  const job = ctx.intake.claim('w1');
  assert.deepEqual(ctx.intake.handleResult(job.id, { result: bad('network', 'timeout') }), { retry: true });
  let c = ctx.store.get(net.id);
  assert.equal(c.state, 'queued');
  assert.match(c.attention, /1\/3/);
  assert.ok(Date.parse(c.job.runAfter) > Date.now() + 5 * 60000, 'waits before the next try');
  assert.equal(ctx.intake.claim('w1'), null, 'and nobody gets it before then');

  const cert = await ctx.intake.submit({ url: 'https://expired.example.com/' });
  const job2 = ctx.intake.claim('w1');
  assert.equal(job2.candidate.id, cert.id);
  assert.deepEqual(ctx.intake.handleResult(job2.id, { result: bad('cert', 'certificate expired') }), { failed: true });
  c = ctx.store.get(cert.id);
  assert.equal(c.state, 'failed');
  assert.equal(c.analysis.ok, false);
  assert.equal(c.analysis.errorKind, 'cert');
});

test('a page that keeps failing ends on the failed list, and checking again can bring it back', async (t) => {
  const ctx = setup(t);
  const { id } = await ctx.intake.submit({ url: 'https://down.example.com/' });
  for (let i = 0; i < 3; i++) {
    ctx.db.exec("UPDATE jobs SET run_after = '2000-01-01T00:00:00.000Z' WHERE state = 'queued'");
    const job = ctx.intake.claim('w1');
    ctx.intake.handleResult(job.id, { result: bad('network') });
  }
  assert.equal(ctx.store.get(id).state, 'failed');
  assert.equal(ctx.store.queueLength(), 0);

  ctx.intake.reanalyze(id);
  assert.equal(ctx.store.get(id).state, 'queued');
  const job = ctx.intake.claim('w1');
  ctx.intake.handleResult(job.id, { result: good(), cover: b64(webp(3000)) });
  assert.equal(ctx.store.get(id).state, 'pending_review');
});

test('a worker that vanished mid-job loses the job back to the queue; three crashes give up', async (t) => {
  const ctx = setup(t);
  const { id } = await ctx.intake.submit({ url: 'https://crashy.example.com/' });
  for (let crash = 1; crash <= 3; crash++) {
    const job = ctx.intake.claim('w1');
    assert.ok(job, `claimed on round ${crash}`);
    ctx.db.prepare('UPDATE jobs SET locked_at = ? WHERE id = ?').run(minutesAgo(11), job.id);
  }
  assert.equal(ctx.intake.claim('w2'), null);
  const c = ctx.store.get(id);
  assert.equal(c.state, 'failed');
  assert.match(c.attention, /crashing/);
});

// ---- rechecks must not make things worse --------------------------------------------------

async function liveWork(ctx, url = 'https://play.example.com/') {
  const { id } = await analyse(ctx, url, good(), { cover: webp(6000) });
  ctx.intake.approve(id, listing);
  return id;
}

test('a failed recheck of a live work keeps it live, keeps its analysis and tells the reviewer', async (t) => {
  const ctx = setup(t);
  const id = await liveWork(ctx);
  const before = ctx.store.get(id).analysis;
  ctx.intake.reanalyze(id);
  ctx.store.db.exec("UPDATE jobs SET kind = 'recheck'");
  for (let i = 0; i < 3; i++) {
    ctx.db.exec("UPDATE jobs SET run_after = '2000-01-01T00:00:00.000Z' WHERE state = 'queued'");
    const job = ctx.intake.claim('w1');
    ctx.intake.handleResult(job.id, { result: bad('network', 'timeout') });
  }
  const c = ctx.store.get(id);
  assert.equal(c.state, 'approved');
  assert.equal(c.analysis.ok, true);
  assert.equal(c.analysis.checkedAt, before.checkedAt);
  assert.match(c.attention, /失败/);
  assert.equal(JSON.parse(readFileSync(ctx.paths.published, 'utf8')).length, 1);
});

test('a recheck never replaces an existing cover; a re-analysis only for something at least half as detailed', async (t) => {
  const ctx = setup(t);
  const id = await liveWork(ctx);
  const cover = join(ctx.paths.shots, `${id}.webp`);
  const original = statSync(cover).size;

  // recheck: the cover stays, however good the new one is
  ctx.store.enqueue(id, 'recheck', { priority: 2 });
  let job = ctx.intake.claim('w1');
  assert.equal(job.kind, 'recheck');
  ctx.intake.handleResult(job.id, { result: good(), cover: b64(webp(20000)) });
  assert.equal(statSync(cover).size, original);

  // re-analysis with a loading screen: kept, and the reviewer is told
  ctx.intake.reanalyze(id);
  job = ctx.intake.claim('w1');
  ctx.intake.handleResult(job.id, { result: good(), cover: b64(webp(800)) });
  assert.equal(statSync(cover).size, original);
  assert.match(ctx.store.get(id).analysis.coverNote, /kept the previous cover/);

  // re-analysis with a better one: replaced
  ctx.intake.reanalyze(id);
  job = ctx.intake.claim('w1');
  ctx.intake.handleResult(job.id, { result: good(), cover: b64(webp(9000)) });
  assert.ok(statSync(cover).size > original);
});

test('a recheck that suddenly cannot embed: believe definite verdicts, doubt vague ones', async (t) => {
  const ctx = setup(t);
  const id = await liveWork(ctx);
  const recheck = (embed) => {
    ctx.store.enqueue(id, 'recheck', { priority: 2 });
    const job = ctx.intake.claim('w1');
    ctx.intake.handleResult(job.id, { result: good({ embed }), cover: b64(webp(100)) });
    return ctx.store.get(id);
  };

  let c = recheck({ ok: false, reason: 'timeout', warnings: [] });
  assert.equal(c.analysis.embed.ok, true, 'a timeout says little: keep the earlier verdict');
  assert.match(c.attention, /原因不明/);

  c = recheck({ ok: false, reason: 'x-frame-options', warnings: [] });
  assert.equal(c.analysis.embed.ok, false, 'the site now forbids framing: believe it');
  assert.match(c.attention, /不能再嵌入/);
  assert.equal(JSON.parse(readFileSync(ctx.paths.published, 'utf8'))[0].embed, false, 'and the site stops embedding it');
});

// ---- the reviewer's decisions and the published catalog -----------------------------------

test('approval needs a good check and a complete listing', async (t) => {
  const ctx = setup(t);
  const unchecked = await ctx.intake.submit({ url: 'https://unchecked.example.com/' });
  assert.throws(() => ctx.intake.approve(unchecked.id, listing), (e) => e.code === 'not_checked');
  ctx.store.finishJob(ctx.store.get(unchecked.id).job.id); // out of the way of the next claim

  const { id } = await analyse(ctx, 'https://play.example.com/', good());
  assert.throws(() => ctx.intake.approve(id, { category: 'nope', name: 'x', blurb: 'y' }), (e) => e.code === 'category');
  assert.throws(() => ctx.intake.approve(id, { category: 'game', name: '', blurb: 'y' }), (e) => e.code === 'name');
  assert.throws(() => ctx.intake.approve(id, { category: 'game', name: 'x', blurb: '' }), (e) => e.code === 'blurb');
  assert.throws(() => ctx.intake.approve(id, { ...listing, score: 101 }), (e) => e.code === 'score');
  assert.equal(ctx.store.get(id).state, 'pending_review');
  assert.ok(!existsSync(ctx.paths.published) || JSON.parse(readFileSync(ctx.paths.published, 'utf8')).length === 0);
});

test('publishing: only approved works, best first, hand-added works never look new, covers of approved works only', async (t) => {
  const ctx = setup(t);
  // Hacker News work, 100 points -> 20 + 25.5 * 2 = 71
  const hn = ctx.store.addCandidate({ url: 'https://hn.example.com/', origin: 'hn', source: { type: 'hn', points: 100, author: 'pg', postedAt: '2026-11-15T00:00:00Z', link: 'https://news.ycombinator.com/item?id=1' }, title: 'HN work' });
  ctx.store.enqueue(hn.id, 'analyze');
  ctx.intake.handleResult(ctx.intake.claim('w').id, { result: good({ finalUrl: 'https://hn.example.com/' }), cover: b64(webp(3000)) });
  ctx.intake.approve(hn.id, listing);

  const mine = (await analyse(ctx, 'https://mine.example.com/', good(), { cover: webp(3000) })).id;
  ctx.intake.approve(mine, { ...listing, name: '手工作品', score: 95, embedOverride: false });

  const pending = (await analyse(ctx, 'https://pending.example.com/', good())).id;
  const rejected = (await analyse(ctx, 'https://rejected.example.com/', good())).id;
  ctx.intake.reject(rejected, '需要下载');

  const list = JSON.parse(readFileSync(ctx.paths.published, 'utf8'));
  assert.deepEqual(list.map((w) => w.id), [mine, hn.id], 'sorted by score');
  assert.equal(list[0].score, 95);
  assert.equal(list[0].embed, false, 'embedOverride=false forces a new tab even though the check said it embeds');
  assert.equal(list[0].postedAt, null, 'no invented date');
  assert.equal(list[1].score, 71);
  assert.equal(list[1].embed, true);
  assert.equal(list[1].postedAt, '2026-11-15T00:00:00Z');
  assert.match(list[1].shotV, /^[0-9a-f]{8}$/);

  const shots = [mine, hn.id].map((id) => `${id}.webp`).sort();
  assert.deepEqual(readdirSync(ctx.paths.publicShots).sort(), shots);
  assert.ok(!existsSync(join(ctx.paths.publicShots, `${pending}.webp`)), 'a pending candidate never leaves the private directory');
  assert.ok(!existsSync(join(ctx.paths.publicShots, `${rejected}.webp`)));
  assert.ok(existsSync(join(ctx.paths.shots, `${pending}.webp`)));
});

test('taking a work down, rejecting a live one and approving again all keep the catalog in step', async (t) => {
  const ctx = setup(t);
  const id = await liveWork(ctx);
  const ids = () => JSON.parse(readFileSync(ctx.paths.published, 'utf8')).map((w) => w.id);
  assert.deepEqual(ids(), [id]);

  ctx.intake.unpublish(id);
  assert.equal(ctx.store.get(id).state, 'hidden');
  assert.deepEqual(ids(), []);
  assert.ok(!existsSync(join(ctx.paths.publicShots, `${id}.webp`)), 'its public cover goes too');
  assert.throws(() => ctx.intake.unpublish(id), (e) => e.code === 'not_live');

  ctx.intake.approve(id, {});
  assert.deepEqual(ids(), [id]);
  ctx.intake.reject(id, '重复');
  assert.deepEqual(ids(), []);
  assert.equal(ctx.store.get(id).curation.reason, '重复');
});

test('editing a live work republishes it, and cannot blank a required field', async (t) => {
  const ctx = setup(t);
  const id = await liveWork(ctx);
  ctx.intake.edit(id, { blurb: '新的介绍' });
  assert.equal(JSON.parse(readFileSync(ctx.paths.published, 'utf8'))[0].blurb, '新的介绍');
  assert.throws(() => ctx.intake.edit(id, { blurb: '   ' }), (e) => e.code === 'incomplete');
});

test('what reviewers type is cleaned: lengths, tags, scores', () => {
  assert.deepEqual(cleanListing({ tags: '博弈论, 互动讲解，演示  extra' }).tags, ['博弈论', '互动讲解', '演示', 'extra']);
  assert.equal(cleanListing({ tags: Array.from({ length: 12 }, (_, i) => `t${i}`) }).tags.length, 6);
  assert.equal(cleanListing({ name: 'x'.repeat(100) }).name.length, 40);
  assert.equal(cleanListing({ blurb: '  很多   空格\n换行 ' }).blurb, '很多 空格 换行');
  assert.equal(cleanListing({ score: '' }).score, null);
  assert.equal(cleanListing({ score: '85' }).score, 85);
  assert.throws(() => cleanListing({ score: 80.5 }), is(UserError));
  assert.throws(() => cleanListing({ category: 'weapons' }), is(UserError));
  assert.deepEqual(cleanListing({}), {}, 'only the keys present are returned');
});

// ---- the queue ----------------------------------------------------------------------------

test('asking again for a check only makes the waiting job more urgent', async (t) => {
  const ctx = setup(t);
  const hn = ctx.store.addCandidate({ url: 'https://later.example.com/', origin: 'hn', source: { type: 'hn', points: 50 } });
  const first = ctx.store.enqueue(hn.id, 'recheck', { priority: 2 });
  const second = ctx.store.enqueue(hn.id, 'analyze', { priority: 0 });
  assert.equal(second.id, first.id);
  assert.equal(second.created, false);
  assert.equal(ctx.store.queueLength(), 1);
  assert.equal(ctx.db.prepare('SELECT priority FROM jobs WHERE id = ?').get(first.id).priority, 0);
});

test('background work is capped per hour; submissions are never held back', async (t) => {
  const ctx = setup(t); // cap: 2 per hour
  const ids = ['a', 'b', 'c'].map((n) => ctx.store.addCandidate({ url: `https://${n}.example.com/`, origin: 'hn', source: { type: 'hn', points: 30 } }).id);
  for (const id of ids) ctx.store.enqueue(id, 'analyze', { priority: 1 });
  assert.ok(ctx.intake.claim('w'));
  assert.ok(ctx.intake.claim('w'));
  assert.equal(ctx.intake.claim('w'), null, 'third background job waits for the next hour');
  const submitted = await ctx.intake.submit({ url: 'https://visitor.example.com/', submitter: 'v1' });
  const job = ctx.intake.claim('w');
  assert.equal(job.candidate.id, submitted.id, 'a visitor is waiting: no cap');
});

test('jobs go out most urgent first, then oldest first', async (t) => {
  const ctx = setup(t);
  const add = (n, priority) => {
    const id = ctx.store.addCandidate({ url: `https://${n}.example.com/`, origin: 'hn', source: { type: 'hn', points: 30 } }).id;
    ctx.store.enqueue(id, 'analyze', { priority });
    return id;
  };
  const [low, urgent, mid1, mid2] = [add('low', 2), add('urgent', 0), add('mid1', 1), add('mid2', 1)];
  const order = [1, 2, 3, 4].map(() => ctx.store.claim('w').candidate.id);
  assert.deepEqual(order, [urgent, mid1, mid2, low]);
});

test('the review queue lists visitors first, then the best Hacker News scores', async (t) => {
  const ctx = setup(t);
  const hn = (n, points) => {
    const id = ctx.store.addCandidate({ url: `https://${n}.example.com/`, origin: 'hn', source: { type: 'hn', points }, state: 'pending_review' }).id;
    return id;
  };
  const low = hn('low', 31);
  const high = hn('high', 400);
  const visitor = ctx.store.addCandidate({ url: 'https://visitor.example.com/', origin: 'submit', state: 'pending_review' }).id;
  const { items, total } = ctx.store.list({ states: ['pending_review'] });
  assert.equal(total, 3);
  assert.deepEqual(items.map((c) => c.id), [visitor, high, low]);
  assert.equal(ctx.store.list({ states: ['pending_review'], q: 'HIGH' }).items.length, 1);
  assert.equal(ctx.store.list({ states: ['pending_review'], q: '100%' }).items.length, 0, 'search characters are not wildcards');
});

test('export keeps the shape of the old curation.json', async (t) => {
  const ctx = setup(t);
  const id = await liveWork(ctx);
  ctx.intake.edit(id, { score: 88, tags: ['a', 'b'], embedOverride: false });
  const rejected = (await analyse(ctx, 'https://no.example.com/', good())).id;
  ctx.intake.reject(rejected, '需要下载');
  const out = ctx.store.exportCuration();
  assert.deepEqual(out[id], { status: 'approved', category: 'game', name: '示例游戏', tags: ['a', 'b'], blurb: '一句话介绍。', score: 88, embed: false });
  assert.deepEqual(out[rejected], { status: 'rejected', reason: '需要下载' });
});
