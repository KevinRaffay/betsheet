// Verification for shared/entry-flags.js (D216).
//
// PURE unit cases - this module reads no database, calls nothing and stakes
// nothing, so hand-built races cover it completely and there is no fixture to
// keep in sync.
//
// The load-bearing cases are the ones that would produce a SILENTLY WRONG
// highlight rather than a visibly broken one:
//   - the three real Baffert spellings this corpus actually holds, since an
//     equality test against any one of them reaches 4% of the runners;
//   - the field count being LIVE runners, so a six-horse race that scratches
//     to five qualifies and a five-horse race that scratches to four stops;
//   - a scratched horse never being the favorite even when it carries the
//     shortest morning line;
//   - the morning line read from the printed STRING when a caller has no
//     stored decimal, which is exactly server/replay.js's `entriesPayload`.
//
// NEGATIVE CONTROL: change `BAFFERT_RE` to `/^B Baffert$/` and the three
// spelling assertions fail; change `FAVORITE_FIELD_SIZE` to 6 and the
// field-size assertions fail. Both exit non-zero.
//
// D223 NEGATIVE CONTROL: make the rank sort `b.ml - a.ml` and the order
// assertions fail; drop the tie branch and the "1, 1, 3" assertion fails.
//
// D224 NEGATIVE CONTROL: drop the `scratched ? null : ...` guard on
// `mlPayoutCents`/`mlWinProbability` and the scratched-horse assertion fails
// (a scratch would imply a payout again); change `impliedWinPayoutCents` to
// use a $1 base instead of $2 and the $7.00/$3.60/$42.00 assertions fail.
//
// D236 NEGATIVE CONTROLS, one per decision the live-board block makes:
//   - normalise over the WHOLE live field instead of the comparable set (drop
//     the `Number.isFinite(flags[x.i].mlDecimal)` filter) and the
//     one-horse-unpriced case reports a move on horses that did not move;
//   - drop the normalisation entirely (compare raw probabilities) and the
//     SCRATCH case fails: every survivor reads as steaming;
//   - AND the two move tests instead of ORing them and the hammered favorite
//     (5/2 -> 8/5, a 1.24x ratio worth +8 points) stops being flagged;
//   - drop `minDelta` from the ratio branch and the 99/1 -> 60/1 quantisation
//     case starts reporting a big steam.
// All four exit non-zero.
//
// Run: npm run check-entry-flags

import {
  FAVORITE_FIELD_SIZE, MOVE_THRESHOLDS, flagRaceEntries, isBaffertEntry,
} from '../shared/entry-flags.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

const e = (trainer, ml, extra = {}) => ({ trainer, morning_line: ml, scratched: false, ...extra });
const flagsOf = (entries) => flagRaceEntries(entries).flags;
const favIdx = (entries) => flagsOf(entries).map((f, i) => (f.favorite ? i : -1)).filter((i) => i >= 0);
const bafIdx = (entries) => flagsOf(entries).map((f, i) => (f.baffert ? i : -1)).filter((i) => i >= 0);

console.log('\nMorning-line rank (D223) - the predicted order of finish, on every race');
const ranksOf = (entries) => flagRaceEntries(entries).flags.map((f) => f.mlRank);
{
  const eight = [e('A', '6/1'), e('B', '5/2'), e('C', '20/1'), e('D', '7/2'), e('E', '8/1'), e('F', '4/5'), e('G', '12/1'), e('H', '9/2')];
  check('ranked by the line, shortest first, on an 8-horse field (no favorite flag fires)',
    JSON.stringify(ranksOf(eight)) === '[5,2,8,3,6,1,7,4]' && flagRaceEntries(eight).favoriteCount === 0, JSON.stringify(ranksOf(eight)));
  const tied = [e('A', '5/2'), e('B', '3/1'), e('C', '5/2'), e('D', '10/1')];
  check('a tie shares the rank and the next rank is skipped: 1, 3, 1, 4',
    JSON.stringify(ranksOf(tied)) === '[1,3,1,4]', JSON.stringify(ranksOf(tied)));
  const scr = [e('A', '4/5', { scratched: true }), e('B', '3/1'), e('C', '6/1')];
  check('a scratched horse has no rank and does not hold a place in the order',
    JSON.stringify(ranksOf(scr)) === '[null,1,2]', JSON.stringify(ranksOf(scr)));
  const unpriced = [e('A', null), e('B', '3/1'), e('C', '-')];
  check('an unpriced horse is null, never last', JSON.stringify(ranksOf(unpriced)) === '[null,1,null]', JSON.stringify(ranksOf(unpriced)));
  const camel = [{ trainer: 'X', morningLine: '6/1', scratched: false }, { trainer: 'Y', morningLine: '2/1', scratched: false }];
  const stored = [{ trainer: 'X', morning_line: '99/1', morning_line_decimal: 6, scratched: 0 }, { trainer: 'Y', morning_line: '1/1', morning_line_decimal: 2, scratched: 0 }];
  check('camelCase (replay/preview) and the stored decimal (DB rows, which win over the printed string) both rank',
    JSON.stringify(ranksOf(camel)) === '[2,1]' && JSON.stringify(ranksOf(stored)) === '[2,1]');
  check('five-horse field: the favorite flag and rank 1 name the same horse',
    (() => { const f = flagRaceEntries([e('A', '6/1'), e('B', '5/2'), e('C', '20/1'), e('D', '7/2'), e('E', '8/1')]).flags; return f[1].favorite && f[1].mlRank === 1 && f.filter((x) => x.favorite).length === 1; })());
  check('every flag carries mlRank, null on junk', flagRaceEntries([{}, {}]).flags.every((f) => f.mlRank === null));
}

