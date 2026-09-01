// Verification for the concrete source fetchers - exits non-zero on any
// failure. Run: npm run check-sources
//
// Grows one section per source PR. Each source gets: a golden diff against
// its REAL captured fixture, hard hand-checked assertions independent of
// the golden, and unit checks for its URL discovery. No network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

process.env.BETSHEET_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-sourcescheck-'));

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'sources');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

function firstDiff(a, b, at = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  }
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
    const d = firstDiff(a[k], b[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

// ===================== Sports from the Basement =====================

const { default: sftb, slugFor } = await import('../server/fetchers/sftb.js');

console.log('-- Sports from the Basement --');

const html = fs.readFileSync(path.join(FIXTURES, 'sftb-delmar-2026-08-30.html'), 'utf8');
const out = sftb.parse(html);

const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sftb-delmar-2026-08-30.expected.json'), 'utf8'));
const diff = firstDiff(out, golden);
check('golden: sftb-delmar-2026-08-30.html', !diff, diff ?? '');

check('page track and date read from the post title',
  out.track === 'Del Mar' && out.date === '2026-08-30');
check('10 races, zero warnings on the real post',
  out.races.length === 10 && out.warnings.length === 0, JSON.stringify(out.warnings));

// Hand-checked against the rendered post.
const r1 = out.races[0];
check('R1: expected order 1,3,2,5,6,4 with top/second/third mapped', (() => {
  const full = JSON.parse(r1.picks[0].note).fullOrder;
  return full.map((f) => f.programNumber).join(',') === '1,3,2,5,6,4' &&
    r1.picks.map((p) => `${p.pickType}#${p.programNumber}`).join(',') === 'top#1,second#3,third#2';
})());
check('R1: note carries rank/expected/value', (() => {
  const n = JSON.parse(r1.picks[0].note);
  return n.rank === 1 && n.expected === 1 && n.value === '2-1';
})());
check('pick names match the program card (Howie\'s Law, Chiseled in Stone, Rabeeba rank 1)',
  r1.picks[0].horseName === "Howie's Law" &&
  out.races[1].picks[0].horseName === 'Chiseled in Stone' &&
  out.races[6].picks[0].horseName === 'Rabeeba');

// The post marks scratches with a 5-cell SCRATCH row; those horses must be
// absent from picks AND from the full order.
check('scratched rows excluded everywhere', (() => {
  const all = out.races.flatMap((r) => [
    ...r.picks.map((p) => p.horseName),
    ...JSON.parse(r.picks[0].note).fullOrder.map((f) => f.horseName),
  ]);
  return !all.includes('Vern Gosdin') && !all.includes('The Chosen Bride') &&
    !all.includes('First Light') && !all.includes('Single Track Mind (IRE)');
})());
check('full order sizes reflect the scratches',
  JSON.stringify(out.races.map((r) => JSON.parse(r.picks[0].note).fullOrder.length)) ===
  '[6,9,9,8,10,11,7,9,9,12]');

// URL discovery.
check('slugFor builds the post slug (weekday computed from the date)',
  slugFor('Del Mar', '2026-08-30') === 'del-mar-horse-racing-picks-for-sunday-august-30-2026' &&
  slugFor('Santa Anita', '2026-01-10') === 'santa-anita-horse-racing-picks-for-saturday-january-10-2026');

{
  const fetched = [];
  const stubFetch = (bodies) => async (url) => {
    fetched.push(url);
    if (!(url in bodies)) throw new Error(`HTTP 404 for ${url}`);
    return bodies[url];
  };
  const index = '<x><loc>https://s/sitemap-2.xml</loc><loc>https://s/sitemap-33.xml</loc><loc>https://s/sitemap-34.xml</loc></x>';
  const hitUrl = 'https://s/2026/08/28/del-mar-horse-racing-picks-for-sunday-august-30-2026/';

  const found = await sftb.resolveUrl({ track: 'Del Mar', date: '2026-08-30' }, {
    fetchText: stubFetch({
      'https://www.sportsfromthebasement.com/sitemap-index-1.xml': index,
      'https://s/sitemap-34.xml': '<x><loc>https://s/other-post/</loc></x>',
      'https://s/sitemap-33.xml': `<x><loc>${hitUrl}</loc></x>`,
    }),
  });
  check('resolveUrl scans newest sitemaps first and finds the post',
    found === hitUrl && fetched[1] === 'https://s/sitemap-34.xml' && fetched[2] === 'https://s/sitemap-33.xml');

  const none = await sftb.resolveUrl({ track: 'Del Mar', date: '2026-09-03' }, {
    fetchText: stubFetch({
      'https://www.sportsfromthebasement.com/sitemap-index-1.xml': index,
      'https://s/sitemap-34.xml': '<x></x>', 'https://s/sitemap-33.xml': '<x></x>', 'https://s/sitemap-2.xml': '<x></x>',
    }),
  });
  check('resolveUrl returns null when no post exists for the date', none === null);
}

check('garbage html: warnings, never a throw', (() => {
  const g = sftb.parse('<html><title>nope</title>no races here</html>');
  return g.races.length === 0 && g.warnings.some((w) => w.type === 'no_races');
})());

if (failures) {
  console.error(`\ncheck-sources: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-sources: all checks passed');
