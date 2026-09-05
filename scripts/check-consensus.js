// Verification for the consensus-fetch framework - exits non-zero on any
// failure. Run: npm run check-consensus
//
// Boots the real server (child process, temp DB) with BETSHEET_EXTRA_FETCHERS
// pointing at stub fetchers that target a local stub-source HTTP server this
// script runs. Exercises: a working source, robots.txt blocking (asserting
// the disallowed path is NEVER requested), HTTP errors, track/date-mismatch
// discard, refresh-replaces-not-duplicates, backoff after repeated failures,
// and the manual paste fallback's preview-then-confirm flow. Plus unit
// checks for the manual picks parser and the robots parser.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const API_PORT = 8900;
const STUB_PORT = 8901;
const BASE = `http://127.0.0.1:${API_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-consensuscheck-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

// ---------- unit checks (no server needed) ----------

process.env.BETSHEET_LOG_DIR = path.join(tmp, 'unit-logs');
const { parsePicksText } = await import('../shared/picks-parser.js');
const { parseRobots, recentFailures } = await import('../server/consensus.js');
const { openDb } = await import('../server/db.js');

const pp = parsePicksText("Race 1: 4, 2, 7\nR2: Howie's Law, 6 | watch: 3, Late Horse\n3: 5, 1A | contrarian: 9\njunk line\n");
check('picks parser: ranked, flagged, coupled and named picks', (() => {
  const r1 = pp.races.find((r) => r.race === 1);
  const r2 = pp.races.find((r) => r.race === 2);
  const r3 = pp.races.find((r) => r.race === 3);
  return r1?.picks.map((p) => p.pickType).join(',') === 'top,second,third' &&
    r2?.picks[0].horseName === "Howie's Law" && r2?.picks[0].pickType === 'top' &&
    r2?.picks.filter((p) => p.pickType === 'watch_out').length === 2 &&
    r3?.picks.some((p) => p.programNumber === '1A' && p.pickType === 'second') &&
    r3?.picks.some((p) => p.programNumber === '9' && p.pickType === 'contrarian');
})(), JSON.stringify(pp));
check('picks parser: junk line warned, not fatal',
  pp.warnings.some((w) => w.type === 'unrecognized_line'));
check('picks parser: empty input warns no_picks',
  parsePicksText('').warnings.some((w) => w.type === 'no_picks'));

// ---------- not_published never counts toward the backoff (D07 rule, D53) ----------
// Moved here from check-sources.js when the SFTB fetcher was removed (D82):
// the rule is the consensus FRAMEWORK's, not any one source's - a discovery
// miss means the source has not posted yet, which is the normal state of a
// morning fetch and must not push a source toward being backed off.
{
  const dbPath = path.join(tmp, 'backoff.sqlite');
  const db = openDb(dbPath);
  const day = db.prepare("INSERT INTO race_days (track, date, bankroll_cents, per_race_min_cents, correlation_id) VALUES ('Del Mar', '2026-09-03', 20000, 500, 'cid')").run().lastInsertRowid;
  const src = db.prepare("INSERT INTO sources (name, kind) VALUES ('Some algorithmic source', 'algorithmic')").run().lastInsertRowid;
  const SITEMAP_URL = 'https://example.test/sitemap-index-1.xml';
  const add = (outcome) => db.prepare('INSERT INTO fetch_attempts (race_day_id, source_id, outcome, fallback_reason, candidate_slug, entries_scanned, nearest_slug, sitemap_url, sitemap_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(day, src, outcome, outcome === 'not_published' ? 'no post yet' : 'HTTP 500', 'candidate-slug-for-the-day', 22, 'nearest-slug-one-day-later', SITEMAP_URL, 200);
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
    row && row.candidate_slug && row.entries_scanned === 22 && row.nearest_slug && row.sitemap_url === SITEMAP_URL && row.sitemap_status === 200);
  db.close();
}

check('robots parser: * group only, comments stripped',
  JSON.stringify(parseRobots('User-agent: googlebot\nDisallow: /a\nUser-agent: *\nDisallow: /private # hidden\nDisallow:\nUser-agent: other\nDisallow: /b\n'))
  === JSON.stringify(['/private', '']));

// ---------- stub source server ----------

const hits = {};
const stub = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] ?? 0) + 1;
  if (req.url === '/robots.txt') {
    res.end('User-agent: *\nDisallow: /private\n');
  } else if (req.url === '/picks-good') {
    res.end(JSON.stringify({
      track: 'Del Mar', date: '2026-09-03',
      races: [
        { race: 1, picks: [{ programNumber: '4', pickType: 'top' }, { horseName: 'Certitude (FR)', pickType: 'second' }] },
        { race: 2, picks: [{ programNumber: '8', pickType: 'top' }, { programNumber: '99', pickType: 'watch_out' }] },
      ],
    }));
  } else if (req.url === '/wrongday') {
    res.end(JSON.stringify({ track: 'Del Mar', date: '2026-09-04', races: [{ race: 1, picks: [{ programNumber: '1', pickType: 'top' }] }] }));
  } else if (req.url === '/flaky') {
    res.statusCode = 500;
    res.end('boom');
  } else if (req.url === '/sitemap-stub') {
    res.end(`<urlset><url><loc>http://127.0.0.1:${STUB_PORT}/picks-good</loc></url></urlset>`);
  } else {
    res.statusCode = 404;
    res.end('not here');
  }
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

