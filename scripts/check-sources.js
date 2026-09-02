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

const { default: sftb, slugFor, trackSlug, nearestSlug, slugOfUrl, SITEMAP_INDEX_URL } = await import('../server/fetchers/sftb.js');
const { recentFailures, trackKey } = await import('../server/consensus.js');
const { contrarianFlags } = await import('../shared/classification.js');
const { openDb } = await import('../server/db.js');

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

// ---------- the 2026-09-03 post: placeholder columns (D53) ----------
// The post exists (published 09/01 for the 09/03 card) but its ML /
// Expected / Value cells are placeholders (0.00 / 1 / 2-1). The parser
// takes only the ROW ORDER from each table; the placeholders ride the notes
// and nothing keys on them.
console.log('-- Sports from the Basement: 2026-09-03 (placeholder columns) --');
const html93 = fs.readFileSync(path.join(FIXTURES, 'sftb-delmar-2026-09-03.html'), 'utf8');
const out93 = sftb.parse(html93);
const golden93 = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sftb-delmar-2026-09-03.expected.json'), 'utf8'));
const diff93 = firstDiff(out93, golden93);
check('golden: sftb-delmar-2026-09-03.html', !diff93, diff93 ?? '');
check('9/3: track/date from the title, 8 races, zero warnings, same structure as the 8/30 fixture',
  out93.track === 'Del Mar' && out93.date === '2026-09-03' && out93.races.length === 8 && out93.warnings.length === 0 &&
  out93.races.every((r) => r.picks.length === 3 && r.picks.map((p) => p.pickType).join() === 'top,second,third' && JSON.parse(r.picks[0].note).fullOrder.length >= 3),
  JSON.stringify(out93.warnings));
const full93 = out93.races.flatMap((r) => JSON.parse(r.picks[0].note).fullOrder);
check('9/3: every row carries the placeholders (expected 1, value 2-1) and the post\'s ML column (0.00) is never stored',
  full93.length === 81 && full93.every((f) => f.expected === 1 && f.value === '2-1') && !full93.some((f) => 'ml' in f) &&
  JSON.stringify(out93.races.map((r) => JSON.parse(r.picks[0].note).fullOrder.length)) === '[5,9,14,9,8,14,10,12]');
check('9/3 R1: picks are the table ROW ORDER 4,1,2,5,3 (top #4 Bit\'s Tiger Magic) - not the identical placeholder scores',
  JSON.parse(out93.races[0].picks[0].note).fullOrder.map((f) => f.programNumber).join() === '4,1,2,5,3' &&
  out93.races[0].picks.map((p) => `${p.pickType}#${p.programNumber}`).join() === 'top#4,second#1,third#2' && out93.races[0].picks[0].horseName === "Bit's Tiger Magic");
