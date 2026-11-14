import published from '../catalog/published.json';

export function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `count` is filled in by loadApps() from the published catalog.
export const CATEGORIES = [
  { id: 'game', name: '游戏', title: '游戏火山岛', color: '#ff7a45', ground: '#7d9a46', pos: [-70, -20], theme: 'volcano', count: 0 },
  { id: 'ai', name: 'AI 工具', title: 'AI 水晶岛', color: '#3fd0e0', ground: '#5aa58a', pos: [55, -45], theme: 'crystal', count: 0 },
  { id: 'creative', name: '创意艺术', title: '创意花海岛', color: '#ff6f91', ground: '#9cc25a', pos: [10, 62], theme: 'garden', count: 0 },
  { id: 'productivity', name: '效率工具', title: '效率风车岛', color: '#f2b544', ground: '#a3a65a', pos: [98, 40], theme: 'windmill', count: 0 },
  { id: 'music', name: '音乐音频', title: '声波岛', color: '#9d8cff', ground: '#6c8f6a', pos: [-82, 72], theme: 'sound', count: 0 },
  { id: 'edu', name: '教育学习', title: '知识天文岛', color: '#6fd36f', ground: '#78ad5a', pos: [-18, -98], theme: 'observatory', count: 0 },
];

const NEW_WITHIN_DAYS = 3;

// Works come from catalog/published.json, which scripts/catalog/publish.mjs writes.
export function loadApps(now = Date.now()) {
  const cats = new Map(CATEGORIES.map((c) => [c.id, c]));
  const apps = [];
  for (const p of published) {
    const cat = cats.get(p.category);
    if (!cat) continue;
    // Works without a known posting date (added by hand) have no age and are never "new".
    const ageDays = p.postedAt ? Math.max(0, (now - Date.parse(p.postedAt)) / 86400000) : null;
    apps.push({
      id: p.id,
      name: p.name,
      cat,
      author: p.author,
      score: p.score,
      tier: p.score >= 90 ? 2 : p.score >= 70 ? 1 : 0,
      ageDays,
      isNew: ageDays !== null && ageDays < NEW_WITHIN_DAYS,
      tags: p.tags,
      desc: p.blurb,
      url: p.url,
      host: new URL(p.url).hostname.replace(/^www\./, ''),
      embed: p.embed,
      shot: `/catalog/shots/${p.shot}`,
      source: p.source,
      position: null,
    });
  }
  for (const c of CATEGORIES) c.count = apps.filter((a) => a.cat === c).length;
  return apps;
}
