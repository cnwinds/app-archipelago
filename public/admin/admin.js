// The review desk. Plain browser code, no framework, no build step.
//
// Everything that came from outside (page titles, descriptions, the AI draft, a visitor's note)
// is put on the page with textContent, never as HTML: the review page runs with the reviewer's
// password, so a hostile page title must not be able to run anything here. nginx also serves
// this page with a CSP that forbids inline script and style.

const CATEGORIES = [
  ['game', '游戏'],
  ['ai', 'AI 工具'],
  ['creative', '创意艺术'],
  ['productivity', '效率工具'],
  ['music', '音乐音频'],
  ['edu', '教育学习'],
];

const TABS = [
  { id: 'pending', label: '待审核', states: ['pending_review'], count: (c) => c.pending_review, alert: true },
  { id: 'checking', label: '检查中', states: ['queued', 'analyzing'], count: (c) => c.queued + c.analyzing },
  { id: 'failed', label: '失败', states: ['failed'], count: (c) => c.failed },
  { id: 'live', label: '已上线', states: ['approved'], count: (c) => c.approved, order: 'name' },
  { id: 'declined', label: '已拒绝 / 下架', states: ['rejected', 'hidden'], count: (c) => c.rejected + c.hidden, order: 'recent' },
];

const STATE_LABEL = { queued: '排队中', analyzing: '检查中', failed: '检查失败', pending_review: '待审核', approved: '已上线', rejected: '已拒绝', hidden: '已下架' };
const FLAG_LABEL = { needs_download: '需下载', needs_signup: '需注册', adult: '成人内容', gambling: '赌博', phishing: '疑似钓鱼', not_an_app: '不是作品', broken: '已损坏' };
const ERROR_KIND = { network: '网络不通或超时', blocked: '被网站拦截（403/429）', http: '返回了错误页', cert: '证书有问题', other: '其他错误' };
const EMBED_REASON = {
  'x-frame-options': '网站禁止被嵌入（X-Frame-Options）',
  'csp-frame-ancestors': '网站禁止被嵌入（CSP）',
  'mixed-content': '是 http 页面，不能嵌进 https',
  'needs-cross-origin-isolation': '需要跨源隔离，嵌入后跑不起来',
  timeout: '嵌入后一直没加载完',
  blocked: '嵌入时被浏览器拦截',
};
const REJECT_PRESETS = ['需要下载或安装', '需要注册登录才能用', '打不开或经常打不开', '内容太少', '不是能直接用的作品', '和已有作品重复', '不合适'];
const BLURB_SOFT_LIMIT = 100;

const $ = (selector, root = document) => root.querySelector(selector);

// h('div', { class: 'x', onclick }, child, [children], 'text')
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

// Addresses come from pages we visited: only ever link to web addresses.
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');

function ago(iso) {
  if (!iso) return '从未';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
const when = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};
const titleOf = (c) => c.curation?.name || c.analysis?.meta?.title || c.title || c.id;
const originLabel = (c) => ({ hn: c.source?.points ? `HN ${c.source.points} 分` : 'HN', submit: '访客投稿', admin: '手动添加', seed: '经典作品' })[c.origin] ?? c.origin;

/* ------------------------------------------------------------------ api ---- */

async function api(method, path, body) {
  const get = method === 'GET';
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: get ? {} : { 'content-type': 'application/json' },
    body: get ? undefined : JSON.stringify(body ?? {}),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `请求失败（${res.status}）`);
  return data;
}

let toastTimer;
function toast(text, bad = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), bad ? 6000 : 3000);
}

/* ---------------------------------------------------------------- state ---- */

const S = {
  tab: 'pending',
  items: [],
  total: 0,
  sel: null,
  checked: new Set(),
  counts: {},
  stats: null,
  q: '',
  busy: false,
  dirty: false,
};
const tabDef = () => TABS.find((t) => t.id === S.tab);
const current = () => S.items.find((c) => c.id === S.sel) ?? null;
const narrow = () => window.matchMedia('(max-width: 900px)').matches;
let listSeq = 0;

