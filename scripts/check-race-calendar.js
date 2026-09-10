// Verification for shared/race-calendar.js (D208) and server/race-calendar.js
// (D209, the GET /api/calendar endpoint) - exits non-zero on any failure.
// Run: npm run check-race-calendar
//
// (1) PURE: no server, no DB, no fixtures, no real clock - every conversion
// takes an explicit date/time/zone so a case is exactly reproducible. The
// case that matters most is DST: a track's offset from Pacific must be
// computed for the SPECIFIC calendar date, never a fixed number, since every
// registered track (and Pacific itself) observes daylight saving on the US
// calendar. The clearest proof is a real transition boundary - the exact
// week the clocks actually move - rather than a same-track two-season pair,
// which (correctly) lands in the identical Pacific column either way since
// every US/Canada zone in this registry shifts DST on the same schedule.
//
// (2) the endpoint on a seeded temp DB: three real tracks in three real
// zones on one date, a null post time and an unregistered track both
// landing in `unplaceable` rather than being dropped, a deleted day and a
// different date both excluded, and the 400 refusals on a bad `date`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { canonicalizeTrack, listTracks } from '../shared/track-codes.js';
import {
  CALENDAR_START_HOUR,
  formatPacific,
  hourBucket,
  localWallClockToUtc,
  placeRacePacific,
} from '../shared/race-calendar.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

console.log('-- localWallClockToUtc: a known offset, deep winter and deep summer --');
check('2:00 PM Eastern in January is EST (UTC-5)',
  localWallClockToUtc('2026-01-15', '2:00 PM', 'America/New_York')?.toISOString() === '2026-01-15T19:00:00.000Z');
check('2:00 PM Eastern in July is EDT (UTC-4)',
  localWallClockToUtc('2026-07-15', '2:00 PM', 'America/New_York')?.toISOString() === '2026-07-15T18:00:00.000Z');
check('2:00 PM Pacific in January is PST (UTC-8)',
  localWallClockToUtc('2026-01-15', '2:00 PM', 'America/Los_Angeles')?.toISOString() === '2026-01-15T22:00:00.000Z');
check('2:00 PM Pacific in July is PDT (UTC-7)',
  localWallClockToUtc('2026-07-15', '2:00 PM', 'America/Los_Angeles')?.toISOString() === '2026-07-15T21:00:00.000Z');

console.log('\n-- localWallClockToUtc: the actual 2026 spring-forward boundary, not just two seasons --');
{
  // 2026's US "spring forward" is 2026-03-08. Two weeks apart, unambiguously
  // on either side, is the plainest possible proof the offset is computed
  // per-date rather than baked in as a constant.
  const before = localWallClockToUtc('2026-03-01', '10:00 AM', 'America/New_York');
  const after = localWallClockToUtc('2026-03-15', '10:00 AM', 'America/New_York');
  check('the same 10:00 AM wall clock is EST (UTC-5) before the boundary',
    before?.toISOString() === '2026-03-01T15:00:00.000Z', before?.toISOString());
  check('...and EDT (UTC-4) after it - a full hour earlier in UTC for the identical local reading',
    after?.toISOString() === '2026-03-15T14:00:00.000Z', after?.toISOString());
}

console.log('\n-- localWallClockToUtc: refuses rather than guesses --');
check('an unparseable post time', localWallClockToUtc('2026-09-10', 'first race', 'America/Chicago') === null);
check('a malformed date', localWallClockToUtc('not-a-date', '2:00 PM', 'America/Chicago') === null);
check('a missing zone', localWallClockToUtc('2026-09-10', '2:00 PM', null) === null);
check('an unrecognized IANA zone name (Intl rejects it)',
  localWallClockToUtc('2026-09-10', '2:00 PM', 'Nowhere/Fake') === null);
for (const junk of [undefined, {}, 123]) {
  let threw = false;
  try { localWallClockToUtc(junk, junk, junk); } catch { threw = true; }
  check(`survives ${JSON.stringify(junk) ?? String(junk)}`, !threw);
}

