// Verification for the equibase-apify-results parser (D193, docs/
// requirements/equibase-apify-results-ingest.md) -
// shared/parsers/equibase-apify-results.js.
//
// PURE - no server, no database, so a parser break reports as a parser
// break. Same rule check-equibase-apify-parseforge.js follows: a golden-file
// diff PLUS independent hand-counted assertions on the real fixture, so
// regenerating the golden cannot bless a regression - the hand counts come
// from reading the raw fixture directly (a one-off node -e pass), not from
// trusting whatever the parser currently outputs.
//
// Regenerate the golden deliberately:
//   node scripts/check-equibase-apify-results.js --write-golden
//
// Run: npm run check-equibase-apify-results

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseApifyResultsDataset } from '../shared/parsers/equibase-apify-results.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIR = path.join(ROOT, 'tests', 'fixtures', 'equibase-apify');
const FIXTURE = path.join(DIR, 'apify-results-dmr-2026-09-07.json');
const GOLDEN = path.join(DIR, 'apify-results-dmr-2026-09-07.expected.json');
const writeGolden = process.argv.slice(2).includes('--write-golden');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

const raw = fs.readFileSync(FIXTURE, 'utf8');

console.log('-- Del Mar, 2026-09-07 (no context needed - single track/date) --');
const dmr = parseApifyResultsDataset(raw);
check('track name reads through from the source', dmr.track === 'Del Mar', dmr.track);
check('date reads through unmodified', dmr.date === '2026-09-07', dmr.date);
check('finds all 11 races', dmr.races.length === 11, dmr.races.length);
check('race numbers are 1..11 in order', JSON.stringify(dmr.races.map((r) => r.number)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));

// Hand-counted directly from the raw JSON (node -e against the file, not
// the parser): finisher count per race.
const EXPECTED_FINISHERS = { 1: 10, 2: 12, 3: 9, 4: 9, 5: 8, 6: 7, 7: 12, 8: 10, 9: 10, 10: 11, 11: 8 };
for (const race of dmr.races) {
  check(`race ${race.number} has ${EXPECTED_FINISHERS[race.number]} finishers`,
    race.results.length === EXPECTED_FINISHERS[race.number], race.results.length);
}
check('total finishers across all races is 106',
  dmr.races.reduce((a, r) => a + r.results.length, 0) === 106);

console.log('\n-- finalTime: present for 9 of 11 races, absent for 2 (hand-verified) --');
check('races 3 and 7 have no finalTime',
  dmr.races.find((r) => r.number === 3).finalTime === null
  && dmr.races.find((r) => r.number === 7).finalTime === null);
check('the other 9 races do carry a finalTime',
  dmr.races.filter((r) => r.number !== 3 && r.number !== 7).every((r) => r.finalTime !== null));
check('the two missing races each carry a non-blocking no_final_time warning',
  dmr.warnings.filter((w) => w.type === 'no_final_time').length === 2
  && dmr.warnings.filter((w) => w.type === 'no_final_time').every((w) => w.blocking === false));

console.log('\n-- exoticWagers rides the winner\'s row only, one race-level array per race --');
check('every race has exactly one exotics-bearing source row (hand-counted on the raw file)',
  JSON.parse(raw).filter((r) => Array.isArray(r.exoticWagers)).length === 11);

console.log('\n-- payout cent conversion (per-$2 mutuel prices, same convention as chart-parser\'s money()) --');
const race1Winner = dmr.races.find((r) => r.number === 1).results.find((r) => r.programNumber === '5');
check('winPayoff 11.4 -> 1140 cents', race1Winner?.winCents === 1140, race1Winner?.winCents);
check('placePayoff 5 -> 500 cents', race1Winner?.placeCents === 500, race1Winner?.placeCents);
check('showPayoff 3.2 -> 320 cents', race1Winner?.showCents === 320, race1Winner?.showCents);
const race1Second = dmr.races.find((r) => r.number === 1).results.find((r) => r.programNumber === '10');
check('a placed (not won) finisher has no winCents, only place/show',
  race1Second?.winCents === null && race1Second?.placeCents === 3300 && race1Second?.showCents === 1100);
const race1Last = dmr.races.find((r) => r.number === 1).results.find((r) => r.finishPosition === 10);
check('a finisher with no payoff at all has all three cents null',
  race1Last?.winCents === null && race1Last?.placeCents === null && race1Last?.showCents === null);

console.log('\n-- exotic wager parsing: base cents, bet type, combination (annotation stripped) --');
const race1Exotics = dmr.races.find((r) => r.number === 1).exotics;
check('$1 Exacta 5-10 -> {baseCents:100, betType:exacta, combination:"5-10", payoutCents:15870}',
  JSON.stringify(race1Exotics.find((x) => x.betType === 'exacta'))
  === JSON.stringify({ betType: 'exacta', baseCents: 100, combination: '5-10', payoutCents: 15870 }));