console.log('\nImplied $2-to-win and win probability (D224) - a reading aid, never a promise');
const payoutsOf = (entries) => flagRaceEntries(entries).flags.map((f) => f.mlPayoutCents);
const probsOf = (entries) => flagRaceEntries(entries).flags.map((f) => f.mlWinProbability);
{
  // 5/2 -> $2 * (2.5 + 1) = $7.00 -> 700 cents; probability 1 / 3.5 ~ 0.2857.
  const one = [e('A', '5/2')];
  check('5/2 implies a $7.00 $2-win price', payoutsOf(one)[0] === 700, payoutsOf(one)[0]);
  check('5/2 implies about 28.57% win probability',
    Math.abs(probsOf(one)[0] - (1 / 3.5)) < 1e-9, probsOf(one)[0]);

  // 4/5 (odds-on) -> $2 * 1.8 = $3.60; probability 1/1.8 ~ 55.6%.
  const favShot = [e('A', '4/5')];
  check('an odds-on 4/5 shot implies $3.60 and over 50% - a short line is a SHORT payout, not a big one',
    payoutsOf(favShot)[0] === 360 && Math.abs(probsOf(favShot)[0] - (1 / 1.8)) < 1e-9,
    JSON.stringify({ payout: payoutsOf(favShot)[0], prob: probsOf(favShot)[0] }));

  // 20/1 -> $2 * 21 = $42.00; probability 1/21 ~ 4.76%.
  const longshot = [e('A', '20/1')];
  check('a 20/1 longshot implies $42.00 and under 5%',
    payoutsOf(longshot)[0] === 4200 && probsOf(longshot)[0] < 0.05, payoutsOf(longshot)[0]);

  // A real morning line (Del Mar 2026-09-07, race 1) - its implied
  // probabilities sum well over 1, the OVERROUND, not a bug in this module.
  const field = ['20/1', '30/1', '3/1', '15/1', '5/1', '5/2', '20/1', '3/1', '15/1', '12/1']
    .map((ml) => e('X', ml));
  const overround = probsOf(field).reduce((a, p) => a + (p ?? 0), 0);
  check('a real race\'s implied probabilities sum well over 100% (the track\'s take)',
    overround > 1.25 && overround < 1.30, overround);

  // A SCRATCHED horse has no payout or probability even though it carried a
  // price - it cannot cash, unlike mlRank's own null-for-scratch rule, which
  // this mirrors.
  const scr = [e('A', '5/2', { scratched: true }), e('B', '3/1')];
  check('a scratched horse implies neither a payout nor a probability, despite carrying a line',
    payoutsOf(scr)[0] === null && probsOf(scr)[0] === null && payoutsOf(scr)[1] === 800,
    JSON.stringify(payoutsOf(scr)));

  // An unpriced horse: both null, never a fabricated figure.
  const unpriced = [e('A', null), e('B', '-')];
  check('an unpriced horse implies nothing', payoutsOf(unpriced).every((x) => x === null)
    && probsOf(unpriced).every((x) => x === null));

  // The stored decimal wins over the printed string, same rule as mlRank.
  const stored = [{ trainer: 'X', morning_line: '99/1', morning_line_decimal: 2.5, scratched: 0 }];
  check('the stored decimal (not the printed string) drives the payout when a caller has one',
    payoutsOf(stored)[0] === 700, payoutsOf(stored)[0]);

  check('junk never throws and implies nothing',
    flagRaceEntries([{}, {}]).flags.every((f) => f.mlPayoutCents === null && f.mlWinProbability === null));
}

