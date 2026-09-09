// Verification for D195/D196's Apify save-path wiring (`docs/requirements/
// apify-equibase-ingest.md`, Phase 2) - exits non-zero on any failure.
// Run: npm run check-apify-equibase-ingest
//
// Boots the REAL server against a temp database, then exercises the whole
// entries -> results flow over HTTP using the two REAL fixtures that happen
// to be the SAME real day (Del Mar, 2026-09-07): the leaner
// equibase-apify-parseforge entries capture (D192) and the
// equibase-apify-results capture (D193). This is the first time this
// codebase has had a genuinely matched real entries+results pair to wire
// end to end rather than seed synthetically.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseApifyParseforgeDataset, apifyParseforgeToPayload } from '../shared/parsers/equibase-apify-parseforge.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 8919;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-apifyingestcheck-'));
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'equibase-apify');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(PORT),
    BETSHEET_DB: path.join(tmp, 'check.sqlite'),
    BETSHEET_LOG_DIR: path.join(tmp, 'logs'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const jpost = (p, body) => fetch(`${BASE}/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const jget = (p) => fetch(`${BASE}/api${p}`).then((r) => r.json());

try {
  check('server boots on a temp db', await waitForHealth(), serverOut.slice(-400));

  console.log('-- entries: save through the now-wired equibase-apify-parseforge path --');
  const entriesRaw = fs.readFileSync(path.join(FIXTURE_DIR, 'parseforge-dmr-2026-09-07.json'), 'utf8');
  const entriesParsed = parseApifyParseforgeDataset(entriesRaw);
  const entriesPayload = apifyParseforgeToPayload(entriesParsed, '2026-09-06T20:00:00.000Z');
  check('entriesSource is the real provenance value', entriesPayload.entriesSource === 'equibase_apify');

  const saveEntries = await jpost('/race-days', entriesPayload);
  const savedDay = await saveEntries.json();
  check('the day saves (201)', saveEntries.status === 201, JSON.stringify(savedDay));
  const dayId = savedDay.id;

  const stored = await jget(`/race-days/${dayId}`);
  check('entries_source stored as equibase_apify, not silently mislabeled program',
    stored.entries_source === 'equibase_apify', stored.entries_source);
  const totalEntries = stored.races.reduce((a, r) => a + r.entries.length, 0);
  check('all 11 races and 123 entries survive the round trip (D192\'s own hand count)',
    stored.races.length === 11 && totalEntries === 123, `races=${stored.races.length} entries=${totalEntries}`);

  console.log('\n-- an invalid entriesSource is refused end to end (Phase 1\'s fix, exercised for real) --');
  const badSource = await jpost('/race-days', { ...entriesPayload, track: 'Golden Gate Fields', date: '2026-09-08', entriesSource: 'not_a_real_source' });
  check('a bogus entriesSource is refused 400, never silently coerced to program', badSource.status === 400);

  console.log('\n-- results: preview via the new day-scoped Apify route, derives scratches from the just-saved entries --');
  const resultsRaw = fs.readFileSync(path.join(FIXTURE_DIR, 'apify-results-dmr-2026-09-07.json'), 'utf8');
  const preview = await (await jpost(`/race-days/${dayId}/results-apify/preview`, { data: resultsRaw })).json();
  check('preview writes nothing and returns the parsed shape with sourceKind attached',
    preview.sourceKind === 'equibase_apify' && Array.isArray(preview.races) && preview.races.length === 11);
  const race11 = preview.races.find((r) => r.number === 11);
  const scratchedPgms = (race11?.scratches ?? []).map((s) => s.programNumber).sort();
  check('race 11 derives exactly the 4 real scratches (entries present, absent from finishers)',
    JSON.stringify(scratchedPgms) === JSON.stringify(['1', '6', '8', '9']), JSON.stringify(scratchedPgms));
  const raceWithNoScratch = preview.races.find((r) => r.number === 1);
  check('race 1 (every entry finished) derives no scratches', (raceWithNoScratch?.scratches ?? []).length === 0);

  console.log('\n-- confirm: the exact preview response saves through the EXISTING /results route unchanged --');
  const saveResults = await jpost(`/race-days/${dayId}/results`, preview);
  const savedResults = await saveResults.json();
  check('results save (201)', saveResults.status === 201, JSON.stringify(savedResults));

  const resultsRead = await jget(`/race-days/${dayId}/results`);
  check('result_charts records source_kind equibase_apify, not silently mislabeled equibase_paste',
    resultsRead.charts[0]?.source_kind === 'equibase_apify', JSON.stringify(resultsRead.charts[0]));
  const totalFinishers = resultsRead.results.length;
  check('all 106 finishers survive the round trip (D193\'s own hand count)', totalFinishers === 106, String(totalFinishers));
  const race11Scratches = resultsRead.scratches.filter((s) => s.race_number === 11).map((s) => s.program_number).sort();
  check('race 11\'s 4 scratches are the real rows in result_scratches, correctly resolved to program numbers',
    JSON.stringify(race11Scratches) === JSON.stringify(['1', '6', '8', '9']), JSON.stringify(race11Scratches));

  console.log('\n-- an invalid sourceKind is refused end to end (the same Phase 1-class fix on the results side) --');
  const badKind = await jpost(`/race-days/${dayId}/results`, { ...preview, sourceKind: 'not_a_real_kind' });
  check('a bogus sourceKind is refused 400, never silently coerced to equibase_paste', badKind.status === 400);

  console.log('\n-- the preview route respects the same day-lifecycle guards as every other route --');
  const missingDay = await jpost('/race-days/999999/results-apify/preview', { data: resultsRaw });
  check('an unknown day 404s', missingDay.status === 404);
  const noData = await jpost(`/race-days/${dayId}/results-apify/preview`, {});
  check('a missing data field 400s rather than crashing', noData.status === 400);
} finally {
  server.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-apify-equibase-ingest: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-apify-equibase-ingest: all checks passed');
