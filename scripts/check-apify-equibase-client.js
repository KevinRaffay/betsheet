// Verification for server/apifyClient.js + server/apifyEquibase.js (Phase 3,
// docs/requirements/apify-equibase-ingest.md) - exits non-zero on any
// failure. Run: npm run check-apify-equibase-client
//
// NEVER makes a real call to Apify - that costs real money and belongs to a
// person running a CLI script (Phase 4), not a check script. Verifies the
// input shaping, the includeWagers default, and the run-status handling
// against a FAKE client matching apify-client's own shape
// (client.actor(id).call(input) -> {id, status, defaultDatasetId};
// client.dataset(id).listItems() -> {items}), injected through the one seam
// runActor() exists to provide. Also proves the round trip this file's own
// header promises: the raw items it returns parse correctly once
// JSON.stringify'd back through the real, golden-verified parsers.

import { hasToken, getApifyClient } from '../server/apifyClient.js';
import { fetchEntries, fetchResults } from '../server/apifyEquibase.js';
import { parseApifyParseforgeDataset } from '../shared/parsers/equibase-apify-parseforge.js';
import { parseApifyResultsDataset } from '../shared/parsers/equibase-apify-results.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

console.log('-- hasToken() / getApifyClient() fail fast, mirroring anthropic-client.js --');
const savedToken = process.env.APIFY_TOKEN;
delete process.env.APIFY_TOKEN;
check('hasToken() is false when unset', hasToken() === false);
let threwNoToken = false;
try { getApifyClient(); } catch (e) { threwNoToken = /APIFY_TOKEN is not set/.test(e.message); }
check('getApifyClient() throws a clear, named error rather than an opaque 401 later', threwNoToken);

process.env.APIFY_TOKEN = 'test-token-not-real';
check('hasToken() is true once set', hasToken() === true);
check('getApifyClient() returns a client without making any network call', typeof getApifyClient().actor === 'function');
if (savedToken === undefined) delete process.env.APIFY_TOKEN; else process.env.APIFY_TOKEN = savedToken;

console.log('\n-- fetchEntries/fetchResults shape the actor input correctly (fake client, no real call) --');
function fakeClient(items, status = 'SUCCEEDED') {
  const calls = [];
  return {
    calls,
    actor(id) {
      return {
        call(input) {
          calls.push({ actorId: id, input });
          return Promise.resolve({ id: 'run1', status, defaultDatasetId: 'ds1' });
        },
      };
    },
    dataset() {
      return { listItems: () => Promise.resolve({ items }) };
    },
  };
}

const entriesClient = fakeClient([{ rowType: 'entry', trackCode: 'DMR', raceNumber: 1 }]);
await fetchEntries({ raceDate: '2026-09-09', tracks: ['DMR'] }, entriesClient);
const entriesCall = entriesClient.calls[0];
check('calls the real actor id', entriesCall.actorId === 'parseforge/equibase-scraper');
check('resultType is entries, date/tracks mapped from raceDate/tracks', JSON.stringify(entriesCall.input) === JSON.stringify({
  resultType: 'entries', date: '2026-09-09', tracks: ['DMR'], maxItems: 10000,
}));
check('D205: maxItems defaults to 10000, overriding the actor\'s own default - too low for a big field (Kentucky Downs, 168 real entries)',
  entriesCall.input.maxItems === 10000);

const noTracksClient = fakeClient([]);
await fetchEntries({ raceDate: '2026-09-09' }, noTracksClient);
check('omitted tracks defaults to [] (every track racing that day), not undefined',
  JSON.stringify(noTracksClient.calls[0].input.tracks) === '[]');

const resultsClient = fakeClient([{ rowType: 'result', trackCode: 'DMR', raceNumber: 1 }]);
await fetchResults({ raceDate: '2026-09-09', tracks: ['DMR'] }, resultsClient);
check('includeWagers defaults to TRUE, overriding the actor\'s own default (off) - every real fixture needed this on',
  resultsClient.calls[0].input.includeWagers === true);
check('D205: fetchResults also defaults maxItems to 10000', resultsClient.calls[0].input.maxItems === 10000);

const noWagersClient = fakeClient([]);
await fetchResults({ raceDate: '2026-09-09', tracks: ['DMR'], includeWagers: false }, noWagersClient);
check('includeWagers is overridable for a caller that wants to skip the extra cost',
  noWagersClient.calls[0].input.includeWagers === false);

const filterClient = fakeClient([]);
await fetchEntries({ raceDate: '2026-09-09', tracks: ['DMR'], onlyStakes: true, maxItems: 50 }, filterClient);
check('arbitrary documented filters pass through via ...rest without this file needing to know their names',
  filterClient.calls[0].input.onlyStakes === true);
check('D205: maxItems is overridable for a caller that wants a smaller/larger cap',
  filterClient.calls[0].input.maxItems === 50);

console.log('\n-- a failed/aborted run is refused loudly, not returned as an empty success --');
let threwFailed = false;
try {
  await fetchResults({ raceDate: '2026-09-09' }, fakeClient([], 'FAILED'));
} catch (e) { threwFailed = /did not succeed/.test(e.message) && /run1/.test(e.message); }
check('a non-SUCCEEDED run throws, naming the run id and status', threwFailed);

console.log('\n-- the round trip this file exists for: raw items -> stringify -> the real golden-verified parsers --');
const realEntryRow = {
  rowType: 'entry', trackCode: 'DMR', trackName: 'Del Mar', raceDate: '2026-09-09', raceNumber: 1,
  raceType: 'Maiden Special Weight', surface: 'Dirt', distance: 'Six Furlongs',
  programNumber: '1', horse: 'Test Horse', morningLineOdds: '3/1',
};
const entriesForRoundTrip = fakeClient([realEntryRow]);
const { items: rawEntries, runId: entriesRunId } = await fetchEntries({ raceDate: '2026-09-09', tracks: ['DMR'] }, entriesForRoundTrip);
const parsedEntries = parseApifyParseforgeDataset(JSON.stringify(rawEntries));
check('a live-fetched entries item parses through the real parser with no reshaping',
  parsedEntries.track === 'Del Mar' && parsedEntries.races[0]?.entries[0]?.horseName === 'Test Horse',
  JSON.stringify(parsedEntries));
check('D204: returns the actor run id alongside items, for a caller to log', entriesRunId === 'run1');

const realResultRow = {
  rowType: 'result', trackCode: 'DMR', trackName: 'Del Mar', raceDate: '2026-09-09', raceNumber: 1,
  finishPosition: 1, programNumber: '1', horse: 'Test Horse', winPayoff: 5.4,
};
const resultsForRoundTrip = fakeClient([realResultRow]);
const { items: rawResults, runId: resultsRunId } = await fetchResults({ raceDate: '2026-09-09', tracks: ['DMR'] }, resultsForRoundTrip);
const parsedResults = parseApifyResultsDataset(JSON.stringify(rawResults));
check('a live-fetched results item parses through the real parser with no reshaping',
  parsedResults.track === 'Del Mar' && parsedResults.races[0]?.results[0]?.winCents === 540,
  JSON.stringify(parsedResults));
check('D204: fetchResults also returns the run id', resultsRunId === 'run1');

if (failures) {
  console.error(`\ncheck-apify-equibase-client: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-apify-equibase-client: all checks passed');
