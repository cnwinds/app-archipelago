// URL helpers shared by the api, the worker and the one-off migration.
// The same work must always map to the same id, so these must not change behaviour:
// ids already stored in the database were produced by these exact functions.

// Same work must always map to the same key, whatever tracking junk the link carries.
export function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|ref_|source$|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname === '') u.pathname = '/';
  return u.toString();
}

export function slugFor(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname.replace(/\/(index\.html?)?$/, '');
  return (host + path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