console.log('\nTrainer match - the three spellings this corpus really holds');

// Counts are from the real corpus (2026-09-10): 160 / 9 / 8 entries
// respectively. All three are the same person; the parenthetical is the
// assistant trainer, which some Equibase captures append and others do not.
check('"Bob Baffert(J. Barnes)" matches (160 entries - the COMMONEST form, and the one a literal "B Baffert" equality misses)',
  isBaffertEntry({ trainer: 'Bob Baffert(J. Barnes)' }));
check('"B Baffert" matches (9 entries)', isBaffertEntry({ trainer: 'B Baffert' }));
check('"B. Baffert" matches (8 entries)', isBaffertEntry({ trainer: 'B. Baffert' }));
check('matching is case-insensitive', isBaffertEntry({ trainer: 'BOB BAFFERT' }) && isBaffertEntry({ trainer: 'bob baffert' }));
check('an unrelated trainer does not match', !isBaffertEntry({ trainer: 'Doug F. ONeill(L. Mora)' }));
check('a null trainer does not match and does not throw', !isBaffertEntry({ trainer: null }));
check('a missing trainer field does not match and does not throw', !isBaffertEntry({}) && !isBaffertEntry(null));

console.log('\nField size - counted over LIVE runners');

const five = [e('A', '5/2'), e('B', '2/1'), e('C', '8/1'), e('D', '10/1'), e('E', '6/1')];
check(`FAVORITE_FIELD_SIZE is ${FAVORITE_FIELD_SIZE}`, FAVORITE_FIELD_SIZE === 5);
check('five live runners: the shortest morning line is flagged, and only it',
  JSON.stringify(favIdx(five)) === '[1]', JSON.stringify(favIdx(five)));
check('six live runners: nothing is flagged',
  favIdx([...five, e('F', '3/1')]).length === 0);
check('four live runners: nothing is flagged', favIdx(five.slice(0, 4)).length === 0);

const sixWithScratch = [...five, e('F', '1/5', { scratched: true })];
check('six ENTERED with one scratched is a five-horse race: the flag fires on the shortest LIVE line',
  JSON.stringify(favIdx(sixWithScratch)) === '[1]', JSON.stringify(favIdx(sixWithScratch)));
check('...and the scratched horse is never the favorite, despite carrying much the shortest line',
  flagsOf(sixWithScratch)[5].favorite === false);
check('five entered with one scratched is a FOUR-horse race: nothing is flagged',
  favIdx([...five.slice(0, 4), e('E', '6/1', { scratched: true })]).length === 0);

console.log('\nThe favorite itself');

const tied = [e('A', '2/1'), e('B', '2/1'), e('C', '8/1'), e('D', '10/1'), e('E', '6/1')];
check('co-favorites are ALL flagged, not none - a tie must not look identical to "does not qualify"',
  JSON.stringify(favIdx(tied)) === '[0,1]', JSON.stringify(favIdx(tied)));
check('...and the race reports how many', flagRaceEntries(tied).favoriteCount === 2);
check('an even-money favorite beats a 2/1 (the ratio is compared, not the printed string)',
  JSON.stringify(favIdx([e('A', '1/1'), e('B', '2/1'), e('C', '8/1'), e('D', '10/1'), e('E', '6/1')])) === '[0]');
check('a whole-number line ("4") is read as 4/1, not skipped',
  JSON.stringify(favIdx([e('A', '4'), e('B', '9/2'), e('C', '8/1'), e('D', '10/1'), e('E', '6/1')])) === '[0]');
check('a five-horse race with NO morning line at all flags nobody rather than guessing',
  favIdx([e('A', null), e('B', null), e('C', null), e('D', null), e('E', null)]).length === 0);
check('an unpriced horse does not block the favorite among the priced ones',
  JSON.stringify(favIdx([e('A', null), e('B', '2/1'), e('C', '8/1'), e('D', '10/1'), e('E', '6/1')])) === '[1]');

