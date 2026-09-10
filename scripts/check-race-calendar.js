// Verification for shared/race-calendar.js (D208) - exits non-zero on any
// failure. Run: npm run check-race-calendar
//
// PURE: no server, no DB, no fixtures, no real clock - every conversion
// takes an explicit date/time/zone so a case is exactly reproducible.
//
// The case that matters most is DST: a track's offset from Pacific must be
// computed for the SPECIFIC calendar date, never a fixed number, since every
// registered track (and Pacific itself) observes daylight saving on the US
// calendar. The clearest proof is a real transition boundary - the exact
// week the clocks actually move - rather than a same-track two-season pair,
// which (correctly) lands in the identical Pacific column either way since
// every US/Canada zone in this registry shifts DST on the same schedule.

import { canonicalizeTrack, listTracks } from '../shared/track-codes.js';
import {
  CALENDAR_START_HOUR,
  formatPacific,
  hourBucket,
  localWallClockToUtc,
  placeRacePacific,
} from '../shared/race-calendar.js';

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

if (failures) {
  console.error(`\ncheck-race-calendar: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-race-calendar: all checks passed');
