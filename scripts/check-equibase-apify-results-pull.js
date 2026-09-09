// Verification for server/equibase-apify-results.js's UI-triggered live pull
// route (D206) - exits non-zero on any failure. Run:
//   npm run check-equibase-apify-results-pull
//
// NEVER makes a real Apify call. Three halves, mirroring
// check-equibase-apify-entries-preview.js's own shape for the entries side:
//  1. pullApifyResults() unit-tested directly with a FAKE client (the same
//     injection seam server/apifyEquibase.js's runActor already
//     established) - covers the day's own track/date feeding the call,
//     entriesByRace derivation against a seeded day's real entries, and a
//     genuine parse through the real, golden-verified parser.
//  2. The REAL Express route, over a real temp server seeded with a real
//     day (the same D192/D193 Del Mar 2026-09-07 fixture pair
//     check-apify-equibase-ingest.js uses) - day-lifecycle guards (404/410)
//     and the no-APIFY_TOKEN case (fails inside getApifyClient(), before
//     any network I/O).
//  3. The response shape matches what the existing manual `.../preview`
//     route and the unmodified `/results` save route already expect, so
//     ResultsPanel.jsx's save flow needs no special-casing for this source.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { pullApifyResults } from '../server/equibase-apify-results.js';
import { parseApifyParseforgeDataset, apifyParseforgeToPayload } from '../shared/parsers/equibase-apify-parseforge.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 8920;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'equibase-apify');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-apifyresultspull-check-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

function fakeClient(items) {
  const calls = [];
  return {
    calls,
    actor(id) {
      return { call(input) { calls.push({ actorId: id, input }); return Promise.resolve({ id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' }); } };
    },
    dataset() { return { listItems: () => Promise.resolve({ items }) }; },
  };
}

console.log('-- pullApifyResults(): fake client, no real call --');
{
  const db = {
    prepare: () => ({
      all: () => [{ race_number: 1, program_number: '1', horse_name: 'Fake Scratch' }],
    }),
  };
  const day = { id: 1, track: 'Del Mar', date: '2026-09-09' };
  const resultRow = {
    rowType: 'result', trackCode: 'DMR', trackName: 'Del Mar', raceDate: '2026-09-09', raceNumber: 1,
    programNumber: '2', horse: 'UI Test Winner', finishPosition: 1, winPayoff: 4.2, placePayoff: 2.6, showPayoff: 2.1,
  };
  const client = fakeClient([resultRow]);
  const before = Date.now();
  const result = await pullApifyResults(db, day, client);
  check('calls the real actor id, single track only', client.calls[0]?.actorId === 'parseforge/equibase-scraper'
    && JSON.stringify(client.calls[0].input.tracks) === JSON.stringify(['Del Mar']));
  check('resultType is results, date mapped from the day\'s own date, includeWagers defaults true',
    client.calls[0].input.resultType === 'results' && client.calls[0].input.date === '2026-09-09' && client.calls[0].input.includeWagers === true);
  check('parses through the real parser - track/date/finisher survive',
    result.track === 'Del Mar' && result.date === '2026-09-09' && result.races[0]?.results[0]?.horseName === 'UI Test Winner');
  check('sourceKind is equibase_apify - the route\'s own addition, not the parser\'s', result.sourceKind === 'equibase_apify');
  check('scratch derivation ran against the seeded entriesByRace (program 1 finished nowhere -> scratched)',
    result.races[0]?.scratches?.[0]?.programNumber === '1');
  check('D204 precedent: apifyRunId rides on the return value (never a real one here)', result.apifyRunId === 'run1');
  void before;
}

console.log('\n-- the real Express route: a seeded real day, request guards, safe because nothing is called past getApifyClient() --');
// Same trap check-equibase-apify-entries-preview.js and check-pull-apify-cli.js
// both already document: server/index.js loads dotenv/config itself, and a
// real .env on this machine could carry a genuine APIFY_TOKEN. Deleting the
// var from the spawned env is not enough on its own - dotenv fills in any
// key still missing from process.env by reading the FILE straight off disk
// regardless. Pointing DOTENV_CONFIG_PATH at a path that cannot exist is
// what makes the "no token" case below structurally incapable of a real,
// billed call no matter what this machine's own .env holds.
const spawnEnv = {
  ...process.env,
  BETSHEET_PORT: String(PORT),
  BETSHEET_DB: path.join(tmp, 'check.sqlite'),
  BETSHEET_LOG_DIR: path.join(tmp, 'logs'),
};
delete spawnEnv.APIFY_TOKEN;
spawnEnv.DOTENV_CONFIG_PATH = path.join(tmp, 'no-such-env-file');
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: spawnEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const jpost = (p, body) => fetch(`${BASE}/api${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: body != null ? JSON.stringify(body) : undefined,
});

try {
  check('temp server boots', await waitForHealth(), serverOut.slice(-400));

  console.log('\n-- a genuinely unknown day 404s, before any network call --');
  const missingDay = await jpost('/race-days/999999/results-apify/pull');
  check('unknown day -> 404', missingDay.status === 404);

  console.log('\n-- a real seeded day (the D192/D193 Del Mar 2026-09-07 pair), no APIFY_TOKEN: fails inside getApifyClient() --');
  const entriesRaw = fs.readFileSync(path.join(FIXTURE_DIR, 'parseforge-dmr-2026-09-07.json'), 'utf8');
  const entriesParsed = parseApifyParseforgeDataset(entriesRaw);
  const entriesPayload = apifyParseforgeToPayload(entriesParsed, '2026-09-06T20:00:00.000Z');
  const saveEntries = await jpost('/race-days', entriesPayload);
  const savedDay = await saveEntries.json();
  check('the seed day saves (201)', saveEntries.status === 201, JSON.stringify(savedDay));
  const dayId = savedDay.id;

  const noToken = await jpost(`/race-days/${dayId}/results-apify/pull`);
  const noTokenBody = await noToken.json();
  check('refused with the real, named error - never a silent empty preview',
    noToken.status === 422 && /APIFY_TOKEN is not set/.test(noTokenBody.error), JSON.stringify(noTokenBody));

  console.log('\n-- a soft-deleted day refuses 410, matching every other results route\'s guard --');
  const delRes = await fetch(`${BASE}/api/race-days/${dayId}`, { method: 'DELETE' });
  check('delete succeeds', delRes.ok);
  const deletedPull = await jpost(`/race-days/${dayId}/results-apify/pull`);
  check('deleted day -> 410, not attempted', deletedPull.status === 410);
} finally {
  server.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-equibase-apify-results-pull: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-equibase-apify-results-pull: all checks passed');
