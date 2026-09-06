// Verification for shared/staleness.js (D117) - exits non-zero on any failure.
// Run: npm run check-staleness
//
// PURE: no server, no DB, no real clock. Every case passes its own `now`,
// which is the reason the module takes one rather than calling Date.now()
// itself - a freshness module that cannot be tested at a fixed instant is a
// freshness module nobody can trust.
//
// The cases that matter most are the ones where the module must REFUSE to
// answer: no capture time on file, and "has this race run?" on a day whose
// timezone is not recorded. Both have a wrong answer that looks helpful, and
// both are places where looking helpful is the bug.

import { entriesStaleness, postTimeMinutes, STALE_AFTER_MINUTES } from '../shared/staleness.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

// A fixed local instant: 2026-09-06, 9:30 PM in whatever zone this runs in.
// Deliberately constructed WITHOUT a Z so the local-day comparisons under test
// are exercised in the runner's own zone, which is what a browser does too.
const NOW = new Date('2026-09-06T21:30:00');
const ago = (mins) => new Date(NOW.getTime() - mins * 60000).toISOString();
const on = (raceDate, extra = {}) => entriesStaleness({ raceDate, now: NOW, ...extra });

console.log('-- post time parsing --');
check('afternoon', postTimeMinutes('2:00PM') === 14 * 60);
check('with a space, and lowercase', postTimeMinutes('2:00 pm') === 14 * 60);
check('noon and midnight do not collide',
  postTimeMinutes('12:00PM') === 12 * 60 && postTimeMinutes('12:00AM') === 0);
check('a morning post', postTimeMinutes('9:45AM') === 9 * 60 + 45);
for (const junk of ['', null, undefined, 'soon', '25:00PM', '2:99PM', '2:00', 'first race']) {
  check(`rejects ${JSON.stringify(junk)} rather than guessing`, postTimeMinutes(junk) === null);
}

console.log('\n-- capture age is the exact part --');
check('a recent capture is fresh', on('2026-09-06', { capturedAt: ago(20) }).state === 'fresh');
check('the threshold boundary is inclusive - exactly at it is still fresh',
  on('2026-09-06', { capturedAt: ago(STALE_AFTER_MINUTES) }).state === 'fresh');
check('one minute past the threshold is stale',
  on('2026-09-06', { capturedAt: ago(STALE_AFTER_MINUTES + 1) }).state === 'stale');
check('the threshold is a parameter, not a constant baked into the answer',
  on('2026-09-06', { capturedAt: ago(30), staleAfterMinutes: 10 }).state === 'stale'
  && on('2026-09-06', { capturedAt: ago(30), staleAfterMinutes: 90 }).state === 'fresh');
check('minutes are reported, not just a state',
  on('2026-09-06', { capturedAt: ago(43) }).minutesOld === 43);
check('an age over an hour reads in hours and minutes',
  /^Entries saved 3h 0m ago/.test(on('2026-09-06', { capturedAt: ago(180) }).label),
  on('2026-09-06', { capturedAt: ago(180) }).label);

console.log('\n-- refusing to answer is a feature, not a gap --');
const none = on('2026-09-06');
check('NO capture time reads as unknown, NEVER as fresh', none.state === 'unknown' && !none.known);
check('unknown says so in words a person can act on', none.label === 'Entries age unknown', none.label);
check('unknown reports no age at all rather than a zero', none.minutesOld === null);
const future = on('2026-09-06', { capturedAt: new Date(NOW.getTime() + 3600000).toISOString() });
check('a capture stamped in the future is a clock disagreement, not freshness',
  future.state === 'unknown', JSON.stringify(future));
check('and it never prints a negative age', !/-\d+ min/.test(future.label), future.label);

console.log('\n-- "has it run?" only when no timezone is needed --');
check('a day in the past: every race has run, in any timezone on earth',
  on('2026-09-05', { capturedAt: ago(10), postTime: '2:00PM' }).ran === true);
check('...and that answer carries no assumption',
  on('2026-09-05', { capturedAt: ago(10), postTime: '2:00PM' }).assumesViewerClock === false);
check('a day in the future: no race has run, in any timezone on earth',
  on('2026-09-07', { capturedAt: ago(10), postTime: '2:00PM' }).ran === false);
check('...and that answer carries no assumption either',
  on('2026-09-07', { capturedAt: ago(10), postTime: '2:00PM' }).assumesViewerClock === false);
const todayPast = on('2026-09-06', { capturedAt: ago(10), postTime: '2:00PM' });
check('TODAY, post already gone by this clock: ran, but flagged as an assumption',
  todayPast.ran === true && todayPast.assumesViewerClock === true, JSON.stringify(todayPast));
const todayLater = on('2026-09-06', { capturedAt: ago(10), postTime: '11:45PM' });
check('TODAY, post still ahead by this clock: not run, same flag',
  todayLater.ran === false && todayLater.assumesViewerClock === true, JSON.stringify(todayLater));
const noPost = on('2026-09-06', { capturedAt: ago(10), postTime: null });
check('TODAY with NO post time: refuses to say, rather than assuming it has run',
  noPost.ran === null && noPost.assumesViewerClock === false, JSON.stringify(noPost));
const junkPost = on('2026-09-06', { capturedAt: ago(10), postTime: 'first race' });
check('TODAY with an unparseable post time: also refuses',
  junkPost.ran === null, JSON.stringify(junkPost));

console.log('\n-- the whole-card design this exists to surface --');
// One odds_captured_at covers every race, so the LAST race is exactly as stale
// as the first by this measure. That is the point: the number is about the
// CAPTURE, and the per-race post time is what tells you how much it matters.
const capturedAt = ago(90);
const first = on('2026-09-06', { capturedAt, postTime: '1:00PM' });
const last = on('2026-09-06', { capturedAt, postTime: '11:45PM' });
check('every race on a card shares one capture age - later races are staler by construction',
  first.minutesOld === last.minutesOld && first.state === last.state && first.state === 'stale');
check('...but they differ on whether they have run yet',
  first.ran === true && last.ran === false);

console.log('\n-- never throws --');
for (const args of [undefined, {}, { capturedAt: 'not a date' }, { capturedAt: 123 }, { raceDate: 'nonsense' }]) {
  let threw = false;
  let out = null;
  try { out = entriesStaleness(args); } catch { threw = true; }
  check(`survives ${JSON.stringify(args)}`, !threw && out && typeof out.state === 'string');
}
check('an unparseable capture date reads as unknown, not as an Invalid Date age',
  entriesStaleness({ capturedAt: 'not a date', now: NOW }).state === 'unknown');

if (failures) {
  console.error(`\ncheck-staleness: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-staleness: all checks passed');