console.log('\n-- hourBucket: the 10:00 AM Pacific anchored grid --');
{
  // 2026-01-15 is deep winter (PST, UTC-8) with no DST edge nearby, so a
  // fixed-hour UTC offset is safe to hand-compute for each case.
  const at = (ptHour) => new Date(Date.UTC(2026, 0, 15, ptHour + 8, 0, 0));
  check(`10:00 AM PT is column 0 (the grid's own start hour is ${CALENDAR_START_HOUR})`, hourBucket(at(10)) === 0);
  check('11:00 AM PT is column 1', hourBucket(at(11)) === 1);
  check('9:00 AM PT (the last hour before the grid repeats) is column 23', hourBucket(at(9)) === 23);
  check('midnight PT is column 14', hourBucket(at(0)) === 14);
  check('1:00 AM PT is column 15', hourBucket(at(1)) === 15);
  check('an invalid instant returns null rather than a wrong bucket', hourBucket(new Date('not a date')) === null);
  check('a non-Date input returns null', hourBucket('2026-01-15T18:00:00Z') === null);
}

console.log('\n-- formatPacific: always Pacific, with the correct seasonal label --');
check('a January instant prints PST', formatPacific(new Date('2026-01-15T18:00:00Z')) === '10:00 AM PST');
check('a July instant prints PDT', formatPacific(new Date('2026-07-15T17:00:00Z')) === '10:00 AM PDT');
check('an invalid instant returns null', formatPacific(new Date('not a date')) === null);

console.log('\n-- placeRacePacific: the one call a caller actually needs --');
{
  // Kentucky Downs (America/Chicago). 11:00 AM CDT (Sept, UTC-5) = 16:00 UTC
  // = 9:00 AM PDT (UTC-7) - two zones apart, both mid-DST, both computed for
  // real rather than assumed.
  const kd = placeRacePacific('2026-09-10', '11:00 AM', 'America/Chicago');
  check('Kentucky Downs 11:00 AM CDT lands on 9:00 AM PDT', kd?.postTimePacific === '9:00 AM PDT', JSON.stringify(kd));
  check('...which is column 23 on the Pacific grid', kd?.hourBucket === 23, JSON.stringify(kd));

  check('an unrecognized track (no known zone) is UNPLACEABLE, never a guessed bucket',
    placeRacePacific('2026-09-10', '11:00 AM', null) === null);
  check('an unparseable post time is also unplaceable',
    placeRacePacific('2026-09-10', 'first race', 'America/Chicago') === null);
}

console.log('\n-- the same-track, different-season case: identical column, different printed label --');
{
  // The US and Canada shift DST on the same calendar, so a track's offset
  // FROM Pacific does not change across seasons - only Pacific's own label
  // does. Asserting the column stays put while PST/PDT flips is what proves
  // both ends of the conversion (source zone AND Pacific) are genuinely
  // DST-aware rather than one side being a hardcoded guess.
  const winter = placeRacePacific('2026-01-15', '2:00 PM', 'America/Chicago');
  const summer = placeRacePacific('2026-07-15', '2:00 PM', 'America/Chicago');
  check('winter: 2:00 PM CST -> Pacific noon, PST', winter?.postTimePacific === '12:00 PM PST', JSON.stringify(winter));
  check('summer: 2:00 PM CDT -> Pacific noon, PDT', summer?.postTimePacific === '12:00 PM PDT', JSON.stringify(summer));
  check('same wall-clock post time, same track, lands in the same Pacific column both seasons',
    winter?.hourBucket === summer?.hourBucket && winter?.hourBucket === 2);
}

console.log('\n-- every registered track\'s timezone actually converts (ties track-codes.js to this module) --');
{
  const zones = new Set(listTracks().map(({ display }) => canonicalizeTrack(display).timezone));
  check('at least a dozen distinct zones across the registry', zones.size >= 5, String(zones.size));
  const bad = [];
  for (const tz of zones) {
    if (!localWallClockToUtc('2026-06-15', '1:00 PM', tz)) bad.push(tz);
  }
  check(`all ${zones.size} distinct registry zones convert a sample post time`, bad.length === 0, bad.join(', '));
}

