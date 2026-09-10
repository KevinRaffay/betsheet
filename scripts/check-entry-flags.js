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
// Run: npm run check-entry-flags

import {
  FAVORITE_FIELD_SIZE, flagRaceEntries, isBaffertEntry,
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

if (failures) {
  console.error(`\ncheck-entry-flags: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-entry-flags: all checks passed');
