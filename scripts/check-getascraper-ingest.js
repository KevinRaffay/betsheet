// D219: the getascraper entries path end to end over real HTTP, on a throwaway
// database - preview, save, and the one thing this whole source exists for:
// the saved day's races actually PLACING on the race-day calendar.
//
// Shaped like scripts/check-apify-equibase-ingest.js (D196), which does the same
// for the parseforge path. The unit-level parser checks live in
// scripts/check-getascraper-entries.js; this file only covers what a pure parser
// test structurally cannot - the Express routes, the CHECK constraint added by
// migration 034, and the join from a saved row through GET /api/calendar.
//
// THE PAYOFF ASSERTION is `-- the day lands on the race calendar --`. Every
// other check here could pass while the feature is useless: the purpose of this
// source is that parseforge-sourced days are invisible on the D209-D211
// calendar (0 of 11 races placeable), and the only proof that getascraper fixes
// it is a real saved day coming back from the real endpoint with its race in
// `races` rather than `unplaceable`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8914;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = path.join(ROOT, 'tests/fixtures/equibase-getascraper/getascraper-sar-2026-09-07.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-getascraper-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures += 1; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
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
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const jpost = (p, body) => fetch(`${BASE}/api${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const jget = (p) => fetch(`${BASE}/api${p}`).then((r) => r.json());

console.log('== check-getascraper-ingest ==');
try {
  check('server boots on a temp db', await waitForHealth(), serverOut.slice(-400));

  console.log('-- preview: the real export through the real route --');
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const previewRes = await jpost('/parse/getascraper-entries', { json: raw, oddsCapturedAt: '2026-09-10T18:21:01Z' });
  const preview = await previewRes.json();
  check('preview returns 200', previewRes.status === 200, JSON.stringify(preview).slice(0, 200));
  check('track read out of the file', preview.track === 'Saratoga', preview.track);
  check('date read out of the file', preview.date === '2026-09-07', preview.date);
  check('one race, results rows ignored', preview.races?.length === 1, String(preview.races?.length));
  check('nine entries on race 1', preview.races?.[0]?.entries?.length === 9);
  check('post time survives the route with its meridiem', preview.races?.[0]?.postTime === '11:30 AM', preview.races?.[0]?.postTime);
  check('entriesSource is this source\'s own value', preview.entriesSource === 'equibase_getascraper', preview.entriesSource);
  check('a correlation id comes back', typeof preview.correlationId === 'string' && preview.correlationId.length > 0);
  check(
    'the program-number derivation is surfaced to the user',
    (preview.warnings ?? []).some((w) => w.type === 'program_number_derived_from_post_position'),
  );
  check(
    'every warning has a message (D207 - ParsePreview renders w.message)',
    (preview.warnings ?? []).every((w) => typeof w.message === 'string' && w.message.trim().length > 0),
  );

  // Invariant 9: a preview writes nothing.
  const beforeSave = await jget('/race-days');
  check('preview wrote nothing', Array.isArray(beforeSave) && beforeSave.length === 0, JSON.stringify(beforeSave).slice(0, 120));

  console.log('-- refusals on the preview route --');
  check('an empty body is refused 400', (await jpost('/parse/getascraper-entries', {})).status === 400);
  check('a blank json string is refused 400', (await jpost('/parse/getascraper-entries', { json: '   ' })).status === 400);
  const badJson = await jpost('/parse/getascraper-entries', { json: '{nope' });
  const badBody = await badJson.json();
  check(
    'malformed JSON comes back as a blocking WARNING, not a 500',
    badJson.status === 200 && badBody.warnings.some((w) => w.blocking && w.type === 'invalid_json'),
    `status ${badJson.status}`,
  );

  console.log('-- save: through the existing /race-days route, unmodified --');
  const saveRes = await jpost('/race-days', {
    track: preview.track,
    date: preview.date,
    bankrollCents: 20000,
    perRaceMinCents: 500,
    entriesSource: preview.entriesSource,
    oddsCapturedAt: preview.oddsCapturedAt,
    races: preview.races,
  });
  const saved = await saveRes.json();
  check('the day saves (201)', saveRes.status === 201, JSON.stringify(saved).slice(0, 200));
  const dayId = saved.id;

  const day = await jget(`/race-days/${dayId}`);
  check('migration 034 accepted the new provenance value', day.entries_source === 'equibase_getascraper', day.entries_source);
  check('the race survived the save', day.races?.length === 1);
  check('all nine entries survived', day.races?.[0]?.entries?.length === 9);
  check('post_time persisted to the column', day.races?.[0]?.post_time === '11:30 AM', String(day.races?.[0]?.post_time));
  check(
    'derived program numbers persisted',
    day.races?.[0]?.entries?.map((e) => e.program_number).join(',') === '1,2,3,4,5,6,7,8,9',
    day.races?.[0]?.entries?.map((e) => e.program_number).join(','),
  );

  console.log('-- a bogus entriesSource is still refused (D195\'s fix, not weakened) --');
  const bogus = await jpost('/race-days', {
    track: 'Saratoga', date: '2026-09-08', entriesSource: 'getascraper', races: preview.races,
  });
  check('an unrecognized entriesSource is refused 400', bogus.status === 400, `status ${bogus.status}`);

  console.log('-- THE PAYOFF: the day lands on the race calendar --');
  const cal = await jget('/calendar?date=2026-09-07');
  const track = cal.tracks?.find((t) => t.raceDayId === dayId);
  check('the saved day appears on the calendar', !!track, JSON.stringify(cal).slice(0, 200));
  check('its timezone resolved from the track registry', track?.timezone === 'America/New_York', String(track?.timezone));
  check('the race is PLACED, not unplaceable', track?.races?.length === 1 && track?.unplaceable?.length === 0,
    `placed ${track?.races?.length}, unplaceable ${track?.unplaceable?.length}`);
  check('11:30 AM ET renders as 8:30 AM Pacific', track?.races?.[0]?.postTimePacific === '8:30 AM PDT', String(track?.races?.[0]?.postTimePacific));
  check('and lands in the correct hour column', track?.races?.[0]?.hourBucket === 1, String(track?.races?.[0]?.hourBucket));
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll getascraper ingest checks passed.');