// Run one action at a time; a second keypress while the first is in flight does nothing.
async function act(fn) {
  if (S.busy) return;
  S.busy = true;
  document.body.classList.add('busy');
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.busy = false;
    document.body.classList.remove('busy');
  }
}

/* ----------------------------------------------------------------- tabs ---- */

function renderTabs() {
  $('#tabs').replaceChildren(
    ...TABS.map((t, i) => {
      const n = t.count(S.counts);
      return h(
        'button',
        {
          class: `tab${t.alert && n > 0 ? ' alert' : ''}`,
          type: 'button',
          role: 'tab',
          title: `快捷键 ${i + 1}`,
          'aria-selected': t.id === S.tab ? 'true' : 'false',
          onclick: () => switchTab(t.id),
        },
        t.label,
        h('i', { text: String(n) }),
      );
    }),
  );
}

// Leaving with an unsaved edit on screen would lose it.
const okToLeave = () => !S.dirty || confirm('这个作品的修改还没有保存，确定离开吗？');

async function switchTab(id) {
  if (S.tab === id && !S.q) return;
  if (!okToLeave()) return;
  S.tab = id;
  S.sel = null;
  S.checked.clear();
  renderTabs();
  await loadList();
}

async function loadStats() {
  try {
    S.stats = await api('GET', '/stats');
    S.counts = S.stats.counts;
  } catch {
    S.stats = null;
  }
  renderTabs();
  renderHealth();
}

function renderHealth() {
  const el = $('#health');
  const st = S.stats;
  if (!st) {
    el.className = 'health off';
    el.textContent = '连不上服务';
    return;
  }
  const seen = st.workerSeen ? Date.now() - Date.parse(st.workerSeen) : Infinity;
  const online = seen < 90000;
  el.className = `health${online ? '' : ' off'}`;
  const parts = [online ? '检查器在线' : st.workerSeen ? `检查器离线（最后在线 ${ago(st.workerSeen)}）` : '检查器从未连接'];
  if (st.queued || st.running) parts.push(`队列 ${st.queued}，进行中 ${st.running}`);
  parts.push(st.aiEnabled ? 'AI 起草已开' : 'AI 未配置');
  el.textContent = parts.join(' · ');
  el.title = `上次自动发现：${ago(st.lastDiscover)}；上次备份：${ago(st.lastBackup)}；上次复查：${ago(st.lastRecheck)}`;
}

/* ----------------------------------------------------------------- list ---- */

async function loadList({ append = false, silent = false } = {}) {
  const tab = tabDef();
  const seq = ++listSeq;
  const limit = append ? 50 : silent ? Math.min(200, Math.max(50, S.items.length)) : 50;
  const params = new URLSearchParams({ state: tab.states.join(','), limit: String(limit), offset: String(append ? S.items.length : 0), order: tab.order ?? 'review' });
  if (S.q) params.set('q', S.q);
  let data;
  try {
    data = await api('GET', `/candidates?${params}`);
  } catch (e) {
    if (!silent) toast(e.message, true);
    return;
  }
  if (seq !== listSeq) return; // a newer request has taken over

  const before = current();
  S.items = append ? [...S.items, ...data.items] : data.items;
  S.total = data.total;
  const ids = new Set(S.items.map((c) => c.id));
  S.checked = new Set([...S.checked].filter((id) => ids.has(id)));
  renderList();
  renderBulk();

  if (!ids.has(S.sel)) {
    S.sel = null;
    if (!silent && !narrow() && S.items.length) S.sel = S.items[0].id;
  }
  const now = current();
  const changed = !before || !now || before.id !== now.id || before.updatedAt !== now.updatedAt || before.analysis?.checkedAt !== now.analysis?.checkedAt;
  if (!silent || (changed && !S.dirty)) renderDetail();
  markCurrent();
}

function thumb(c) {
  const none = () => h('div', { class: 'thumb none', text: '无图' });
  if (!c.analysis?.ok) return none();
  const img = h('img', { class: 'thumb', loading: 'lazy', alt: '', src: `/api/admin/cover/${encodeURIComponent(c.id)}?v=${encodeURIComponent(c.analysis.checkedAt)}` });
  img.addEventListener('error', () => img.replaceWith(none()));
  return img;
}

