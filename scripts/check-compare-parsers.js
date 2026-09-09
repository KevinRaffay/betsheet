// Verification for shared/parsers/compare.js (M-3).
//
// PURE unit cases against HAND-BUILT synthetic parses, not real fixtures -
// unlike check-equibase-entries.js / check-equibase-apify-parseforge.js,
// there is no real captured pair of the SAME track/date through both
// registered parsers to diff (docs/requirements/
// multi-parser-entries-ingest.md's own note on this). The diff MACHINERY
// is fully testable without one: every code path below is deliberately
// engineered into the synthetic baseline/challenger pair, then
// scripts/compare-parsers.js is exercised separately against the real
// fixture directories to prove the orchestration (file discovery, honest
// "parser unavailable" reporting) end to end.
//
// Run: npm run check-compare-parsers

import { compareParsedDays } from '../shared/parsers/compare.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

// Race 1 exists on both sides, engineered to hit every per-race/per-entry
// path at once; race 2 exists ONLY in the challenger, to exercise the
// race-count mismatch and inBaseline/inChallenger flags.
const baseline = {
  races: [{
    number: 1, postTime: '1:00 PM', distance: 'Six Furlongs', surface: 'Dirt',
    raceType: 'CLAIMING', wagerMenu: 'Exacta', conditions: 'test', claimingPriceCents: 500000,
    entries: [
      // postPosition/weight as STRINGS here, deliberately - the real HTML
      // parser prints them that way ("1", "124"), while the real Apify
      // parser gives numbers. Horse A's postPosition ("1" vs 1) must NOT
      // be flagged as a mismatch once matched by name, or valuesEqual's
      // type-coercion fix has regressed.
      { programNumber: '1', postPosition: '1', horseName: 'Horse A', jockey: 'J Smith', trainer: 'T One', weight: 120, morningLine: '5/1', morningLineDecimal: 5, medication: null, ageSex: '4/G', claimPrice: '$25,000', scratched: false },
      { programNumber: '2', postPosition: '2', horseName: 'Horse B', jockey: 'J Jones', trainer: 'T Two', weight: 118, morningLine: '3/1', morningLineDecimal: 3, medication: null, ageSex: '5/F', claimPrice: null, scratched: false },
      { programNumber: '3', postPosition: '3', horseName: 'Horse C', jockey: null, trainer: null, weight: null, morningLine: '10/1', morningLineDecimal: 10, medication: null, ageSex: null, claimPrice: null, scratched: true },
    ],
  }],
};

const challenger = {
  races: [
    {
      number: 1, postTime: null, distance: 'Six And A Half Furlongs', surface: 'Dirt',
      raceType: 'CLAIMING', wagerMenu: 'Exacta', conditions: 'test', claimingPriceCents: 500000,
      entries: [
        // Horse A: a jockey double-space artifact AND a real weight mismatch.
        { programNumber: '1', postPosition: 1, horseName: 'Horse A', jockey: 'J  Smith', trainer: 'T One', weight: 121, morningLine: '5/1', morningLineDecimal: 5, medication: 'L', ageSex: '4/G', claimPrice: '$25,000', scratched: false },
        // Horse B is entirely absent -> missingInChallenger.
        // Horse C: same program number, but the challenger disagrees on
        // scratched status and fills in fields the baseline left null.
        { programNumber: '3', postPosition: 3, horseName: 'Horse C', jockey: 'J Rider', trainer: 'T Curly', weight: 119, morningLine: '9/1', morningLineDecimal: 9, medication: 'L', ageSex: '6/G', claimPrice: null, scratched: false },
        // Horse D is new -> missingInBaseline, and its post position (4)
        // leaves a gap at 2 once Horse B's absence removes that position.
        { programNumber: '4', postPosition: 4, horseName: 'Horse D', jockey: 'J New', trainer: 'T Three', weight: 115, morningLine: '8/1', morningLineDecimal: 8, medication: null, ageSex: '3/F', claimPrice: null, scratched: false },
      ],
    },
    // A whole race the baseline never saw.
    {
      number: 2, postTime: null, distance: 'One Mile', surface: 'Turf',
      raceType: 'MAIDEN', wagerMenu: null, conditions: null, claimingPriceCents: null,
      entries: [{ programNumber: '1', postPosition: 1, horseName: 'Horse E', jockey: 'J Only', trainer: 'T Only', weight: 116, morningLine: '2/1', morningLineDecimal: 2, medication: null, ageSex: '3/F', claimPrice: null, scratched: false }],
    },
  ],
};