console.log('\nInput shapes - all three the four call sites really pass');

// A raw DB row (snake_case, with the parser-computed decimal), the parse
// preview's parser output (camelCase, with the decimal) and server/replay.js's
// `entriesPayload` (camelCase, morningLine ONLY - no decimal) must agree.
const snake = [
  { trainer: 'A', morning_line: '5/2', morning_line_decimal: 2.5, scratched: 0 },
  { trainer: 'B', morning_line: '2/1', morning_line_decimal: 2, scratched: 0 },
  { trainer: 'C', morning_line: '8/1', morning_line_decimal: 8, scratched: 0 },
  { trainer: 'D', morning_line: '10/1', morning_line_decimal: 10, scratched: 0 },
  { trainer: 'E', morning_line: '6/1', morning_line_decimal: 6, scratched: 0 },
];
const camel = snake.map((r) => ({
  trainer: r.trainer, morningLine: r.morning_line, morningLineDecimal: r.morning_line_decimal, scratched: false,
}));
const replayShape = camel.map(({ morningLineDecimal, ...rest }) => rest);
check('a raw DB row (snake_case, scratched as 0/1) reads correctly',
  JSON.stringify(favIdx(snake)) === '[1]', JSON.stringify(favIdx(snake)));
check('the parser/preview shape (camelCase) reads identically',
  JSON.stringify(favIdx(camel)) === JSON.stringify(favIdx(snake)));
check('replays entriesPayload (morningLine string, NO stored decimal) reads identically - the string fallback',
  JSON.stringify(favIdx(replayShape)) === JSON.stringify(favIdx(snake)));
// A sixth row that is scratched as the INTEGER 1 (which is how SQLite stores
// it) must leave a five-horse field. Asserting the flag still FIRES is the
// stronger direction: were `scratched: 1` read as live, the field would be six
// and the flag would vanish - so an empty result here would be the bug, not
// the pass. (This assertion was written the wrong way round first and the
// check caught it.)
const plusScratchedInt = [...snake, { trainer: 'F', morning_line: '3/1', morning_line_decimal: 3, scratched: 1 }];
check('a scratched: 1 DB row is excluded from the field the same way scratched: true is',
  JSON.stringify(favIdx(plusScratchedInt)) === '[1]', JSON.stringify(favIdx(plusScratchedInt)));
check('...and a sixth LIVE row does remove the flag, proving the previous case is not passing by accident',
  favIdx([...snake, { trainer: 'F', morning_line: '3/1', morning_line_decimal: 3, scratched: 0 }]).length === 0);

console.log('\nThe two flags are independent');

const bafInFive = [e('Bob Baffert(J. Barnes)', '10/1'), e('B', '2/1'), e('C', '8/1'), e('D', '6/1'), e('E', '9/2')];
check('a Baffert longshot in a five-horse field carries BAFFERT without carrying FAV',
  JSON.stringify(bafIdx(bafInFive)) === '[0]' && JSON.stringify(favIdx(bafInFive)) === '[1]');
const bafIsFav = [e('B. Baffert', '4/5'), e('B', '2/1'), e('C', '8/1'), e('D', '6/1'), e('E', '9/2')];
check('a Baffert favorite in a five-horse field carries BOTH on the one row',
  flagsOf(bafIsFav)[0].baffert === true && flagsOf(bafIsFav)[0].favorite === true);
const bafBig = [e('B Baffert', '4/5'), ...Array.from({ length: 8 }, (_, i) => e(`H${i}`, '6/1'))];
check('a Baffert runner in a NINE-horse field still carries BAFFERT - the trainer flag has no field-size condition',
  JSON.stringify(bafIdx(bafBig)) === '[0]' && favIdx(bafBig).length === 0);
const bafScratched = [e('Bob Baffert(J. Barnes)', '4/5', { scratched: true }), e('B', '2/1'), e('C', '8/1'), e('D', '6/1'), e('E', '9/2')];
check('a SCRATCHED Baffert horse keeps the BAFFERT tag (the row is struck through anyway) but is not the favorite',
  flagsOf(bafScratched)[0].baffert === true && flagsOf(bafScratched)[0].favorite === false);
check('...and scratching it drops the field to four, so nobody is the favorite',
  favIdx(bafScratched).length === 0);

console.log('\nNever throws - the contract every shared module here holds');