function rowTags(c) {
  const a = c.analysis;
  const tags = [h('span', { class: 'tag', text: originLabel(c) })];
  if (a?.ok) {
    if (a.embed && !a.embed.ok) tags.push(h('span', { class: 'tag', text: '新标签页打开' }));
    if (a.reach === 'slow') tags.push(h('span', { class: 'tag gold', text: '加载慢' }));
    if (a.embed?.warnings?.length) tags.push(h('span', { class: 'tag gold', text: '有警告' }));
  }
  for (const f of c.curation?.ai?.flags ?? []) tags.push(h('span', { class: 'tag red', text: FLAG_LABEL[f] ?? f }));
  if (c.attention) tags.push(h('span', { class: 'tag gold', text: '需留意' }));
  if (c.state === 'hidden') tags.push(h('span', { class: 'tag', text: '已下架' }));
  return tags;
}

function rowEl(c) {
  const box = h('input', { type: 'checkbox', 'aria-label': '勾选', checked: S.checked.has(c.id) });
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => {
    if (box.checked) S.checked.add(c.id);
    else S.checked.delete(c.id);
    renderBulk();
  });
  const row = h(
    'li',
    { class: 'row', 'data-id': c.id, 'aria-current': 'false', onclick: () => select(c.id) },
    box,
    thumb(c),
    h('div', { class: 'row-main' }, h('span', { class: 'row-title', text: titleOf(c) }), h('div', { class: 'row-sub' }, h('span', { class: 'host', text: hostOf(c.url) }), rowTags(c))),
  );
  return row;
}

function renderList() {
  const list = $('#list');
  if (!S.items.length) {
    const text = S.q ? '没有找到匹配的作品。' : S.tab === 'pending' ? '没有待审核的作品了。' : '这里空空的。';
    list.replaceChildren(h('li', { class: 'empty', text }));
  } else {
    list.replaceChildren(...S.items.map(rowEl));
  }
  $('#count').textContent = S.total ? `${S.items.length} / ${S.total}` : '';
  $('#more').hidden = S.items.length >= S.total;
}

function markCurrent() {
  for (const row of $('#list').children) {
    const on = row.dataset.id === S.sel;
    row.setAttribute('aria-current', on ? 'true' : 'false');
    if (on) row.scrollIntoView({ block: 'nearest' });
  }
  // The address always names the tab and the work on screen, so a reload or a shared link lands there.
  const hash = S.sel ? `#${S.tab}/${S.sel}` : `#${S.tab}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function select(id) {
  if (id !== S.sel && !okToLeave()) return;
  S.sel = id;
  history.replaceState(null, '', `#${S.tab}/${id}`);
  renderDetail();
  markCurrent();
}

function move(delta) {
  if (!S.items.length) return;
  const i = S.items.findIndex((c) => c.id === S.sel);
  const next = S.items[Math.min(S.items.length - 1, Math.max(0, i + delta))];
  if (next && next.id !== S.sel) select(next.id);
}

/* ------------------------------------------------------------- bulk bar ---- */

function suggestedRejects() {
  return S.items.filter((c) => c.state === 'pending_review' && c.curation?.ai?.rejectReason);
}

function renderBulk() {
  const bar = $('#bulkbar');
  const picked = [...S.checked];
  const suggested = S.tab === 'pending' ? suggestedRejects() : [];
  if (!picked.length && !suggested.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  bar.hidden = false;
  const parts = [];
  if (picked.length) {
    const reason = h('input', { type: 'text', placeholder: '拒绝原因', maxlength: 100 });
    parts.push(
      h('span', { text: `已选 ${picked.length} 个` }),
      reason,
      h('button', { class: 'btn small danger', type: 'button', onclick: () => bulk('reject', reason.value) }, '批量拒绝'),
      h('button', { class: 'btn small', type: 'button', onclick: () => bulk('reanalyze') }, '重新检查'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { S.checked.clear(); renderList(); markCurrent(); renderBulk(); } }, '取消选择'),
    );
  } else {
    parts.push(h('button', { class: 'btn small', type: 'button', onclick: () => { S.items.forEach((c) => S.checked.add(c.id)); renderList(); markCurrent(); renderBulk(); } }, '全选当前列表'));
  }
  if (suggested.length) {
    parts.push(h('button', { class: 'btn small danger', type: 'button', onclick: rejectSuggested }, `按 AI 建议拒绝 ${suggested.length} 个`));
  }
  bar.replaceChildren(...parts);
}

