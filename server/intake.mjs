// The intake service: what happens to a candidate from the moment it is submitted to the moment
// it is live. HTTP lives elsewhere; this file is the rules.

import { CATEGORY_IDS } from '../shared/rules.mjs';
import { saveCover, saveEmbedShot, writePublished } from './files.mjs';
import { minutesFromNow, nowIso } from './store.mjs';
import { checkSubmittedUrl, UserError } from './urlcheck.mjs';

// How often a failing page is tried before it lands on the "failed" list, by kind of failure.
// A wrong certificate will not fix itself; a flaky overseas route might.
const MAX_ATTEMPTS = { network: 3, blocked: 2, http: 2, cert: 1, other: 2 };
const BACKOFF_MINUTES = [10, 360];
// An embed verdict worth believing. A timeout or an error from a slow server says little.
const DEFINITE_EMBED_VERDICTS = new Set(['x-frame-options', 'csp-frame-ancestors', 'mixed-content', 'needs-cross-origin-isolation']);

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isWebp = (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';

function decodeImage(b64, label) {
  if (b64 == null) return null;
  const buf = Buffer.from(String(b64), 'base64');
  if (buf.length > 3 * 1024 * 1024 || !isWebp(buf)) throw new UserError('bad_image', `${label} is not a webp image`, 400);
  return buf;
}

// Only the keys present are checked and returned, so the same function serves a full approval
// and a one-field edit.
export function cleanListing(f) {
  const out = {};
  if ('category' in f) {
    if (!CATEGORY_IDS.includes(f.category)) throw new UserError('category', '请选择一个分类');
    out.category = f.category;
  }
  if ('name' in f) out.name = text(f.name, 40);
  if ('tags' in f) {
    const list = Array.isArray(f.tags) ? f.tags : String(f.tags ?? '').split(/[,，、\s]+/);
    out.tags = list.map((t) => text(t, 20)).filter(Boolean).slice(0, 6);
  }
  if ('blurb' in f) out.blurb = text(f.blurb, 200);
  if ('score' in f) {
    if (f.score === null || f.score === '') out.score = null;
    else {
      const n = Number(f.score);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new UserError('score', '品质分要是 0 到 100 的整数');
      out.score = n;
    }
  }
  // null = follow the health check; false = always open in a new tab.
  if ('embedOverride' in f) out.embedOverride = f.embedOverride === false ? false : null;
  return out;
}

export function createIntake({ store, config, llm, log = console.log }) {
  const { paths } = config;
  const publish = () => writePublished(store, paths);

  // ---- getting candidates in --------------------------------------------------------------

  async function submit({ url, note = null, submitter = null, origin = 'submit' }) {
    const checked = await checkSubmittedUrl(url, { resolveDns: config.checkDns });
    const added = store.addCandidate({
      url: checked,
      title: new URL(checked).hostname.replace(/^www\./, ''),
      origin,
      note: note ? text(note, 300) : null,
      submitter,
    });
    if (!added.created) return { id: added.id, created: false, state: store.get(added.id).state };
    store.enqueue(added.id, 'analyze', { priority: 0 });
    return { id: added.id, created: true, state: 'queued' };
  }

  function checkQuota(submitter) {
    const since = new Date(Date.now() - 86400000).toISOString();
    if (store.countSubmissions({ since }) >= config.limits.submitPerDay) throw new UserError('busy', '今天收到的投稿太多了，请明天再来', 429);
    if (store.countSubmissions({ submitter, since }) >= config.limits.submitPerIpPerDay) {
      throw new UserError('quota', `每个人每天最多投稿 ${config.limits.submitPerIpPerDay} 个，请明天再来`, 429);
    }
  }

  // ---- the worker's side ------------------------------------------------------------------

  function claim(workerId) {
    store.kvSet('worker_seen', nowIso());
    store.kvSet('worker_id', workerId);
    return store.claim(workerId, { hourlyCap: config.limits.analysesPerHour });
  }

  async function draft(id, { force = false } = {}) {
    const c = store.get(id);
    if (!c || c.analysis?.ok !== true) return null;
    if (!force && c.curation?.ai) return c.curation.ai;
    const d = await llm.draft(c);
    const have = c.curation ?? {};
    const patch = { ai: { ...d, at: nowIso() } };
    // Pre-fill only what the reviewer has not touched.
    if (!have.category && d.category) patch.category = d.category;
    if (!have.name && d.name) patch.name = d.name;
    if (!have.tags?.length && d.tags?.length) patch.tags = d.tags;
    if (!have.blurb && d.blurb) patch.blurb = d.blurb;
    store.saveCuration(id, patch);
    return patch.ai;
  }

  // The worker reports one finished job. `body` is { result, cover, embedShot } with the images
  // as base64 webp.
  function handleResult(jobId, body) {
    const job = store.getJob(jobId);
    if (!job || job.state !== 'running') throw new UserError('no_such_job', 'job is not running', 409);
    const id = job.candidate_id;
    const c = store.get(id);
    const r = body?.result;
    if (!r || typeof r !== 'object') throw new UserError('bad_result', 'missing result');
    const hadGood = c.analysis?.ok === true;

    if (!r.ok) {
      const attempts = job.attempts + 1;
      const max = MAX_ATTEMPTS[r.errorKind] ?? MAX_ATTEMPTS.other;
      if (attempts < max) {
        store.retryJob(jobId, minutesFromNow(BACKOFF_MINUTES[attempts - 1] ?? 360), attempts);
        const note = `${job.kind === 'recheck' ? '复查' : '体检'}失败，稍后重试（${attempts}/${max}）：${text(r.error, 120)}`;
        if (c.state === 'analyzing' || c.state === 'queued') store.setState(id, 'queued', note);
        else store.setAttention(id, note);
        return { retry: true };
      }
      store.finishJob(jobId);
      if (hadGood) {
        // Never throw away a good earlier result because one visit failed.
        store.setAttention(id, `${job.kind === 'recheck' ? '复查' : '重新体检'}失败：${text(r.error, 120)}`);
      } else {
        store.saveAnalysis(id, { ...r, ok: false });
        store.setState(id, 'failed', null);
      }
      return { failed: true };
    }

    // ---- a good visit ----
    const previous = c.analysis;
    const cover = decodeImage(body.cover, 'cover');
    const embedShot = decodeImage(body.embedShot, 'embedShot');
    const analysis = { ...r };
    analysis.checkedAt = r.checkedAt || nowIso();

    // Covers: a recheck must not touch a cover that is already there, and any other visit only
    // replaces it with something at least half as detailed.
    if (cover && !(job.kind === 'recheck' && previous?.coverBytes)) {
      const saved = saveCover(paths, id, cover);
      analysis.coverBytes = saved.bytes;
      analysis.coverNote = saved.note ?? r.coverNote ?? null;
    } else {
      analysis.coverBytes = previous?.coverBytes ?? null;
      analysis.coverNote = previous?.coverNote ?? null;
    }
    if (embedShot) saveEmbedShot(paths, id, embedShot);
    analysis.hasEmbedShot = Boolean(embedShot) || (job.kind === 'recheck' && previous?.hasEmbedShot);

    const notes = [];
    if (job.kind === 'recheck' && previous?.embed?.ok && analysis.embed && !analysis.embed.ok) {
      if (DEFINITE_EMBED_VERDICTS.has(analysis.embed.reason)) notes.push(`不能再嵌入了（${analysis.embed.reason}），试玩会打不开`);
      else {
        // Probably just a slow visit: keep believing the earlier verdict, but say so.
        notes.push(`这次嵌入测试没通过（${analysis.embed.reason}），原因不明，先按之前的结果处理`);
        analysis.embed = previous.embed;
      }
    }
    if (job.kind === 'recheck' && previous?.reach === 'ok' && analysis.reach === 'slow') notes.push('从服务器访问变慢了');
    store.saveAnalysis(id, analysis);
    store.finishJob(jobId);

    if (c.origin !== 'hn' && c.origin !== 'seed' && analysis.meta?.title) store.setTitle(id, analysis.meta.title);
    if (['queued', 'analyzing', 'failed'].includes(c.state)) store.setState(id, 'pending_review', notes.join('；') || null);
    else store.setAttention(id, notes.join('；') || null);

    if (c.state === 'approved') publish();
    if (['queued', 'analyzing', 'failed'].includes(c.state)) {
      // Do not hold up the worker, or the response to it, for the model.
      draft(id).catch((e) => log(`draft failed for ${id}: ${e.message}`));
    }
    return { ok: true };
  }

  // ---- the reviewer's side ----------------------------------------------------------------

  const need = (id) => {
    const c = store.get(id);
    if (!c) throw new UserError('not_found', '没有这个作品', 404);
    return c;
  };

  function approve(id, fields = {}) {
    const c = need(id);
    if (c.analysis?.ok !== true) throw new UserError('not_checked', '这个作品还没有通过体检，不能上线');
    const patch = cleanListing(fields);
    const merged = { ...(c.curation ?? {}), ...patch };
    if (!CATEGORY_IDS.includes(merged.category)) throw new UserError('category', '请选择一个分类');
    if (!merged.name) throw new UserError('name', '请填写作品名');
    if (!merged.blurb) throw new UserError('blurb', '请填写一句中文介绍');
    store.saveCuration(id, { ...patch, reason: null, decidedAt: nowIso() });
    store.setState(id, 'approved', null);
    return { published: publish() };
  }

  function reject(id, reason) {
    const c = need(id);
    store.saveCuration(id, { reason: text(reason, 200) || '不合适', decidedAt: nowIso() });
    store.setState(id, 'rejected', null);
    if (c.state === 'approved') publish();
  }

  function unpublish(id) {
    const c = need(id);
    if (c.state !== 'approved') throw new UserError('not_live', '这个作品没有上线');
    store.setState(id, 'hidden', null);
    return { published: publish() };
  }

  // A reviewer edits a listing without deciding anything.
  function edit(id, fields) {
    const c = need(id);
    store.saveCuration(id, cleanListing(fields));
    if (c.state === 'approved') {
      const merged = store.get(id).curation;
      if (!merged.name || !merged.blurb || !CATEGORY_IDS.includes(merged.category)) {
        throw new UserError('incomplete', '已上线的作品必须有分类、名称和介绍');
      }
      publish();
    }
  }

  // Check a candidate again. `lateMs` waits that long before the last screenshot, for slow works.
  function reanalyze(id, { lateMs = 0 } = {}) {
    const c = need(id);
    store.enqueue(id, 'analyze', { priority: 0, lateMs: Math.min(Math.max(0, Number(lateMs) || 0), 120000) });
    if (c.state === 'failed') store.setState(id, 'queued', null);
  }

  async function addUrls(urls, origin = 'admin') {
    const out = [];
    for (const url of urls.slice(0, 50)) {
      try {
        out.push({ url, ...(await submit({ url, origin })) });
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        out.push({ url, error: e.message });
      }
    }
    return out;
  }

  // Weekly: look at every live work again, spread out so the small server is not hammered.
  function enqueueRechecks() {
    const ids = store.idsByState('approved');
    ids.forEach((id, i) => store.enqueue(id, 'recheck', { priority: 2, runAfter: minutesFromNow(i * 3) }));
    return ids.length;
  }

  function stats() {
    return {
      counts: store.counts(),
      queued: store.queueLength(),
      running: store.runningJobs(),
      workerSeen: store.kvGet('worker_seen'),
      lastDiscover: store.kvGet('last_discover'),
      lastRecheck: store.kvGet('last_recheck'),
      lastBackup: store.kvGet('last_backup'),
      aiEnabled: llm.enabled,
    };
  }

  return { submit, checkQuota, claim, handleResult, draft, approve, reject, unpublish, edit, reanalyze, addUrls, enqueueRechecks, stats, publish };
}