for (const [label, input] of [['null', null], ['undefined', undefined], ['an empty array', []],
  ['a non-array', 'nonsense'], ['entries with no fields at all', [{}, {}, {}, {}, {}]]]) {
  let threw = false;
  let out = null;
  try { out = flagRaceEntries(input); } catch { threw = true; }
  check(`${label} returns a result rather than throwing`, !threw && out !== null && Array.isArray(out.flags));
}
check('five empty entries produce five unflagged entries, not a crash and not a guessed favorite',
  flagRaceEntries([{}, {}, {}, {}, {}]).flags.every((f) => !f.baffert && !f.favorite));
check('flags are index-aligned with the input array',
  flagRaceEntries(five).flags.length === five.length);

console.log('\nLive board (D236) - the price beside the price it moved from');

// `b(ml, live)` - one runner with both books. Deliberately uses the printed
// STRINGS rather than stored decimals, because that is the harder path: it
// proves `liveDecimal`'s fallback reads the same `morningLineToDecimal` the
// morning line does, so the two prices are comparable by construction.
const b = (ml, live, extra = {}) => ({ trainer: 'T', morning_line: ml, live_odds: live, scratched: false, ...extra });
const boardOf = (rows) => flagRaceEntries(rows).flags;
const pp = (f) => Math.round((f.liveFairProbability - f.mlFairProbability) * 1000) / 10;
const moveOf = (f) => (f.move ? `${f.move.direction}/${f.move.magnitude}` : null);

{
  const rows = [b('5/2', '8/5'), b('3/1', '9/2'), b('8/1', '5/1'), b('20/1', '30/1'), b('6/1', '6/1')];
  const f = boardOf(rows);
  check('live rank orders by the live board, not the line (the 8/1 at 5/1 passes the 6/1)',
    JSON.stringify(f.map((x) => x.liveRank)) === '[1,2,3,5,4]', JSON.stringify(f.map((x) => x.liveRank)));
  // Found by a negative control, not by design: forcing `liveRank` to ignore
  // ties left every assertion above green, because no fixture had one. The
  // live board ties FAR more often than a morning line does - a tote prints in
  // buckets, so two horses at 7/2 in the same race is ordinary.
  {
    const tied = [b('5/2', '7/2'), b('3/1', '7/2'), b('9/2', '6/1'), b('8/1', '5/2')];
    const t = boardOf(tied);
    check('a live-board tie shares the rank and the next rank is skipped: 2, 2, 4, 1',
      JSON.stringify(t.map((x) => x.liveRank)) === '[2,2,4,1]', JSON.stringify(t.map((x) => x.liveRank)));
  }
  check('ML rank is unchanged by the presence of a board',
    JSON.stringify(f.map((x) => x.mlRank)) === '[1,2,4,5,3]', JSON.stringify(f.map((x) => x.mlRank)));
  check('rankDelta is positive for a horse that moved UP the board',
    f[2].rankDelta === 1 && f[4].rankDelta === -1, `${f[2].rankDelta} / ${f[4].rankDelta}`);
  check('each book normalises to exactly 1 over the comparable set',
    Math.abs(f.reduce((a, x) => a + x.mlFairProbability, 0) - 1) < 1e-9
    && Math.abs(f.reduce((a, x) => a + x.liveFairProbability, 0) - 1) < 1e-9);
  check('a hammered FAVORITE is flagged on the points test despite a sub-1.25x ratio',
    moveOf(f[0]) === 'steam/moderate' && f[0].fairRatio < MOVE_THRESHOLDS.moderateRatio
    && pp(f[0]) >= MOVE_THRESHOLDS.moderateDelta * 100,
    `${moveOf(f[0])} ratio ${f[0].fairRatio} pts ${pp(f[0])}`);
  // THE PROPERTY THE WHOLE NORMALISATION EXISTS FOR. A move is a REALLOCATION:
  // if one horse gained share, another lost it. Measured on a real six-horse
  // race while building this, the raw deltas summed to +10.4 points - the gap
  // between a 126% morning-line book and a 136% typed board - so every runner
  // carried a +1.7 offset before anyone moved, and a 4/1 drifting to 7/2 read
  // as "+2.2". This assertion is what stops that coming back.
  check('the deltas across a race sum to ZERO - nobody moves unless someone moved the other way',
    Math.abs(f.reduce((a, x) => a + (x.liveFairProbability - x.mlFairProbability), 0)) < 1e-12,
    String(f.reduce((a, x) => a + (x.liveFairProbability - x.mlFairProbability), 0)));
  check('a drifting second choice is flagged drift/moderate', moveOf(f[1]) === 'drift/moderate', moveOf(f[1]));
  check('a 6/1 that did not move is not flagged', moveOf(f[4]) === null, moveOf(f[4]));
}