function bulk(action, reason = '') {
  return act(async () => {
    const ids = [...S.checked];
    if (action === 'reject' && !confirm(`拒绝选中的 ${ids.length} 个作品？`)) return;
    await api('POST', '/bulk', { action, ids, reason });
    toast(action === 'reject' ? `已拒绝 ${ids.length} 个` : `已让 ${ids.length} 个重新排队检查`);
    S.checked.clear();
    await refreshAll();
  });
}

function rejectSuggested() {
  return act(async () => {
    const list = suggestedRejects().slice(0, 100);
    if (!confirm(`按 AI 给的理由拒绝这 ${list.length} 个作品？\n\n${list.slice(0, 8).map((c) => `· ${titleOf(c)}：${c.curation.ai.rejectReason}`).join('\n')}${list.length > 8 ? '\n…' : ''}`)) return;
    for (const c of list) await api('POST', `/candidates/${encodeURIComponent(c.id)}/reject`, { reason: c.curation.ai.rejectReason });
    toast(`已拒绝 ${list.length} 个`);
    await refreshAll();
  });
}

/* --------------------------------------------------------------- detail ---- */

function fact(label, value, cls) {
  return [h('dt', { text: label }), h('dd', { class: cls, text: value })];
}

function factsOf(c) {
  const a = c.analysis;
  const rows = [];
  if (a) {
    rows.push(...fact('体检时间', `${when(a.checkedAt)}（${ago(a.checkedAt)}）`));
    if (a.ok) {
      rows.push(...fact('加载', a.reach === 'slow' ? (a.loadMs == null ? '超过 45 秒还没加载完' : `${(a.loadMs / 1000).toFixed(1)} 秒，偏慢`) : `${((a.loadMs ?? 0) / 1000).toFixed(1)} 秒`, a.reach === 'slow' ? 'slowc' : 'good'));
      if (a.embed) rows.push(...fact('能否嵌入', a.embed.ok ? '可以，在群岛里直接试玩' : `不行：${EMBED_REASON[a.embed.reason] ?? a.embed.reason ?? '未知'}`, a.embed.ok ? 'good' : 'slowc'));
      rows.push(...fact('页面 JS 报错', String(a.jsErrors ?? 0), a.jsErrors ? 'slowc' : undefined));
      if (a.finalUrl && a.finalUrl !== c.url) rows.push(...fact('最终网址', a.finalUrl));
    } else {
      rows.push(...fact('结果', `${ERROR_KIND[a.errorKind] ?? '失败'}：${a.error ?? ''}`, 'badc'));
    }
  }
  if (c.source?.type === 'hn') {
    rows.push(...fact('Hacker News', `${c.source.points} 分${c.source.author ? ` · ${c.source.author}` : ''}${c.source.postedAt ? ` · ${when(c.source.postedAt)}` : ''}`));
  }
  rows.push(...fact('来源', originLabel(c) + ` · 加入于 ${when(c.createdAt)}`));
  rows.push(...fact('默认品质分', `${c.autoScore}（≥90 城堡，≥70 房屋）`));
  return rows;
}

function note(kind, ...kids) {
  return h('div', { class: `note${kind ? ' ' + kind : ''}` }, ...kids);
}