check('$0.10 Superfecta -> baseCents 10, payoutCents 92832',
  JSON.stringify(race1Exotics.find((x) => x.betType === 'superfecta'))
  === JSON.stringify({ betType: 'superfecta', baseCents: 10, combination: '5-10-6-7', payoutCents: 92832 }));

const race5Exotics = dmr.races.find((r) => r.number === 5).exotics;
const pick5 = race5Exotics.find((x) => x.betType === 'pick5');
check('a "(N correct)" annotation is stripped from the combination, multi-winner "/" legs preserved',
  pick5?.combination === '5-12-4-4-1/2/5/6/8', pick5?.combination);
check('the Pick 5 payoff converts correctly at scale (205306.75 -> 20530675 cents)',
  pick5?.payoutCents === 20530675, pick5?.payoutCents);

console.log('\n-- a compound wager-type name not in the known map falls back to a slug, never a guess --');
// Real values in this fixture: "$1 Place Pick All", "$0.50 Consolation Pick 3",
// "$2 Consolation Double" - none are in the known BET_TYPES map (chart-parser.js's
// own map doesn't have them either), so they must fall back the same way.
const allExotics = dmr.races.flatMap((r) => r.exotics);
check('"Place Pick All" -> place_pick_all', allExotics.some((x) => x.betType === 'place_pick_all'));
check('"Consolation Pick 3" -> consolation_pick_3', allExotics.some((x) => x.betType === 'consolation_pick_3'));
check('"Consolation Double" -> consolation_double', allExotics.some((x) => x.betType === 'consolation_double'));
check('a named-pool combo keeps its wrapper, e.g. "TURFPICK3(7-7-10)"',
  allExotics.some((x) => x.combination === 'TURFPICK3(7-7-10)'));
check('a "N OF M" combo (Place Pick All) is preserved as printed',
  allExotics.some((x) => x.combination === '9 OF 10'));

console.log('\n-- scratch derivation (resolved decision: assume scratched) --');
const race1Finishers = ['5', '10', '6', '7', '8', '3', '1', '9', '4', '2'];
const withEntries = parseApifyResultsDataset(raw, {
  entriesByRace: {
    1: [
      ...race1Finishers.map((pgm) => ({ programNumber: pgm, horseName: `finisher ${pgm}` })),
      { programNumber: '11', horseName: 'Never Ran' },
    ],
  },
});
const race1WithEntries = withEntries.races.find((r) => r.number === 1);
check('an entry absent from the finisher list is reported scratched',
  JSON.stringify(race1WithEntries.scratches) === JSON.stringify([{ programNumber: '11', horseName: 'Never Ran' }]));
const race2NoEntries = withEntries.races.find((r) => r.number === 2);
check('a race with no entriesByRace context derives no scratches (not an error, just none derivable)',
  race2NoEntries.scratches.length === 0);
check('without any entriesByRace at all, every race\'s scratches stays empty',
  dmr.races.every((r) => r.scratches.length === 0));

console.log('\n-- track/date/context refusals, mirroring equibase-apify-parseforge.js\'s shape --');
const wrongTrack = parseApifyResultsDataset(raw, { trackCode: 'ZZZ' });
check('an unknown track code refuses rather than returning an empty card',
  wrongTrack.track === null && wrongTrack.warnings[0]?.type === 'track_not_in_file');
check('the right track code works the same as no context at all',
  JSON.stringify(parseApifyResultsDataset(raw, { trackCode: 'DMR' })) === JSON.stringify(dmr));

console.log('\n-- output already matches saveResults\'s p shape, no adapter needed (D195/D196) --');
check('every race carries results/exotics/scratches arrays saveResults reads directly',
  dmr.races.every((r) => Array.isArray(r.results) && Array.isArray(r.exotics) && Array.isArray(r.scratches)));

console.log('\n-- malformed input never throws (the same contract every parser here holds) --');
check('non-JSON input returns a blocking warning, not an exception',
  parseApifyResultsDataset('not json at all').warnings[0]?.type === 'invalid_json');
check('a JSON object (not an array) is refused the same way',
  parseApifyResultsDataset('{}').warnings[0]?.type === 'not_an_array');
check('an empty array is refused as no races', parseApifyResultsDataset('[]').warnings[0]?.type === 'no_races');
check('a file with only entry-mode rows (rowType "entry") is refused as no races, not silently empty',
  parseApifyResultsDataset(JSON.stringify([{ rowType: 'entry', raceNumber: 1 }])).warnings[0]?.type === 'no_races');

console.log('\n-- golden --');
if (writeGolden) {
  fs.writeFileSync(GOLDEN, `${JSON.stringify(dmr, null, 2)}\n`);
  console.log(`  wrote ${path.relative(ROOT, GOLDEN)} - audit the diff before committing`);
} else if (!fs.existsSync(GOLDEN)) {
  check('golden exists', false, 'run with --write-golden and audit it');
} else {
  const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  check('parse matches the audited golden exactly', JSON.stringify(dmr) === JSON.stringify(expected));
}

if (failures) {
  console.error(`\ncheck-equibase-apify-results: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-equibase-apify-results: all checks passed');
