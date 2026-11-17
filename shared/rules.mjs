// What counts as "something a visitor can open and try", shared by discovery and submissions.

// Links that are never "open and try it": repos, stores, videos, documents, packages.
export const SKIP_HOST =
  /(^|\.)(github\.com|gitlab\.com|codeberg\.org|sr\.ht|youtube\.com|youtu\.be|apps\.apple\.com|play\.google\.com|chromewebstore\.google\.com|chrome\.google\.com|addons\.mozilla\.org|npmjs\.com|pypi\.org|crates\.io|arxiv\.org|medium\.com|substack\.com|twitter\.com|x\.com|docs\.google\.com|marketplace\.visualstudio\.com|testflight\.apple\.com|huggingface\.co|news\.ycombinator\.com)$/i;
export const SKIP_PATH = /\.(pdf|zip|dmg|exe|apk|mp4|tar\.gz)$|\/(blog|posts?|articles?|news)\//i;

// The site itself must never become one of its own works.
export const OWN_HOST = /(^|\.)isle\.ai-news\.top$/i;

export const CATEGORY_IDS = ['game', 'ai', 'creative', 'productivity', 'music', 'edu'];

// Initial quality score from the only real signal we have. The site shows >= 90 as a castle,
// >= 70 as a house, otherwise a hut. A reviewer can override it with an explicit score.
export function scoreFromSource(source) {
  if (source?.type === 'hn' && source.points > 0) return Math.round(Math.min(99, Math.max(40, 20 + 25.5 * Math.log10(source.points))));
  return 60;
}