function renderDetail() {
  const box = $('#detail');
  S.dirty = false;
  const c = current();
  if (!c) {
    document.body.classList.remove('has-selection');
    box.replaceChildren(h('p', { class: 'blank', text: S.items.length ? '从左边选一个作品。' : '' }));
    return;
  }
  document.body.classList.add('has-selection');
  const a = c.analysis;
  const u = c.curation ?? {};
  const ai = u.ai;
  const ok = a?.ok === true;
  const live = c.state === 'approved';

  /* header */
  const head = [
    h('button', { class: 'btn small d-back', type: 'button', onclick: () => { S.sel = null; renderDetail(); markCurrent(); history.replaceState(null, '', `#${S.tab}`); } }, '← 返回列表'),
    h('h2', { text: titleOf(c) }),
    h('a', { class: 'd-url', href: safeUrl(c.url), target: '_blank', rel: 'noopener noreferrer', text: c.url }),
    h('div', { class: 'd-tags' }, h('span', { class: `tag ${live ? 'green' : c.state === 'rejected' || c.state === 'failed' ? 'red' : 'gold'}`, text: STATE_LABEL[c.state] ?? c.state }), rowTags(c).slice(0, 1)),
  ];

  /* notes */
  const notes = [];
  if (c.state === 'queued' || c.state === 'analyzing') {
    const j = c.job;
    notes.push(note('', h('b', { text: c.state === 'analyzing' ? '正在检查…' : '排队中。' }), j?.attempts ? ` 已经试过 ${j.attempts} 次，下次 ${Date.parse(j.runAfter) <= Date.now() ? '马上' : when(j.runAfter)}。` : ' 检查器会按顺序一个个来，通常几分钟内轮到。'));
  }
  if (c.attention) notes.push(note('warn', h('b', { text: '需留意：' }), c.attention));
  if (a && !ok) {
    notes.push(
      note('bad', h('b', { text: '没能打开：' }), `${ERROR_KIND[a.errorKind] ?? ''} ${a.error ?? ''}`, h('div', { class: 'row-actions' }, h('button', { class: 'btn small', type: 'button', onclick: () => reanalyze(0) }, '重新检查'))),
    );
  }
  if (ai?.rejectReason && c.state === 'pending_review') {
    notes.push(note('warn', h('b', { text: 'AI 建议拒绝：' }), ai.rejectReason, h('div', { class: 'row-actions' }, h('button', { class: 'btn small danger', type: 'button', onclick: () => openReject(ai.rejectReason) }, '按这个理由拒绝'))));
  }
  for (const w of a?.embed?.warnings ?? []) notes.push(note('warn', h('b', { text: '嵌入警告：' }), w));
  if (c.note) notes.push(note('', h('b', { text: '投稿人留言：' }), c.note));
  if (c.state === 'rejected' && u.reason) notes.push(note('', h('b', { text: '拒绝原因：' }), u.reason));

  /* screenshots */
  const shots = [];
  if (ok) {
    const v = encodeURIComponent(a.checkedAt);
    shots.push(h('figure', { class: 'shot' }, h('img', { alt: '封面', src: `/api/admin/cover/${encodeURIComponent(c.id)}?v=${v}` }), h('figcaption', { text: `封面（${a.coverBytes ? Math.round(a.coverBytes / 1024) + ' KB' : ''}）${a.coverNote ? ' · ' + a.coverNote : ''}` })));
    if (a.hasEmbedShot) shots.push(h('figure', { class: 'shot' }, h('img', { alt: '嵌入后的画面', src: `/api/admin/cover/${encodeURIComponent(c.id)}?kind=embed&v=${v}` }), h('figcaption', { text: '放进群岛 iframe 之后的样子' })));
  }

  /* page text */
  const meta = a?.meta;
  const page = meta && (meta.description || meta.text)
    ? h('details', { class: 'page' }, h('summary', { text: '页面自己说了什么' }), meta.title ? h('p', { text: `标题：${meta.title}` }) : null, meta.description ? h('p', { text: `描述：${meta.description}` }) : null, meta.text ? h('p', { text: meta.text }) : null)
    : null;

  /* edit form */
  const form = c.state === 'queued' || c.state === 'analyzing' ? null : buildForm(c, { ok, live, ai });

  $('#detail').replaceChildren(h('div', { class: 'd' }, ...head, ...notes, h('div', { class: 'shots' }, shots), h('dl', { class: 'facts' }, factsOf(c)), page, form));
  box.scrollTop = 0;
}

let formRefs = null;

