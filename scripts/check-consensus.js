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
const { parseRobots } = await import('../server/consensus.js');

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
const common = { supports: ({ track }) => track === 'Del Mar' };
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
    resolveUrl: async () => null,
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
  check('audit rows visible for every attempt', c1.attempts.length === 7,
    `attempts=${c1.attempts.length}`);
  check('resolveUrl fetcher discovers its page and stores picks',
    outcome('Stub Resolver') === 'ok');
  check('resolveUrl returning null -> visible no-page outcome',
    outcome('Stub Resolver None') === 'http_error' &&
    /no published page/.test(run1.results.find((r) => r.source === 'Stub Resolver None')?.fallbackReason ?? ''));

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
