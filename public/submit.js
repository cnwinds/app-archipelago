// The submission page: send an address, then follow it through checking and review.
// Everything shown comes from our own api; text is only ever put in with textContent.

const $ = (s) => document.querySelector(s);
const form = $('#form');
const urlEl = $('#url');
const noteEl = $('#note');
const hpEl = $('#hp');
const goEl = $('#go');
const result = $('#result');
const titleEl = $('#result-title');
const bodyEl = $('#result-body');
const actionsEl = $('#result-actions');
const steps = [...document.querySelectorAll('#steps li')];

const POLL_MS = 3000;
const POLL_LIMIT = 100; // about five minutes, then we stop asking and say where to look later
let pollTimer = null;
let polls = 0;

function setSteps(now, allDone = false) {
  steps.forEach((li, i) => {
    li.className = allDone || i < now ? 'done' : i === now ? 'now' : '';
  });
}

function paragraphs(lines) {
  bodyEl.replaceChildren(
    ...lines.filter(Boolean).map((t) => {
      const p = document.createElement('p');
      p.textContent = t;
      return p;
    }),
  );
}

function actions(list) {
  actionsEl.replaceChildren(
    ...list.map(({ text, href, main, onClick }) => {
      const el = document.createElement(href ? 'a' : 'button');
      el.textContent = text;
      if (href) el.href = href;
      else el.type = 'button';
      if (main) el.className = 'main';
      if (onClick) el.addEventListener('click', onClick);
      return el;
    }),
  );
}

// kind: 'wait' | 'good' | 'bad' | 'info'
function render({ kind, step, title, lines = [], buttons = [], done = false }) {
  result.hidden = false;
  result.dataset.kind = kind;
  setSteps(step, done);
  titleEl.textContent = title;
  paragraphs(lines);
  actions(buttons);
}

function again() {
  clearTimeout(pollTimer);
  result.hidden = true;
  form.reset();
  setBusy(false);
  history.replaceState(null, '', location.pathname);
  urlEl.focus();
}
const againButton = { text: '再投一个', onClick: again };

function setBusy(busy) {
  goEl.disabled = busy;
  urlEl.disabled = busy;
  noteEl.disabled = busy;
}

function factLines(s) {
  const f = s.facts;
  if (!f) return [];
  const lines = [];
  if (s.title) lines.push(`页面标题：${s.title}`);
  lines.push(f.embeddable ? '可以直接在群岛里试玩。' : '这个作品不能在群岛内直接运行，会在新标签页打开。');
  if (f.slow) lines.push('从国内访问加载偏慢，上线后会提醒访客多等一会儿。');
  return lines;
}

function showState(s, id, created = true) {
  switch (s.state) {
    case 'checking':
      render({
        kind: 'wait',
        step: 1,
        title: '正在打开页面检查…',
        lines: ['浏览器正在替你访问这个网址并截图，通常要二三十秒，慢的站点可能要一两分钟。可以留在这里等，也可以先离开，稍后再来看。'],
      });
      return false;
    case 'review':
      render({
        kind: 'wait',
        step: 2,
        title: created ? '检查通过，等待人工审核' : '这个作品已经在审核队列里了',
        lines: [...factLines(s), '审核通过后它会出现在群岛上。可以收藏这个页面，稍后回来看进度。'],
        buttons: [againButton],
      });
      return true;
    case 'live':
      render({
        kind: 'good',
        step: 2,
        done: true,
        title: created ? '已收录，它已经登上群岛' : '这个作品已经在群岛上了',
        lines: s.title ? [`页面标题：${s.title}`] : [],
        buttons: [{ text: '去群岛里看看', href: `/#/app/${encodeURIComponent(id)}`, main: true }, againButton],
      });
      return true;
    case 'declined':
      render({
        kind: 'bad',
        step: 2,
        title: created ? '这次没有收录' : '这个作品之前看过，暂时没有收录',
        lines: ['它可能需要下载或注册，不是一个能直接使用的网页，或者不太适合放在这里。谢谢你的推荐，欢迎继续投稿别的作品。'],
        buttons: [againButton],
      });
      return true;
    case 'failed':
      render({
        kind: 'bad',
        step: 1,
        title: '没能打开这个网址',
        lines: ['浏览器在检查时没能正常打开它：可能是网站暂时访问不了、需要登录，或者拒绝了自动访问。请确认网址能直接在浏览器里打开，稍后再试。'],
        buttons: [againButton],
      });
      return true;
    default:
      return true;
  }
}

async function poll(id) {
  clearTimeout(pollTimer);
  polls += 1;
  try {
    const res = await fetch(`/api/submissions/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.status === 404) {
      // Not something this page can follow (it came in another way); it is in the system though.
      render({ kind: 'info', step: 1, title: '已收到', lines: ['这个作品已经在我们的清单里了，不需要再投。'], buttons: [againButton] });
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const s = await res.json();
    if (showState(s, id)) {
      setBusy(false);
      return;
    }
  } catch {
    // A network blip: keep trying quietly, up to the limit.
  }
  if (polls >= POLL_LIMIT) {
    render({
      kind: 'info',
      step: 1,
      title: '检查排队的时间比平时长',
      lines: ['不用一直等。这个页面的地址已经记住了这次投稿，稍后再打开它就能看到进度。'],
      buttons: [againButton],
    });
    setBusy(false);
    return;
  }
  pollTimer = setTimeout(() => poll(id), POLL_MS);
}

function track(id) {
  polls = 0;
  history.replaceState(null, '', `#${id}`);
  poll(id);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlEl.value.trim();
  if (!url) {
    urlEl.focus();
    render({ kind: 'bad', step: 0, title: '请先填写作品的网址', lines: [] });
    return;
  }
  setBusy(true);
  render({ kind: 'wait', step: 0, title: '正在提交…', lines: [] });
  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, note: noteEl.value.trim(), hp: hpEl.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || '提交失败了，请稍后再试';
      render({ kind: 'bad', step: 0, title: message, lines: [], buttons: [] });
      setBusy(false);
      urlEl.focus();
      return;
    }
    if (!data.id) {
      // The hidden field was filled in, so this was a bot: look the same as a success.
      render({ kind: 'wait', step: 1, title: '正在打开页面检查…', lines: [] });
      return;
    }
    if (data.created) {
      track(data.id);
      return;
    }
    // Already known. Say what became of it; follow it only if it is still in progress.
    history.replaceState(null, '', `#${data.id}`);
    const done = showState({ state: data.state, title: null, facts: null }, data.id, false);
    if (!done) track(data.id);
    else setBusy(false);
  } catch {
    render({ kind: 'bad', step: 0, title: '网络不太稳定，没能提交出去', lines: ['请检查网络后再试一次。'] });
    setBusy(false);
  }
});

// Coming back to a submission: the address carries its id.
const m = /^#([a-z0-9-]{1,60})$/.exec(location.hash);
if (m) {
  setBusy(true);
  track(m[1]);
}