{
  // The long end: the ratio test carries it, and the quantisation floor stops
  // it carrying too much. 99/1 -> 60/1 is the same 1.5x+ ratio as 20/1 -> 8/1
  // and is worth 0.7 of a point, which is tote rounding, not an opinion.
  const rows = [b('4/5', '4/5'), b('20/1', '8/1'), b('6/1', '7/1'), b('99/1', '60/1')];
  const f = boardOf(rows);
  check('a longshot steaming 20/1 -> 8/1 is big, on the RATIO test alone (under 10 points)',
    moveOf(f[1]) === 'steam/big' && f[1].fairRatio > 2 && Math.abs(pp(f[1])) < MOVE_THRESHOLDS.bigDelta * 100,
    `${moveOf(f[1])} ratio ${f[1].fairRatio} pts ${pp(f[1])}`);
  check('99/1 -> 60/1 is NOT flagged: a 1.5x ratio worth under a point is quantisation',
    moveOf(f[3]) === null && Math.abs(pp(f[3])) < MOVE_THRESHOLDS.minDelta * 100,
    `${moveOf(f[3])} ${pp(f[3])}`);
}

{
  // THE LOAD-BEARING CASE. Two of five scratch, and the live board prices the
  // three survivors exactly where the line had them RELATIVE TO EACH OTHER.
  // The prices are constructed, not eyeballed: 2/1, 3/1 and 5/1 imply .3333,
  // .25 and .1667, a book of .75, so the same shares over a 1.00 book are
  // .4444, .3333 and .2222 - which are 5/4, 2/1 and 7/2 exactly. Nobody formed
  // a new opinion; the pool simply has three horses in it instead of five.
  // Every raw probability rises by the same third. Normalised, it is nothing,
  // and "nothing" here means zero to twelve decimal places rather than
  // "happened to fall under a threshold".
  const rows = [
    b('2/1', '5/4'), b('3/1', '2/1'), b('5/1', '7/2'),
    b('8/5', null, { scratched: true }), b('9/2', null, { scratched: true }),
  ];
  const f = boardOf(rows);
  check('two scratches do not manufacture a move on the three survivors',
    f.slice(0, 3).every((x) => x.move === null), JSON.stringify(f.slice(0, 3).map(moveOf)));
  check('...because each survivor holds exactly the SAME share of both books',
    f.slice(0, 3).every((x) => Math.abs(x.liveFairProbability - x.mlFairProbability) < 1e-12),
    JSON.stringify(f.slice(0, 3).map((x) => x.liveFairProbability - x.mlFairProbability)));
  check('...and every one of them HAS risen on the raw reading, which is the confound',
    f.slice(0, 3).every((x) => x.liveWinProbability > x.mlWinProbability));
  check('a scratched horse has no live price, no live rank and no move',
    f[3].liveDecimal === null && f[3].liveRank === null && f[3].move === null && f[3].liveWinProbability === null);
  check('the comparable set counts only the three that carry both books',
    flagRaceEntries(rows).comparableCount === 3 && flagRaceEntries(rows).livePricedCount === 3);
}

{
  // A horse priced in only ONE book cannot be compared, and must not be
  // silently reported as unchanged - nor be allowed into either total, which
  // would make the two books sum over different fields.
  const rows = [b('2/1', '2/1'), b('3/1', '3/1'), b('8/1', null), b(null, '9/2')];
  const f = boardOf(rows);
  check('a horse with no live price is comparable-null, not "unchanged"',
    f[2].move === null && f[2].fairRatio === null && f[2].liveFairProbability === null);
  check('a horse with no morning line is comparable-null too, but still ranks live',
    f[3].move === null && f[3].fairRatio === null && f[3].liveRank === 3, String(f[3].liveRank));
  check('it still gets a raw live probability - only the COMPARISON is withheld',
    f[3].liveWinProbability !== null && f[3].mlWinProbability === null);
  check('comparableCount excludes both of them', flagRaceEntries(rows).comparableCount === 2);
}