function buildForm(c, { ok, live, ai }) {
  const u = c.curation ?? {};
  const category = h('select', { id: 'f-category' }, h('option', { value: '', text: '选择分类…' }), ...CATEGORIES.map(([id, name]) => h('option', { value: id, text: name, selected: u.category === id })));
  const name = h('input', { id: 'f-name', type: 'text', maxlength: 40, value: u.name ?? '', autocomplete: 'off' });
  const tags = h('input', { id: 'f-tags', type: 'text', value: (u.tags ?? []).join('，'), autocomplete: 'off', placeholder: '用逗号分开，最多 6 个' });
  const blurb = h('textarea', { id: 'f-blurb', maxlength: 200, placeholder: '一到两句中文，只写页面自己说了的内容' }, u.blurb ?? '');
  const count = h('span', { class: 'count' });
  const score = h('input', { id: 'f-score', type: 'number', min: 0, max: 100, step: 1, value: u.score ?? '', placeholder: `自动 ${c.autoScore}` });
  const embed = h('select', { id: 'f-embed' }, h('option', { value: 'auto', text: '按体检结果' }), h('option', { value: 'newtab', text: '一律新标签页打开（需要麦克风、摄像头的作品）', selected: u.embedOverride === false }));

  const updateCount = () => {
    const n = [...blurb.value].length;
    count.textContent = `${n}/${BLURB_SOFT_LIMIT}`;
    count.classList.toggle('over', n > BLURB_SOFT_LIMIT);
  };
  updateCount();
  for (const el of [category, name, tags, blurb, score, embed]) el.addEventListener('input', () => { S.dirty = true; });
  blurb.addEventListener('input', updateCount);

  formRefs = { category, name, tags, blurb, score, embed };

  const aiLine = h(
    'div',
    { class: 'ai-line' },
    ai ? `${ai.source === 'llm' ? `AI 起草（${ai.model ?? '模型'}，把握${{ high: '高', medium: '中', low: '低' }[ai.confidence] ?? '低'}）` : '没有可用的 AI，只填了页面标题'} · ${ago(ai.at)}` : S.stats?.aiEnabled ? '还没有 AI 草稿' : 'AI 起草没有配置，介绍请手写',
    S.stats?.aiEnabled && ok ? h('button', { class: 'btn small', type: 'button', onclick: redraft }, '重新起草') : null,
  );

  const buttons = [];
  if (live) {
    buttons.push(h('button', { class: 'btn primary', type: 'button', onclick: () => save() }, '保存修改（Ctrl+Enter）'));
  } else if (c.state !== 'failed') {
    buttons.push(h('button', { class: 'btn primary', type: 'button', disabled: !ok, title: ok ? '' : '没通过体检的作品不能上线', onclick: () => approve() }, c.state === 'pending_review' ? '通过并上线（A）' : '改为通过并上线'));
    buttons.push(h('button', { class: 'btn', type: 'button', onclick: () => save() }, '保存草稿'));
  }
  if (c.state !== 'rejected') buttons.push(h('button', { class: 'btn danger', type: 'button', onclick: () => openReject(ai?.rejectReason ?? '') }, '拒绝（R）'));
  buttons.push(h('span', { class: 'spacer' }));
  buttons.push(h('button', { class: 'btn', type: 'button', onclick: () => reanalyze(0) }, '重新检查'));
  buttons.push(h('button', { class: 'btn', type: 'button', title: '加载慢、截图还停在加载画面时用：多等 25 秒再拍封面', onclick: () => reanalyze(25000) }, '慢站重拍'));
  if (live) buttons.push(h('button', { class: 'btn danger', type: 'button', onclick: unpublish }, '下架'));

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'edit' },
      aiLine,
      h('div', null, h('label', { for: 'f-category', text: '分类' }), category),
      h('div', null, h('label', { for: 'f-name', text: '作品名' }), name),
      h('div', { class: 'full' }, h('label', { for: 'f-tags', text: '标签' }), tags),
      h('div', { class: 'full' }, h('label', { for: 'f-blurb' }, '中文介绍', count), blurb),
      h('div', null, h('label', { for: 'f-score' }, '品质分 ', h('small', { text: '留空则自动' })), score),
      h('div', null, h('label', { for: 'f-embed', text: '打开方式' }), embed),
    ),
    h('div', { class: 'actions', id: 'actions' }, buttons),
    h('div', { id: 'reject-slot' }),
  );
}