// ---------- stub fetchers module ----------

const fetchersPath = path.join(tmp, 'stub-fetchers.mjs');
fs.writeFileSync(fetchersPath, `
const base = 'http://127.0.0.1:${STUB_PORT}';
// Letters-only like the runner's trackKey (D53): a day typed 'Delmar' is Del Mar.
const common = { supports: ({ track }) => String(track).toUpperCase().replace(/[^A-Z]/g, '') === 'DELMAR' };
const jsonParse = (body) => JSON.parse(body);
export default [
  { id: 'stub-good', name: 'Stub Good Picks', kind: 'algorithmic', ...common,
    buildUrl: () => base + '/picks-good', parse: jsonParse },
  { id: 'stub-robots', name: 'Stub Robots-Blocked', kind: 'track_picks', ...common,
    buildUrl: () => base + '/private/picks', parse: jsonParse },
  { id: 'stub-404', name: 'Stub Missing Page', kind: 'race_guide', ...common,
    buildUrl: () => base + '/nope', parse: jsonParse },
  { id: 'stub-wrongday', name: 'Stub Wrong Day', kind: 'digest', ...common,
    buildUrl: () => base + '/wrongday', parse: jsonParse },
  { id: 'stub-flaky', name: 'Stub Flaky', kind: 'algorithmic', ...common,
    buildUrl: () => base + '/flaky', parse: jsonParse },
  { id: 'stub-other-track', name: 'Stub Other Track', kind: 'track_picks',
    supports: ({ track }) => track === 'Santa Anita',
    buildUrl: () => base + '/picks-good', parse: jsonParse },
  { id: 'stub-resolver', name: 'Stub Resolver', kind: 'algorithmic', ...common,
    buildUrl: () => base + '/unused',
    resolveUrl: async (_ctx, { fetchText }) => {
      const xml = await fetchText(base + '/sitemap-stub');
      return xml.match(/<loc>([^<]+)/)[1];
    },
    parse: jsonParse },
  { id: 'stub-resolver-none', name: 'Stub Resolver None', kind: 'algorithmic', ...common,
    buildUrl: () => base + '/unused',
    // D53: a discovery miss answers { url: null, discovery } - the audit fields.
    resolveUrl: async () => ({ url: null, discovery: { sitemapUrl: base + '/sitemap-stub', sitemapStatus: 200, candidateSlug: 'del-mar-horse-racing-picks-for-thursday-september-3-2026', entriesScanned: 1, nearestSlug: 'picks-good' } }),
    parse: jsonParse },
  { id: 'stub-resolver-legacy', name: 'Stub Resolver Legacy', kind: 'algorithmic', ...common,
    buildUrl: () => base + '/unused',
    resolveUrl: async () => null, // pre-D53 shape: a bare null still means not published
    parse: jsonParse },
];
`);

