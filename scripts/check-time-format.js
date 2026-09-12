// Verification for shared/time-format.js (D382) - exits non-zero on any
// failure. Run: npm run check-time-format
//
// Pure: no server, no DB, no port. Every expected string below was worked out
// by hand from the UTC offset in force on that date (PDT = UTC-7 through
// 2026-11-01, PST = UTC-8 after), so a wrong ICU on the running node would
// fail here rather than silently shift every time on screen.

import { DISPLAY_TIME_ZONE, formatPacific } from '../shared/time-format.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

console.log('-- the zone is a constant, and this node can format it --');
check('DISPLAY_TIME_ZONE is America/Los_Angeles', DISPLAY_TIME_ZONE === 'America/Los_Angeles');
check('this node carries the ICU data for it (a small-icu build would throw here)',
  (() => { try { new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TIME_ZONE }); return true; } catch { return false; } })());

console.log('-- UTC instants land in Pacific, with the right daylight label --');
check('the timestamp the user quoted: 2026-09-11T22:37:11Z -> 2026-09-11 3:37 PM PDT',
  formatPacific('2026-09-11T22:37:11Z') === '2026-09-11 3:37 PM PDT', formatPacific('2026-09-11T22:37:11Z'));
check('a winter instant reads PST, not PDT: 2026-01-15T17:30:00Z -> 2026-01-15 9:30 AM PST',
  formatPacific('2026-01-15T17:30:00Z') === '2026-01-15 9:30 AM PST', formatPacific('2026-01-15T17:30:00Z'));
check('the DATE moves too when the instant crosses midnight Pacific: 2026-09-12T05:10:00Z -> 2026-09-11 10:10 PM PDT',
  formatPacific('2026-09-12T05:10:00Z') === '2026-09-11 10:10 PM PDT', formatPacific('2026-09-12T05:10:00Z'));
check('midnight itself is 12:00 AM, never 0:00', formatPacific('2026-09-11T07:00:00Z') === '2026-09-11 12:00 AM PDT', formatPacific('2026-09-11T07:00:00Z'));
check('noon is 12:00 PM', formatPacific('2026-09-11T19:00:00Z') === '2026-09-11 12:00 PM PDT', formatPacific('2026-09-11T19:00:00Z'));
check('fractional seconds and an explicit offset are honoured: 2026-09-11T22:37:11.250+02:00 -> 1:37 PM PDT',
  formatPacific('2026-09-11T22:37:11.250+02:00') === '2026-09-11 1:37 PM PDT', formatPacific('2026-09-11T22:37:11.250+02:00'));

console.log("-- SQLite's naive form is UTC, never local --");
// `datetime('now')` writes this shape; `new Date()` alone would read it as
// the machine's local time and shift it by the machine's own offset.
check("'2026-09-11 21:48:09' -> 2026-09-11 2:48 PM PDT (read as UTC)",
  formatPacific('2026-09-11 21:48:09') === '2026-09-11 2:48 PM PDT', formatPacific('2026-09-11 21:48:09'));
check("the same with a T and no zone: '2026-09-11T21:48:09' -> 2:48 PM PDT",
  formatPacific('2026-09-11T21:48:09') === '2026-09-11 2:48 PM PDT', formatPacific('2026-09-11T21:48:09'));
check('minutes-only naive form is accepted', formatPacific('2026-09-11 21:48') === '2026-09-11 2:48 PM PDT', formatPacific('2026-09-11 21:48'));

console.log('-- what must NOT be shifted or lost --');
check('a bare DATE is a calendar day, not an instant: returned unchanged',
  formatPacific('2026-09-11') === '2026-09-11');
check('null -> null, so a caller can print its own dash', formatPacific(null) === null && formatPacific(undefined) === null);
check('empty and whitespace -> null', formatPacific('') === null && formatPacific('   ') === null);
check('an unparseable stored value comes back VERBATIM - never blanked',
  formatPacific('(capture time unknown)') === '(capture time unknown)' && formatPacific('not a date') === 'not a date');
check('a number is not silently treated as epoch millis - it is not a shape this schema stores',
  formatPacific(1757630231000) === '1757630231000');

console.log('-- dateOnly --');
check('dateOnly gives the Pacific DATE, which can differ from the UTC one',
  formatPacific('2026-09-12T05:10:00Z', { dateOnly: true }) === '2026-09-11');
check('dateOnly on a bare date is the bare date', formatPacific('2026-09-11', { dateOnly: true }) === '2026-09-11');

console.log('-- the zone is overridable, so the constant is the only Pacific-specific thing here --');
check('timeZone: UTC round-trips the input', formatPacific('2026-09-11T22:37:11Z', { timeZone: 'UTC' }) === '2026-09-11 10:37 PM UTC',
  formatPacific('2026-09-11T22:37:11Z', { timeZone: 'UTC' }));

if (failures) {
  console.error(`\ncheck-time-format: ${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\ncheck-time-format: all checks passed');
}