const readForm = () => {
  const f = formRefs;
  const out = { name: f.name.value, tags: f.tags.value, blurb: f.blurb.value, score: f.score.value === '' ? null : Number(f.score.value), embedOverride: f.embed.value === 'newtab' ? false : null };
  if (f.category.value) out.category = f.category.value;
  return out;
};

/* -------------------------------------------------------------- actions ---- */

// An item left the tab it was in: drop it and move on to its neighbour.
function leave(id) {
  const i = S.items.findIndex((c) => c.id === id);
  if (i < 0) return;
  S.items.splice(i, 1);
  S.total = Math.max(0, S.total - 1);
  S.checked.delete(id);
  S.sel = narrow() ? null : (S.items[Math.min(i, S.items.length - 1)]?.id ?? null);
  renderList();
  renderBulk();
  renderDetail();
  markCurrent();
  history.replaceState(null, '', S.sel ? `#${S.tab}/${S.sel}` : `#${S.tab}`);
}

// The server's version of an item that stayed where it was.
function replaceItem(updated) {
  const i = S.items.findIndex((c) => c.id === updated.id);
  if (i < 0) return;
  S.items[i] = updated;
  $('#list').children[i]?.replaceWith(rowEl(updated));
  markCurrent();
}

const post = (id, action, body) => api('POST', `/candidates/${encodeURIComponent(id)}/${action}`, body);

function approve() {
  const c = current();
  if (!c) return;
  return act(async () => {
    const updated = await post(c.id, 'approve', readForm());
    toast(`已上线：${updated.curation?.name ?? c.id}`);
    S.dirty = false;
    leave(c.id);
    loadStats();
  });
}

function save() {
  const c = current();
  if (!c) return;
  return act(async () => {
    const updated = await api('PATCH', `/candidates/${encodeURIComponent(c.id)}`, readForm());
    replaceItem(updated);
    S.dirty = false;
    toast(c.state === 'approved' ? '已保存，站点上已更新' : '草稿已保存');
  });
}

function unpublish() {
  const c = current();
  if (!c || !confirm(`把「${titleOf(c)}」从群岛上下架？`)) return;
  return act(async () => {
    await post(c.id, 'unpublish');
    toast('已下架');
    leave(c.id);
    loadStats();
  });
}

function reanalyze(lateMs) {
  const c = current();
  if (!c) return;
  return act(async () => {
    const updated = await post(c.id, 'reanalyze', { lateMs });
    toast(lateMs ? '已排队重新检查，这次会多等一会儿再截图' : '已排队重新检查');
    if (updated.state !== c.state) leave(c.id);
    else replaceItem(updated);
    loadStats();
  });
}

function redraft() {
  const c = current();
  if (!c || (S.dirty && !confirm('重新起草会覆盖还没保存的修改，继续吗？'))) return;
  return act(async () => {
    const updated = await post(c.id, 'redraft');
    S.items[S.items.findIndex((x) => x.id === c.id)] = updated;
    renderDetail();
    toast('已重新起草，只填入了你还没写的字段');
  });
}

function openReject(suggested = '') {
  const c = current();
  const slot = $('#reject-slot');
  if (!c || !slot) return;
  const existing = $('input', slot);
  if (existing) {
    existing.focus();
    return;
  }
  const reason = h('input', { type: 'text', maxlength: 100, value: suggested, placeholder: '拒绝原因（会留在记录里）' });
  const close = () => slot.replaceChildren();
  const confirmReject = () =>
    act(async () => {
      await post(c.id, 'reject', { reason: reason.value });
      toast(`已拒绝：${titleOf(c)}`);
      S.dirty = false;
      leave(c.id);
      loadStats();
    });
  reason.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmReject();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  slot.replaceChildren(
    h(
      'div',
      { class: 'reject-box' },
      reason,
      h('div', { class: 'chips' }, REJECT_PRESETS.map((t) => h('button', { type: 'button', onclick: () => { reason.value = t; reason.focus(); } }, t))),
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'button', onclick: confirmReject }, '确认拒绝（Enter）'), h('button', { class: 'btn', type: 'button', onclick: close }, '取消（Esc）')),
    ),
  );
  reason.focus();
  reason.select();
}