// ---------- server: GET /api/calendar (D209, phase C-2) ----------
console.log('\n-- server: /api/calendar --');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-cal-'));
  const dbPath = path.join(tmp, 'check.sqlite');
  const { openDb } = await import('../server/db.js');
  const db = openDb(dbPath);

  // 2026-09-12: firmly mid-DST everywhere in the registry (US DST ends
  // 2026-11-01), so EDT/CDT/PDT offsets are all fixed and hand-computable.
  const DATE = '2026-09-12';
  let dayId = 0;
  function seedDay(track, races, { deleted = false } = {}) {
    dayId = db.prepare("INSERT INTO race_days (track, date, correlation_id, deleted_at) VALUES (?, ?, ?, ?)")
      .run(track, DATE, `cid-${track}`, deleted ? '2026-09-12T00:00:00Z' : null).lastInsertRowid;
    for (const [number, postTime] of races) {
      db.prepare('INSERT INTO races (race_day_id, number, post_time) VALUES (?, ?, ?)').run(dayId, number, postTime);
    }
    return dayId;
  }
  // Del Mar (Pacific): 10:15 AM PDT is already Pacific - bucket 0.
  const dmr = seedDay('Del Mar', [[1, '10:15 AM'], [2, null]]);
  // Kentucky Downs (Central, CDT -5): 1:00 PM CDT = 18:00 UTC = 11:00 AM PDT - bucket 1.
  seedDay('Kentucky Downs', [[1, '1:00 PM']]);
  // Saratoga (Eastern, EDT -4): 3:05 PM EDT = 19:05 UTC = 12:05 PM PDT - bucket 2.
  seedDay('Saratoga', [[1, '3:05 PM']]);
  // An unregistered track: derived code, no known timezone - every race unplaceable.
  seedDay('Some Brand New Fairgrounds', [[1, '1:00 PM']]);
  // Same track+date shape, but soft-deleted - must not appear at all.
  seedDay('Woodbine', [[1, '1:00 PM']], { deleted: true });
  // A different date entirely - must not appear in a DATE query.
  db.prepare("INSERT INTO race_days (track, date, correlation_id) VALUES ('Gulfstream Park', '2026-09-13', 'cid-gp')").run();
  db.close();

  const PORT = 8908;
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, BETSHEET_PORT: String(PORT), BETSHEET_DB: dbPath, BETSHEET_LOG_DIR: path.join(tmp, 'server-logs') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = ''; server.stdout.on('data', (d) => { serverOut += d; }); server.stderr.on('data', (d) => { serverOut += d; });
  const jget = (url) => fetch(BASE + url).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); } }
    check('server boots on the seeded DB', up, serverOut.slice(-300));

    const { status: badStatus } = await jget('/api/calendar');
    check('a missing date is refused 400', badStatus === 400);
    const { status: junkStatus } = await jget('/api/calendar?date=not-a-date');
    check('a malformed date is refused 400', junkStatus === 400);

    const { status, body: r } = await jget(`/api/calendar?date=${DATE}`);
    check('200 on a well-formed date', status === 200);
    check('the other date and the deleted Woodbine day are both excluded',
      !r.tracks.some((t) => t.track === 'Gulfstream Park' || t.track === 'Woodbine'));
    check('exactly the 4 live tracks for this date come back',
      r.tracks.length === 4, r.tracks.map((t) => t.track).join(', '));

    const dm = r.tracks.find((t) => t.track === 'Del Mar');
    check('Del Mar: race 1 placed at 10:15 AM PDT, column 0; race 2 (null post time) is unplaceable',
      dm?.timezone === 'America/Los_Angeles'
      && dm.races.length === 1 && dm.races[0].number === 1 && dm.races[0].postTimePacific === '10:15 AM PDT' && dm.races[0].hourBucket === 0
      && dm.unplaceable.join() === '2',
      JSON.stringify(dm));

    const kd = r.tracks.find((t) => t.track === 'Kentucky Downs');
    check('Kentucky Downs (Central): 1:00 PM CDT lands on 11:00 AM PDT, column 1',
      kd?.races[0]?.postTimePacific === '11:00 AM PDT' && kd.races[0].hourBucket === 1, JSON.stringify(kd));

    const sar = r.tracks.find((t) => t.track === 'Saratoga');
    check('Saratoga (Eastern): 3:05 PM EDT lands on 12:05 PM PDT, column 2',
      sar?.races[0]?.postTimePacific === '12:05 PM PDT' && sar.races[0].hourBucket === 2, JSON.stringify(sar));

    check('tracks are ordered by earliest post: Del Mar, then Kentucky Downs, then Saratoga',
      r.tracks.map((t) => t.track).join() === 'Del Mar,Kentucky Downs,Saratoga,Some Brand New Fairgrounds');

    const unknown = r.tracks.find((t) => t.track === 'Some Brand New Fairgrounds');
    check('an unregistered track carries no guessed timezone and every one of its races is unplaceable, never dropped',
      unknown?.timezone === null && unknown.races.length === 0 && unknown.unplaceable.join() === '1', JSON.stringify(unknown));

    const { body: empty } = await jget('/api/calendar?date=2020-01-01');
    check('a date with no race days returns an empty list, not an error', empty.date === '2020-01-01' && empty.tracks.length === 0);
  } finally {
    server.kill();
    await new Promise((rr) => setTimeout(rr, 300));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures) {
  console.error(`\ncheck-race-calendar: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-race-calendar: all checks passed');