// algo_fades_favorite reads the favorite from the race day's entries (the ML
// sheet), never from SFTB's column: with #3 the 6/5 favorite on the entries
// and SFTB ranking it 5th, the flag names #3 at 6/5 - the 0.00 placeholder
// never enters.
{
  const entries = [
    { program_number: '1', horse_name: 'Visually', morning_line: '15/1', morning_line_decimal: 15, scratched: 0 },
    { program_number: '2', horse_name: 'Tahini', morning_line: '5/2', morning_line_decimal: 2.5, scratched: 0 },
    { program_number: '3', horse_name: 'Saratoga Special (IRE)', morning_line: '6/5', morning_line_decimal: 1.2, scratched: 0 },
    { program_number: '4', horse_name: "Bit's Tiger Magic", morning_line: '8/5', morning_line_decimal: 1.6, scratched: 0 },
    { program_number: '5', horse_name: 'Certitude (FR)', morning_line: '3/1', morning_line_decimal: 3, scratched: 0 },
  ];
  const picks = out93.races[0].picks.map((p) => ({ source_name: 'SFTB', source_kind: 'algorithmic', pick_type: p.pickType, program_number: p.programNumber, horse_name: p.horseName, note: p.note }));
  const flags = contrarianFlags(entries, picks);
  const fade = flags.find((f) => f.type === 'algo_fades_favorite');
  check('algo_fades_favorite takes the favorite from the ENTRIES\' morning line (#3 at 6/5, ranked 5th by SFTB), not from the post\'s placeholder ML',
    fade && fade.programNumber === '3' && /6\/5/.test(fade.detail) && /#5/.test(fade.detail), JSON.stringify(flags));
  const entriesFav4 = entries.map((e) => ({ ...e, morning_line_decimal: e.program_number === '4' ? 0.8 : e.morning_line_decimal + 1 }));
  check('...and with #4 the favorite (SFTB\'s #1) there is no fade flag', !contrarianFlags(entriesFav4, picks).some((f) => f.type === 'algo_fades_favorite'));
}

// ---------- URL discovery (D53) ----------
console.log('-- Sports from the Basement: discovery --');
check('slugFor builds the post slug (weekday computed from the date)',
  slugFor('Del Mar', '2026-08-30') === 'del-mar-horse-racing-picks-for-sunday-august-30-2026' &&
  slugFor('Santa Anita', '2026-01-10') === 'santa-anita-horse-racing-picks-for-saturday-january-10-2026');
check('track spellings slug to the site\'s words: "Delmar" / "DEL MAR" / "Del Mar" / "DMR" -> del-mar (the D35 gap, normalized inside the fetcher for now)',
  ['Delmar', 'DEL MAR', 'Del Mar', 'DMR', ' del  mar '].every((t) => trackSlug(t) === 'del-mar') && trackSlug('Gulfstream') === 'gulfstream-park' && trackSlug('Unknown Downs') === 'unknown-downs');
check('the runner\'s track comparison is letters-only: Delmar == Del Mar == DEL MAR, != Santa Anita',
  trackKey('Delmar') === trackKey('Del Mar') && trackKey('DEL MAR') === trackKey('Del Mar') && trackKey('Santa Anita') !== trackKey('Del Mar'));
check('slugOfUrl: the last path segment, trailing slash or not',
  slugOfUrl('https://s/2026/09/01/del-mar-horse-racing-picks-for-thursday-september-3-2026/') === 'del-mar-horse-racing-picks-for-thursday-september-3-2026' &&
  slugOfUrl('https://s/2026/09/01/x') === 'x');
check('nearestSlug: same track wins over another track\'s post for the same date; ties go to the later entry; nothing shared -> null',
  nearestSlug(['remington-park-horse-racing-picks-for-thursday-september-3-2026', 'del-mar-horse-racing-picks-for-thursday-september-3-2026'], 'delmar-horse-racing-picks-for-thursday-september-3-2026') === 'del-mar-horse-racing-picks-for-thursday-september-3-2026' &&
  nearestSlug(['del-mar-horse-racing-picks-for-thursday-september-3-2026', 'del-mar-horse-racing-picks-for-friday-september-4-2026'], 'del-mar-horse-racing-picks-for-saturday-september-5-2026') === 'del-mar-horse-racing-picks-for-friday-september-4-2026' &&
  nearestSlug(['about-us', 'contact'], 'del-mar-horse-racing-picks-for-saturday-september-5-2026') === null);

{
  // Live-shaped fixtures: the real Jetpack index (newest three sitemaps +
  // an old one) and the real sitemap-34 page trimmed to late Aug / early
  // Sep 2026 - the 9/3 post sits there under its 09/01 PUBLISH date.
  const liveIndex = fs.readFileSync(path.join(FIXTURES, 'sftb-sitemap-index-1.xml'), 'utf8');
  const live34 = fs.readFileSync(path.join(FIXTURES, 'sftb-sitemap-34.xml'), 'utf8');
  const empty = '<?xml version="1.0"?><urlset></urlset>';
  const fetched = [];
  const stubFetch = (bodies) => async (url) => {
    fetched.push(url);
    if (!(url in bodies)) throw new Error(`HTTP 404 for ${url}`);
    if (typeof bodies[url] === 'number') throw new Error(`HTTP ${bodies[url]} for ${url}`);
    return bodies[url];
  };
  const liveBodies = {
    [SITEMAP_INDEX_URL]: liveIndex,
    'https://www.sportsfromthebasement.com/sitemap-34.xml': live34,
    'https://www.sportsfromthebasement.com/sitemap-33.xml': empty,
    'https://www.sportsfromthebasement.com/sitemap-32.xml': empty,
    'https://www.sportsfromthebasement.com/sitemap-2.xml': empty,
  };
  const realUrl = 'https://www.sportsfromthebasement.com/2026/09/01/del-mar-horse-racing-picks-for-thursday-september-3-2026/';

  const found = await sftb.resolveUrl({ track: 'Del Mar', date: '2026-09-03' }, { fetchText: stubFetch(liveBodies) });
  check('live-shaped sitemap: the 9/3 post, published two days before the race, is found for "Del Mar"; the newest sitemap is read first and named as sitemapUrl',
    found.url === realUrl && found.discovery.sitemapUrl === 'https://www.sportsfromthebasement.com/sitemap-34.xml' && found.discovery.sitemapStatus === 200 &&
    found.discovery.candidateSlug === 'del-mar-horse-racing-picks-for-thursday-september-3-2026' && found.discovery.entriesScanned === 22 &&
    fetched[0] === SITEMAP_INDEX_URL && fetched[1] === 'https://www.sportsfromthebasement.com/sitemap-34.xml' && fetched.length === 2,
    JSON.stringify(found));
  const foundDelmar = await sftb.resolveUrl({ track: 'Delmar', date: '2026-09-03' }, { fetchText: stubFetch(liveBodies) });
  check('the same post is found for a track spelled "Delmar" (the 2026-09-02 sandbox failure: the slug built "delmar-..." and the discovery missed)',
    foundDelmar.url === realUrl && foundDelmar.discovery.candidateSlug === found.discovery.candidateSlug);

  fetched.length = 0;
  const none = await sftb.resolveUrl({ track: 'Del Mar', date: '2026-09-05' }, { fetchText: stubFetch(liveBodies) });
  check('a date with no post: url null with the audit fields - the index as sitemapUrl, status 200, the candidate slug, every entry of the three newest sitemaps scanned, the nearest Del Mar slug',
    none.url === null && none.discovery.sitemapUrl === SITEMAP_INDEX_URL && none.discovery.sitemapStatus === 200 &&
    none.discovery.candidateSlug === 'del-mar-horse-racing-picks-for-saturday-september-5-2026' && none.discovery.entriesScanned === 22 &&
    none.discovery.nearestSlug === 'del-mar-horse-racing-picks-for-friday-september-4-2026' && none.discovery.sitemaps.length === 3 && none.discovery.error === null &&
    fetched.length === 4 && !fetched.includes('https://www.sportsfromthebasement.com/sitemap-2.xml'),
    JSON.stringify(none));
  const noneDelmar = await sftb.resolveUrl({ track: 'Delmar', date: '2026-09-05' }, { fetchText: stubFetch(liveBodies) });
  check('...and the near-miss stays visible for "Delmar" too (nearest is a del-mar post)', /^del-mar-/.test(noneDelmar.discovery.nearestSlug ?? ''));

  const down = await sftb.resolveUrl({ track: 'Del Mar', date: '2026-09-03' }, { fetchText: stubFetch({ [SITEMAP_INDEX_URL]: 503 }) });
  check('sitemap index answering 503: url null, sitemapStatus 503 and the error recorded (the runner files this as http_error, not not_published)',
    down.url === null && down.discovery.sitemapStatus === 503 && /HTTP 503/.test(down.discovery.error) && down.discovery.entriesScanned === 0);
  const partial = await sftb.resolveUrl({ track: 'Del Mar', date: '2026-09-03' }, { fetchText: stubFetch({ ...liveBodies, 'https://www.sportsfromthebasement.com/sitemap-34.xml': 500 }) });
  check('one sitemap page failing is recorded per page and the scan continues to the others',
    partial.url === null && partial.discovery.sitemaps[0].status === 500 && partial.discovery.sitemaps.length === 3 && partial.discovery.sitemapStatus === 200);
}

// ---------- not_published never counts toward the backoff (D07 rule, D53) ----------
console.log('-- backoff: not_published is neither a success nor a failure --');
{
  const dbPath = path.join(process.env.BETSHEET_LOG_DIR, 'backoff.sqlite');
  const db = openDb(dbPath);
  const day = db.prepare("INSERT INTO race_days (track, date, bankroll_cents, per_race_min_cents, correlation_id) VALUES ('Del Mar', '2026-09-03', 20000, 500, 'cid')").run().lastInsertRowid;
  const src = db.prepare("INSERT INTO sources (name, kind) VALUES ('SFTB', 'algorithmic')").run().lastInsertRowid;
  const add = (outcome) => db.prepare('INSERT INTO fetch_attempts (race_day_id, source_id, outcome, fallback_reason, candidate_slug, entries_scanned, nearest_slug, sitemap_url, sitemap_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(day, src, outcome, outcome === 'not_published' ? 'no post yet' : 'HTTP 500', 'del-mar-horse-racing-picks-for-thursday-september-3-2026', 22, 'del-mar-horse-racing-picks-for-friday-september-4-2026', SITEMAP_INDEX_URL, 200);
  add('not_published'); add('not_published'); add('not_published');
  check('three not_published attempts in a row: the source is NOT backed off (the morning fetch before the post is normal)', recentFailures(db, day, src) === false);
  add('not_published'); add('not_published');
  check('five of them: still not backed off', recentFailures(db, day, src) === false);
  add('http_error'); add('not_published'); add('http_error'); add('http_error');
  check('three real failures with a not_published between them: backed off (not_published neither resets nor extends the streak)', recentFailures(db, day, src) === true);
  add('ok');
  check('a success clears it', recentFailures(db, day, src) === false);
  const row = db.prepare('SELECT outcome, candidate_slug, entries_scanned, nearest_slug, sitemap_url, sitemap_status FROM fetch_attempts WHERE outcome = ? LIMIT 1').get('not_published');
  check('migration 013: not_published is a valid outcome and the discovery columns persist on the row',
    row && row.candidate_slug && row.entries_scanned === 22 && row.nearest_slug && row.sitemap_url === SITEMAP_INDEX_URL && row.sitemap_status === 200);
  db.close();
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
