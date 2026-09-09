// Verification for server/equibase-apify-entries.js's UI-triggered preview
// route - exits non-zero on any failure. Run:
//   npm run check-equibase-apify-entries-preview
//
// NEVER makes a real Apify call. Two halves:
//  1. previewApifyEntries() unit-tested directly with a FAKE client
//     (the same injection seam shared/apifyEquibase.js's runActor already
//     established) - covers input shaping, the entriesSource/oddsCapturedAt
//     fields the route adds, and a genuine parse through the real,
//     golden-verified parser.
//  2. The REAL Express route, over a real temp server - but only the paths
//     that are safe to hit for real: bad input (400s BEFORE any fetch is
//     attempted) and the no-APIFY_TOKEN case (fails inside getApifyClient(),
//     before any network I/O, so this exercises the route's full success/
//     failure response shaping without ever reaching Apify's API).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { previewApifyEntries } from '../server/equibase-apify-entries.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 8901;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-apifyentriespreview-check-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

console.log('-- previewApifyEntries(): fake client, no real call --');
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

const realShapedRow = {
  rowType: 'entry', trackCode: 'DMR', trackName: 'Del Mar', raceDate: '2026-09-09', raceNumber: 1,
  raceType: 'Maiden Special Weight', surface: 'Dirt', distance: 'Six Furlongs',
  programNumber: '1', horse: 'UI Test Horse', morningLineOdds: '3/1',
};
const client = fakeClient([realShapedRow]);
const before = Date.now();
const preview = await previewApifyEntries({ track: 'Del Mar', date: '2026-09-09' }, client);
check('calls the real actor id, single track only', client.calls[0]?.actorId === 'parseforge/equibase-scraper'
  && JSON.stringify(client.calls[0].input.tracks) === JSON.stringify(['Del Mar']));
check('resultType is entries, date mapped from the date argument', client.calls[0].input.resultType === 'entries' && client.calls[0].input.date === '2026-09-09');
check('parses through the real parser - track/date/entry survive', preview.track === 'Del Mar' && preview.date === '2026-09-09' && preview.races[0]?.entries[0]?.horseName === 'UI Test Horse');
check('entriesSource is equibase_apify - the route\'s own addition, not the parser\'s', preview.entriesSource === 'equibase_apify');
check('oddsCapturedAt is a fresh timestamp (this call\'s own capture time)', new Date(preview.oddsCapturedAt).getTime() >= before);
check('D204: apifyRunId rides on the return value for the route to log (never a real one here)', preview.apifyRunId === 'run1');

console.log('\n-- the real Express route: request validation, safe because nothing is called yet --');
// `server/index.js` loads `dotenv/config` itself, and this repo's own .env
// carries a REAL APIFY_TOKEN (check-pull-apify-cli.js hit this same trap
// first) - deleting it from the spawned env is not enough on its own, since
// dotenv fills in only the keys missing from process.env by reading the
// FILE straight off disk regardless of what was stripped here.
// DOTENV_CONFIG_PATH points at a path that cannot exist so the real .env is
// never found, which is what makes the "no token" test below structurally
// incapable of making a real, billed call no matter what this machine's
// .env holds.
const spawnEnv = { ...process.env, BETSHEET_PORT: String(PORT), BETSHEET_DB: path.join(tmp, 'check.sqlite'), BETSHEET_LOG_DIR: path.join(tmp, 'logs') };
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

try {
  check('temp server boots', await waitForHealth(), serverOut.slice(-400));

  const jpost = (body) => fetch(`${BASE}/api/parse/equibase-apify-entries`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const missingBoth = await jpost({});
  check('missing track and date -> 400, nothing attempted', missingBoth.status === 400);

  const missingDate = await jpost({ track: 'Del Mar' });
  check('missing date -> 400', missingDate.status === 400);

  const badDate = await jpost({ track: 'Del Mar', date: 'not-a-date' });
  check('malformed date -> 400', badDate.status === 400);

  console.log('\n-- valid input, no APIFY_TOKEN: fails inside getApifyClient(), before any network call --');
  const noToken = await jpost({ track: 'Del Mar', date: '2026-09-09' });
  const noTokenBody = await noToken.json();
  check('refused with the real, named error - never a silent empty preview', noToken.status === 422 && /APIFY_TOKEN is not set/.test(noTokenBody.error));
} finally {
  server.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-equibase-apify-entries-preview: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-equibase-apify-entries-preview: all checks passed');
