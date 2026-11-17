// Find new candidates: recent Show HN posts that link to something a visitor can open and try.
// The Algolia search API behind hn.algolia.com is reachable from the server in China; the
// news.ycombinator.com site itself is not, which does not matter because we only store the link.

import { OWN_HOST, SKIP_HOST, SKIP_PATH } from '../shared/rules.mjs';
import { normalizeUrl } from '../shared/url.mjs';
import { nowIso } from './store.mjs';

export function createDiscover({ store, config, log = console.log, fetchImpl = fetch }) {
  async function fetchHits({ days, minPoints }) {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const hits = [];
    for (let page = 0; page < 10; page++) {
      const api = new URL('https://hn.algolia.com/api/v1/search');
      api.searchParams.set('tags', 'show_hn');
      api.searchParams.set('numericFilters', `created_at_i>${since},points>=${minPoints}`);
      api.searchParams.set('hitsPerPage', '100');
      api.searchParams.set('page', String(page));
      const res = await fetchImpl(api, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HN API ${res.status}`);
      const data = await res.json();
      hits.push(...data.hits);
      if (page + 1 >= data.nbPages) break;
    }
    return hits;
  }

  async function run(options = {}) {
    const { days, minPoints, limit } = { ...config.discover, ...options };
    store.kvSet('last_discover_try', nowIso());
    const hits = await fetchHits({ days, minPoints });
    const stats = { fetched: hits.length, noUrl: 0, skipped: 0, duplicate: 0, added: 0 };

    const usable = [];
    for (const h of hits) {
      if (!h.url) {
        stats.noUrl++;
        continue;
      }
      let url;
      try {
        url = normalizeUrl(h.url);
      } catch {
        stats.skipped++;
        continue;
      }
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol) || SKIP_HOST.test(u.hostname) || OWN_HOST.test(u.hostname) || SKIP_PATH.test(u.pathname)) {
        stats.skipped++;
        continue;
      }
      usable.push({ url, hit: h });
    }
    usable.sort((a, b) => b.hit.points - a.hit.points);

    for (const { url, hit } of usable) {
      if (stats.added >= limit) break;
      const added = store.addCandidate({
        url,
        title: hit.title.replace(/^Show HN:\s*/i, '').trim(),
        origin: 'hn',
        source: {
          type: 'hn',
          id: hit.objectID,
          link: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          points: hit.points,
          author: hit.author,
          postedAt: hit.created_at,
        },
      });
      if (!added.created) {
        stats.duplicate++;
        continue;
      }
      store.enqueue(added.id, 'analyze', { priority: 1 });
      stats.added++;
    }
    store.kvSet('last_discover', nowIso());
    log(`discover: ${JSON.stringify(stats)}`);
    return stats;
  }

  return { run };
}