const result = compareParsedDays(baseline, challenger, {
  baselineFieldsNotProvided: ['medication'],
  challengerFieldsNotProvided: ['postTime'],
});

console.log('-- race-level shape --');
check('race count mismatch is reported (1 baseline vs 2 challenger)',
  result.baselineRaceCount === 1 && result.challengerRaceCount === 2 && result.raceCountMatch === false);
check('finds both race numbers', result.perRace.map((r) => r.number).join(',') === '1,2');
const race1 = result.perRace.find((r) => r.number === 1);
const race2 = result.perRace.find((r) => r.number === 2);
check('race 2 exists only in the challenger', race2.inBaseline === false && race2.inChallenger === true);
check('race 2 has no entry-count comparison (no baseline side to compare against)', race2.entryCountMatch === null);

console.log('\n-- field coverage classification --');
check('postTime lands in baselineOnlyFields (challenger structurally lacks it)', result.baselineOnlyFields.includes('postTime'));
check('medication lands in challengerOnlyFields (the scope\'s "additive value" case)', result.challengerOnlyFields.includes('medication'));
check('a field neither side lacks is not misclassified into either list',
  !result.baselineOnlyFields.includes('jockey') && !result.challengerOnlyFields.includes('jockey'));

console.log('\n-- race-level field mismatch (both sides claim it, values disagree) --');
check('distance mismatch is flagged, since both sides claim to provide it',
  race1.raceFieldMismatches.some((m) => m.field === 'distance' && m.baseline === 'Six Furlongs' && m.challenger === 'Six And A Half Furlongs'));
check('postTime disagreement is NOT flagged as a mismatch (it is a coverage gap, reported separately)',
  !race1.raceFieldMismatches.some((m) => m.field === 'postTime'));

console.log('\n-- entry matching by name, not program number --');
check('Horse A is matched and its real field mismatches are found (weight, not just cosmetic)',
  race1.entryMismatches.find((m) => m.horseName === 'Horse A')?.mismatches.some((f) => f.field === 'weight' && f.baseline === 120 && f.challenger === 121));
check('Horse A\'s postPosition ("1" string vs 1 number) is NOT flagged - same value, different type, found live comparing real parser output',
  !race1.entryMismatches.find((m) => m.horseName === 'Horse A')?.mismatches.some((f) => f.field === 'postPosition'));
check('Horse C is matched by name despite disagreeing scratched status, and the disagreement is flagged',
  race1.entryMismatches.find((m) => m.horseName === 'Horse C')?.mismatches.some((f) => f.field === 'scratched' && f.baseline === true && f.challenger === false));
check('Horse B (present only in baseline) is reported missing in the challenger', race1.missingInChallenger.includes('Horse B'));
check('Horse D (present only in challenger) is reported missing in the baseline', race1.missingInBaseline.includes('Horse D'));
check('medication is never diffed as a per-entry mismatch (baseline cannot provide it)',
  !race1.entryMismatches.some((m) => m.mismatches.some((f) => f.field === 'medication')));

console.log('\n-- data-quality checks (generalised from the inherited scope\'s getascraper-specific examples) --');
check('a post-position gap on the challenger side is caught (1, 3, 4 - missing 2)',
  result.dataQuality.postPositionGaps.some((g) => g.side === 'challenger' && g.race === 1));
check('no post-position gap is reported on the baseline side ("1","2","3" as strings is still contiguous once coerced)',
  !result.dataQuality.postPositionGaps.some((g) => g.side === 'baseline' && g.race === 1));
check('a double-space jockey name is caught on the challenger side',
  result.dataQuality.doubleSpaceNames.some((h) => h.side === 'challenger' && h.horseName === 'Horse A' && h.field === 'jockey' && h.value === 'J  Smith'));
check('no double-space names are falsely reported on the clean baseline side',
  !result.dataQuality.doubleSpaceNames.some((h) => h.side === 'baseline'));

console.log('\n-- symmetry sanity check: swapping baseline and challenger inverts the same findings --');
const swapped = compareParsedDays(challenger, baseline, {
  baselineFieldsNotProvided: ['postTime'], challengerFieldsNotProvided: ['medication'],
});
const swappedRace1 = swapped.perRace.find((r) => r.number === 1);
check('missing-in-baseline/missing-in-challenger invert correctly when the roles swap',
  swappedRace1.missingInChallenger.includes('Horse D') && swappedRace1.missingInBaseline.includes('Horse B'));

if (failures) {
  console.error(`\ncheck-compare-parsers: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-compare-parsers: all checks passed');
