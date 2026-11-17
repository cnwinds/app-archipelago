// Screenshots and the published catalog on disk.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scoreFromSource } from '../shared/rules.mjs';

export const coverFile = (paths, id) => join(paths.shots, `${id}.webp`);
export const embedFile = (paths, id) => join(paths.shots, `${id}.embed.webp`);

// Write through a temporary file so a reader never sees half an image or half a json.
export function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// A re-check on a slow day must not replace a good cover with a loading screen. File size
// stands in for detail. Returns what happened, for the note shown to the reviewer.
export function saveCover(paths, id, buffer) {
  mkdirSync(paths.shots, { recursive: true });
  const file = coverFile(paths, id);
  const previous = existsSync(file) ? statSync(file).size : 0;
  if (buffer.length >= previous * 0.5) {
    writeAtomic(file, buffer);
    return { bytes: buffer.length, note: null };
  }
  return { bytes: previous, note: `kept the previous cover: the new capture had ${Math.round((buffer.length / previous) * 100)}% of its detail` };
}

export function saveEmbedShot(paths, id, buffer) {
  mkdirSync(paths.shots, { recursive: true });
  writeAtomic(embedFile(paths, id), buffer);
}

const shortHash = (buffer) => createHash('sha1').update(buffer).digest('hex').slice(0, 8);

// Rebuild what the site loads from the database: published.json plus the covers of the
// approved works. The site fetches these at runtime, so approving a work needs no rebuild.
export function writePublished(store, paths) {
  const items = [];
  const covers = new Map();
  for (const id of store.idsByState('approved')) {
    const c = store.get(id);
    const a = c.analysis;
    const u = c.curation;
    if (!a?.ok || !u?.name || !u?.blurb || !u?.category) continue;
    const file = coverFile(paths, id);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    covers.set(`${id}.webp`, bytes);
    items.push({
      id,
      name: u.name,
      url: a.finalUrl || c.url,
      category: u.category,
      tags: u.tags ?? [],
      blurb: u.blurb,
      score: u.score ?? scoreFromSource(c.source),
      author: c.source?.author ?? a.meta?.author ?? null,
      // Only a real posting date counts. Hand-added works have none and must not look new.
      postedAt: c.source?.postedAt ?? null,
      // A reviewer can force a new tab with embedOverride=false, e.g. for works that need the
      // microphone or camera, which our sandboxed iframe does not hand out.
      embed: !!a.embed?.ok && u.embedOverride !== false,
      // How it felt to load from here (the server is in China, like most visitors).
      reach: a.reach ?? null,
      shot: `${id}.webp`,
      shotV: shortHash(bytes),
      source: c.source ? { type: c.source.type, link: c.source.link, points: c.source.points } : null,
    });
  }
  items.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));

  mkdirSync(paths.publicShots, { recursive: true });
  for (const name of readdirSync(paths.publicShots)) if (!covers.has(name)) rmSync(join(paths.publicShots, name), { force: true });
  for (const [name, bytes] of covers) {
    const target = join(paths.publicShots, name);
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) writeAtomic(target, bytes);
  }
  writeAtomic(paths.published, JSON.stringify(items, null, 1) + '\n');
  return { count: items.length, embeddable: items.filter((i) => i.embed).length };
}