// ---------- boot the real server ----------

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(API_PORT),
    BETSHEET_DB: path.join(tmp, 'check.sqlite'),
    BETSHEET_LOG_DIR: path.join(tmp, 'logs'),
    BETSHEET_EXTRA_FETCHERS: fetchersPath,
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1', // stub-only run, never the network
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const jpost = (url, body, headers = {}) => fetch(BASE + url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  check('server boots', up, serverOut.slice(-400));

  // Seed a race day from the real pasted fixture.
  const fixture = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'entries', 'dmtc-2026-09-03.txt'), 'utf8');
  const parsed = await (await jpost('/api/parse/entries-text', { text: fixture })).json();
  const saved = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: parsed.date, bankrollCents: 20000, perRaceMinCents: 500, races: parsed.races,
  })).json();
  const dayId = saved.id;
  check('seeded race day', Number.isInteger(dayId));

  // ---- run 1 ----
  const run1 = await (await jpost(`/api/race-days/${dayId}/fetch-consensus`, {})).json();
  const outcome = (name) => run1.results.find((r) => r.source === name)?.outcome;
  check('good source fetches and stores picks',
    outcome('Stub Good Picks') === 'ok' &&
    run1.results.find((r) => r.source === 'Stub Good Picks').picksExtracted === 4,
    JSON.stringify(run1.results));
  check('robots-disallowed source is blocked', outcome('Stub Robots-Blocked') === 'blocked');
  check('robots-disallowed path was NEVER requested',
    (hits['/private/picks'] ?? 0) === 0 && (hits['/robots.txt'] ?? 0) > 0,
    JSON.stringify(hits));
  check('404 source records http_error', outcome('Stub Missing Page') === 'http_error');
  check('wrong-date page discarded whole', outcome('Stub Wrong Day') === 'track_date_mismatch');
  check('500 source records http_error', outcome('Stub Flaky') === 'http_error');
  check('source for another track is skipped silently',
    !run1.results.some((r) => r.source === 'Stub Other Track'));

  // Race 1 has TWO agreeing external sources (Stub Good Picks and Stub
  // Resolver serve the same payload) -> genuinely UNANIMOUS; the pick-less
  // races on a card with no program ranks fall to CHAOS.
  check('fetch-consensus classifies the day (2 agreeing externals -> UNANIMOUS)', (() => {
    const cls = Object.fromEntries((run1.classification ?? []).map((c) => [c.number, c.classification]));
    return cls[1] === 'UNANIMOUS' && cls[3] === 'CHAOS';
  })(), JSON.stringify(run1.classification));

  const c1 = await (await fetch(`${BASE}/api/race-days/${dayId}/consensus`)).json();
  check('classification persisted and served with consensus',
    c1.races?.find((r) => r.number === 1)?.classification === 'UNANIMOUS' &&
    c1.races?.find((r) => r.number === 1)?.externalSourceCount === 2);
  check('picks resolved to entries (named pick matched to program number)', (() => {
    const cert = c1.picks.find((p) => p.horse_name === 'Certitude (FR)');
    return cert && cert.program_number === '5' && cert.entry_id != null && cert.pick_type === 'second';
  })(), JSON.stringify(c1.picks));
  check('unmatched pick kept and visible',
    c1.picks.some((p) => p.program_number === '99' && p.entry_id === null));
  check('audit rows visible for every attempt', c1.attempts.length === 8,
    `attempts=${c1.attempts.length}`);
  check('resolveUrl fetcher discovers its page and stores picks',
    outcome('Stub Resolver') === 'ok');
  // D53: a discovery miss is not_published, never http_error, and the row
  // carries the discovery fields (DB row = audit line = UI table).
  const noneRes = run1.results.find((r) => r.source === 'Stub Resolver None');
  const noneRow = c1.attempts.find((a) => a.source_name === 'Stub Resolver None');
  check('discovery miss -> not_published with the audit fields on the response AND the DB row (sitemap url/status, candidate slug, entries scanned, nearest slug)',
    noneRes?.outcome === 'not_published' && /no post for del-mar-horse-racing-picks-for-thursday-september-3-2026 in 1 sitemap entries; nearest: picks-good/.test(noneRes.fallbackReason) &&
    noneRow?.outcome === 'not_published' && noneRow.sitemap_url === `http://127.0.0.1:${STUB_PORT}/sitemap-stub` && noneRow.sitemap_status === 200 &&
    noneRow.candidate_slug === 'del-mar-horse-racing-picks-for-thursday-september-3-2026' && noneRow.entries_scanned === 1 && noneRow.nearest_slug === 'picks-good' && noneRow.url === null,
    JSON.stringify({ noneRes, noneRow }));
  check('a legacy resolveUrl returning a bare null is not_published too', outcome('Stub Resolver Legacy') === 'not_published');
  check('a found page carries its discovery fields on the ok row as well (url + sitemap it came from)', (() => {
    const row = c1.attempts.find((a) => a.source_name === 'Stub Resolver');
    return row?.outcome === 'ok' && row.url === `http://127.0.0.1:${STUB_PORT}/picks-good`;
  })());

  // ---- runs 2 and 3: refresh replaces, failures accumulate ----
  await jpost(`/api/race-days/${dayId}/fetch-consensus`, {});
  await jpost(`/api/race-days/${dayId}/fetch-consensus`, {});
  const c3 = await (await fetch(`${BASE}/api/race-days/${dayId}/consensus`)).json();
  check('refresh replaces picks, never duplicates',
    c3.picks.filter((p) => p.source_name === 'Stub Good Picks').length === 4,
    `picks=${c3.picks.length}`);

  // ---- run 4: flaky has 3 straight failures -> backed off, not retried ----
  const flakyHitsBefore = hits['/flaky'] ?? 0;
  const run4 = await (await jpost(`/api/race-days/${dayId}/fetch-consensus`, {})).json();
  const flaky4 = run4.results.find((r) => r.source === 'Stub Flaky');
  check('backoff: 4th run skips the flaky source with a visible reason',
    flaky4?.outcome === 'blocked' && /backing off/.test(flaky4?.fallbackReason ?? ''),
    JSON.stringify(flaky4));
  check('backoff: the flaky URL was not requested again',
    (hits['/flaky'] ?? 0) === flakyHitsBefore);
  check('good source unaffected by others backing off',
    run4.results.find((r) => r.source === 'Stub Good Picks')?.outcome === 'ok');
  check('D53: four not_published in a row never back a source off - the 4th run still tries it and records not_published, not blocked',
    run4.results.find((r) => r.source === 'Stub Resolver None')?.outcome === 'not_published' &&
    run4.results.find((r) => r.source === 'Stub Resolver Legacy')?.outcome === 'not_published',
    JSON.stringify(run4.results.filter((r) => /Resolver/.test(r.source))));
  const c4 = await (await fetch(`${BASE}/api/race-days/${dayId}/consensus`)).json();
  check('...and the audit shows four not_published rows for it, zero blocked',
    c4.attempts.filter((a) => a.source_name === 'Stub Resolver None').map((a) => a.outcome).join() === 'not_published,not_published,not_published,not_published');

  // ---- D35: track canonicalization at save closes the D53 gap at its root -
  // a day can no longer be SAVED as "Delmar" (it stores as "Del Mar"), so
  // typing "Delmar" for the same date now collides with the existing day
  // instead of silently coexisting as a second, differently-spelled one ----
  const conflictDelmar = await jpost('/api/race-days', {
    track: 'Delmar', date: parsed.date, bankrollCents: 20000, perRaceMinCents: 500, races: parsed.races,
  });
  check('D35: a day typed "Delmar" on the same date as the "Del Mar" day conflicts (409), not a silent duplicate',
    conflictDelmar.status === 409);

  // ---- manual fallback: preview writes nothing, confirm writes ----
  const preview = await (await jpost(`/api/race-days/${dayId}/consensus/manual-preview`, {
    sourceName: 'Pasted Digest',
    text: 'Race 1: 4, Certitude (FR) | watch: 3\nRace 9: 1\n',
  })).json();
  check('manual preview: parses, resolves, and warns on the off-card race',
    preview.races.length === 1 && preview.races[0].picks[1].horseName === 'Certitude (FR)' &&
    preview.races[0].picks[1].entryId != null &&
    preview.warnings.some((w) => w.type === 'unknown_race'),
    JSON.stringify(preview));
  const cAfterPreview = await (await fetch(`${BASE}/api/race-days/${dayId}/consensus`)).json();
  check('manual preview writes NOTHING',
    !cAfterPreview.picks.some((p) => p.source_name === 'Pasted Digest'));

  const confirm = await (await jpost(`/api/race-days/${dayId}/consensus/manual`, {
    sourceName: 'Pasted Digest', races: preview.races,
  })).json();
  const cFinal = await (await fetch(`${BASE}/api/race-days/${dayId}/consensus`)).json();
  check('manual confirm stores the previewed picks with an audit row',
    confirm.picksStored === 3 &&
    cFinal.picks.filter((p) => p.source_name === 'Pasted Digest').length === 3 &&
    cFinal.attempts.some((a) => a.source_name === 'Pasted Digest' && a.outcome === 'manual_paste'));

  check('manual save without a preview payload -> 400',
    (await jpost(`/api/race-days/${dayId}/consensus/manual`, { sourceName: 'X' })).status === 400);

  // ---- disabled source: skipped with a visible reason, restored after ----
  const Database = (await import('better-sqlite3')).default;
  const cdb = new Database(path.join(tmp, 'check.sqlite'));
  cdb.prepare("UPDATE sources SET enabled = 0 WHERE name = 'Stub Good Picks'").run();
  cdb.close();
  const runDisabled = await (await jpost(`/api/race-days/${dayId}/fetch-consensus`, {})).json();
  const disabled = runDisabled.results.find((r) => r.source === 'Stub Good Picks');
  check('disabled source is skipped with a visible audit row',
    disabled?.outcome === 'blocked' && /disabled/.test(disabled?.fallbackReason ?? ''),
    JSON.stringify(disabled));
} finally {
  server.kill();
  stub.close();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
}

if (failures) {
  console.error(`\ncheck-consensus: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-consensus: all checks passed');