/* ------------------------------------------------------- add and discover ---- */

function setupAdd() {
  const panel = $('#add-panel');
  const urls = $('#add-urls');
  const out = $('#add-results');
  $('#btn-add').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) urls.focus();
  });
  $('#add-close').addEventListener('click', () => { panel.hidden = true; });
  $('#add-go').addEventListener('click', () =>
    act(async () => {
      if (!urls.value.trim()) return;
      const { results } = await api('POST', '/candidates', { urls: urls.value });
      out.replaceChildren(
        ...results.map((r) =>
          h('li', { class: r.error ? 'bad' : r.created ? 'ok' : '' }, `${r.url} — ${r.error ? r.error : r.created ? '已加入，马上开始检查' : `已经在清单里（${STATE_LABEL[r.state] ?? r.state}）`}`),
        ),
      );
      if (results.some((r) => r.created)) urls.value = '';
      toast(`加入了 ${results.filter((r) => r.created).length} 个`);
      await refreshAll();
    }),
  );
  $('#btn-discover').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    return act(async () => {
      try {
        const { stats } = await api('POST', '/discover');
        toast(`发现 ${stats.fetched} 条，新增 ${stats.added}，已有 ${stats.duplicate}，跳过 ${stats.skipped + stats.noUrl}`);
        await refreshAll();
      } finally {
        btn.disabled = false;
      }
    });
  });
}

/* --------------------------------------------------------------- startup ---- */

async function refreshAll() {
  await loadStats();
  await loadList({ silent: true });
}

function setupKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.altKey) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === 'Enter' && e.ctrlKey && $('#detail').contains(e.target)) {
      e.preventDefault();
      (current()?.state === 'approved' ? save : approve)();
      return;
    }
    if (e.key === 'Escape') {
      if (typing) e.target.blur();
      else $('#reject-slot')?.replaceChildren();
      return;
    }
    if (typing || e.ctrlKey || e.shiftKey) return;
    const c = current();
    switch (e.key.toLowerCase()) {
      case 'j': move(1); break;
      case 'k': move(-1); break;
      case 'a': if (c && c.state !== 'approved' && c.analysis?.ok) approve(); break;
      case 'r':
        if (c && c.state !== 'rejected') {
          e.preventDefault(); // the box takes focus now; without this the "r" would be typed into it
          openReject(c.curation?.ai?.rejectReason ?? '');
        }
        break;
      case 'e': $('#f-name')?.focus(); e.preventDefault(); break;
      case 'x': if (c) { const box = $(`.row[data-id="${CSS.escape(c.id)}"] input`); if (box) { box.checked = !box.checked; box.dispatchEvent(new Event('change')); } } break;
      case 'o': if (c) window.open(safeUrl(c.url), '_blank', 'noopener,noreferrer'); break;
      case '/': $('#q').focus(); e.preventDefault(); break;
      default: {
        const n = Number(e.key);
        if (n >= 1 && n <= TABS.length) switchTab(TABS[n - 1].id);
      }
    }
  });
}

async function start() {
  const m = /^#([a-z]+)(?:\/([a-z0-9-]+))?$/.exec(location.hash);
  if (m && TABS.some((t) => t.id === m[1])) S.tab = m[1];
  setupAdd();
  setupKeys();
  let timer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!okToLeave()) {
        e.target.value = S.q;
        return;
      }
      S.q = e.target.value.trim();
      S.sel = null;
      loadList();
    }, 300);
  });
  $('#more').addEventListener('click', () => loadList({ append: true }));
  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) e.preventDefault();
  });
  await loadStats();
  if (m?.[2]) S.sel = m[2];
  await loadList();
  // The checker and the scheduler work on their own: keep what is on screen fresh.
  setInterval(() => document.visibilityState === 'visible' && loadStats(), 15000);
  setInterval(() => document.visibilityState === 'visible' && !S.busy && ['pending', 'checking', 'failed'].includes(S.tab) && loadList({ silent: true }), 20000);
}

start();
