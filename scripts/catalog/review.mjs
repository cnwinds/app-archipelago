// Render every draft with its screenshot and facts into one static page for review.
//
//   node scripts/catalog/review.mjs      -> catalog/review.html (open it in a browser)

import { writeFileSync } from 'node:fs';
import { PATHS, readJson } from './lib.mjs';

const sources = readJson(PATHS.sources, []);
const drafts = readJson(PATHS.drafts, {});
const curation = readJson(PATHS.curation, {});
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const cards = sources.map((s) => {
  const d = drafts[s.id];
  const c = curation[s.id];
  const state = !d ? 'not-ingested' : !d.ok ? 'unreachable' : !c ? 'pending' : c.status;
  const facts = !d
    ? ''
    : !d.ok
      ? esc(d.error)
      : `${d.loadMs ?? '>25000'} ms · 嵌入 ${d.embed.ok ? '可以' : '不行 (' + esc(d.embed.reason) + ')'} · JS 报错 ${d.jsErrors}` +
        (d.embed.warnings ? `<br>⚠ ${d.embed.warnings.map(esc).join('<br>⚠ ')}` : '');
  return `<article class="${state}">
    ${d?.shot ? `<img loading="lazy" src="shots/${d.shot}">` : '<div class="noshot">无截图</div>'}
    <h2><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></h2>
    <p class="id">${esc(s.id)} · ${s.source?.points ?? '-'} 分 · <b>${state}</b>${c?.category ? ' · ' + esc(c.category) : ''}</p>
    <p class="facts">${facts}</p>
    <p>${esc(c?.blurb || c?.reason || d?.meta?.description || d?.meta?.text?.slice(0, 160))}</p>
  </article>`;
});

writeFileSync(
  'catalog/review.html',
  `<!doctype html><meta charset="utf-8"><title>收录审核预览</title><style>
  body{margin:24px;background:#10151c;color:#e9e4da;font:14px/1.5 system-ui,sans-serif}
  main{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
  article{background:#18202a;border-radius:10px;overflow:hidden;padding-bottom:10px;border:2px solid transparent}
  article.approved{border-color:#3f9d5f} article.rejected{opacity:.55} article.unreachable{opacity:.4;border-color:#a6483f}
  img,.noshot{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;background:#0b0f14}
  .noshot{display:grid;place-items:center;color:#667}
  h2{font-size:15px;margin:10px 12px 2px} a{color:inherit} p{margin:2px 12px;color:#a9b0b8} .id{font-size:12px} .facts{font-size:12px;color:#7f8a96}
  </style><h1>收录审核预览 · ${sources.length} 个候选</h1><main>${cards.join('\n')}</main>`,
);
console.log(`catalog/review.html written (${sources.length} candidates)`);