{
  const rows = [b('7/2', '6/1'), b('9/2', '8/5'), b('5/1', '4/1')];
  const f = boardOf(rows);
  check('newFavorite fires on the horse the crowd promoted to the top of the board',
    f[1].newFavorite === true && f[1].liveRank === 1 && f[1].mlRank === 2);
  check('...and on nobody else, including the horse that WAS the ML favorite',
    f[0].newFavorite === false && f[2].newFavorite === false);
  const stay = [b('2/1', '8/5'), b('3/1', '7/2'), b('5/1', '6/1')];
  check('an unchanged favorite is not a NEW favorite', boardOf(stay)[0].newFavorite === false);
}

{
  // A race with no board at all must be byte-identical to the pre-D236 answer:
  // this is what keeps the ingest preview and the static at-track builder from
  // growing three columns of dashes.
  const rows = [e('A', '2/1'), e('B', '3/1'), e('C', '8/1')];
  const r = flagRaceEntries(rows);
  check('no live prices: every board field is null/false and comparableCount is 0',
    r.comparableCount === 0 && r.livePricedCount === 0
    && r.flags.every((f) => f.liveDecimal === null && f.liveRank === null && f.move === null
      && f.fairRatio === null && f.liveFairProbability === null
      && f.newFavorite === false && f.rankDelta === null));
  check('...and the D223/D224 morning-line readings are untouched by the new block',
    JSON.stringify(r.flags.map((f) => f.mlRank)) === '[1,2,3]' && r.flags[0].mlWinProbability !== null);
  // THE BASIS FALLBACK. With no board there is nothing to compare against, so
  // the share is taken over the morning-line-priced live runners instead. This
  // is what keeps the ML Win% column populated in the ingest preview and the
  // static at-track builder, neither of which has ever seen a live price -
  // without it, rebasing that column on the comparable set would have blanked
  // it everywhere a board does not exist.
  check('ML Win% still resolves with NO board, over the ML-priced live runners, summing to 1',
    r.flags.every((f) => f.mlFairProbability !== null)
    && Math.abs(r.flags.reduce((a, f) => a + f.mlFairProbability, 0) - 1) < 1e-12,
    JSON.stringify(r.flags.map((f) => f.mlFairProbability)));
  check('...and a 2/1 in a 2/1, 3/1, 8/1 field is 48% of that book',
    Math.round(r.flags[0].mlFairProbability * 1000) / 10 === 48, String(r.flags[0].mlFairProbability));
  const one = flagRaceEntries([b('2/1', '8/5'), e('B', '3/1'), e('C', '8/1')]);
  check('ONE priced runner is not a comparable set - a lone horse normalises to 1.0 either way',
    one.comparableCount === 1 && one.flags[0].move === null && one.flags[0].fairRatio === null
    && one.flags[0].liveFairProbability === null);
  check('...and ML Win% falls back to the no-board basis rather than blanking',
    one.flags.every((f) => f.mlFairProbability !== null)
    && Math.abs(one.flags.reduce((a, f) => a + f.mlFairProbability, 0) - 1) < 1e-12);
}

{
  // Thresholds are a stated contract, not an implementation detail: the tag
  // text quotes them and a findings file would cite them.
  check('MOVE_THRESHOLDS is exported with the five stated numbers',
    MOVE_THRESHOLDS.moderateRatio === 1.25 && MOVE_THRESHOLDS.bigRatio === 1.6
    && MOVE_THRESHOLDS.moderateDelta === 0.05 && MOVE_THRESHOLDS.bigDelta === 0.1
    && MOVE_THRESHOLDS.minDelta === 0.01);
}

{
  // camelCase reaches this file too (server/replay.js's `entriesPayload`, the
  // parse preview), and a stored decimal must win over the printed string.
  const camel = flagRaceEntries([
    { morningLine: '2/1', liveOdds: '4/5', scratched: false },
    { morningLine: '3/1', liveOdds: '5/1', scratched: false },
  ]).flags;
  check('camelCase live odds are read', camel[0].liveDecimal === 0.8 && camel[1].liveDecimal === 5);
  const stored = flagRaceEntries([
    { morning_line: '2/1', live_odds: '9/9', live_odds_decimal: 1.5, scratched: false },
    { morning_line: '3/1', live_odds: '5/1', scratched: false },
  ]).flags;
  check('a stored live_odds_decimal wins over the printed string', stored[0].liveDecimal === 1.5);
}

if (failures) {
  console.error(`\ncheck-entry-flags: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-entry-flags: all checks passed');
