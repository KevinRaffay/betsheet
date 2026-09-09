// Verification for shared/parsers/compare.js (M-3).
//
// PURE unit cases against HAND-BUILT synthetic parses first - every code
// path is deliberately engineered into one synthetic baseline/challenger
// pair, which stays even now that a real pair exists, because a synthetic
// case can assert BOTH directions of a code path (a mismatch that SHOULD
// fire and one that SHOULDN'T) in one deliberate fixture; a real day only
// ever shows what that day happened to contain.
//
// D193 (2026-09-09) then closed the fixture gap this file used to note:
// the user supplied a real Equibase HTML page for Del Mar, 2026-09-07,
// matching an already-committed equibase-apify-parseforge fixture for the
// same day - the first genuinely matched track/date pair through both
// registered parsers. That real comparison is asserted below too, against
// numbers independently derived from the real CLI run before being
// hardcoded here (not copied from a first passing run).
//
// Run: npm run check-compare-parsers

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { compareParsedDays } from '../shared/parsers/compare.js';
import { getParser } from '../shared/parsers/registry.js';

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

console.log('\n-- the first genuinely real comparison (Del Mar, 2026-09-07) --');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const htmlParser = getParser('equibase-html');
const apifyParser = getParser('equibase-apify-parseforge');
const realHtml = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'equibase-entries', 'DMR090726USA-EQB.view-source.html'), 'latin1');
const realApify = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'equibase-apify', 'parseforge-dmr-2026-09-07.json'), 'utf8');
const realHtmlParsed = htmlParser.parse(realHtml);
const realApifyParsed = apifyParser.parse(realApify, { trackCode: 'DMR' });
const real = compareParsedDays(realHtmlParsed, realApifyParsed, {
  baselineFieldsNotProvided: htmlParser.fieldsNotProvided,
  challengerFieldsNotProvided: apifyParser.fieldsNotProvided,
});

check('both real parsers agree on all 11 races for the same real day',
  real.raceCountMatch && real.baselineRaceCount === 11 && real.challengerRaceCount === 11);
check('every horse matches by name in both directions - zero missing either way',
  real.perRace.every((r) => r.missingInChallenger.length === 0 && r.missingInBaseline.length === 0));
check('postTime is the one baseline-only field, as expected', real.baselineOnlyFields.length === 1 && real.baselineOnlyFields[0] === 'postTime');

const realFieldCounts = {};
for (const r of real.perRace) {
  for (const m of r.entryMismatches) for (const f of m.mismatches) realFieldCounts[f.field] = (realFieldCounts[f.field] ?? 0) + 1;
}
// Real findings, independently derived from the real CLI run before being
// hardcoded here - not a first-pass copy:
//   weight (3): the source's own page prints weight as TWO tokens with no
//     separator on a footnoted horse ("117 5") - what the Apify parser's
//     "1175" data-quality warning turns out to actually be, not a scraper
//     typo (see shared/parsers/equibase-apify-parseforge.js's own header).
//   medication (73): this Apify capture has none at all (D192's leaner
//     variant) while the real page carries a real code on most entries -
//     a PER-RUN gap correctly NOT masked by fieldsNotProvided (finding 16),
//     now visible as real noise rather than a hypothetical one.
//   morningLine/morningLineDecimal (8 each): every one is a SCRATCHED
//     horse - the HTML parser nulls a scratch's odds, this Apify capture
//     keeps whatever it last saw. Which convention is "right" is a real,
//     open question this comparison exists to surface, not resolve here.
//   claimPrice (20): an optional-claiming horse NOT entered to be claimed
//     - the page prints "$0" for it, this Apify capture reports null.
//     Both encode "not entered," as two different literal values.
check('exactly 3 real weight-token mismatches (the page prints two space-separated numbers, not a typo)',
  realFieldCounts.weight === 3, realFieldCounts.weight);
check('exactly 73 medication mismatches - this capture has none at all, a per-run gap correctly left undiffed as coverage but diffed as value',
  realFieldCounts.medication === 73, realFieldCounts.medication);
check('exactly 8 morningLine and 8 morningLineDecimal mismatches, all on scratched horses',
  realFieldCounts.morningLine === 8 && realFieldCounts.morningLineDecimal === 8);
check('exactly 20 claimPrice mismatches ("$0" vs null for a not-entered-to-claim horse)',
  realFieldCounts.claimPrice === 20, realFieldCounts.claimPrice);
check('no double-space name artifacts on this real day, on either side', real.dataQuality.doubleSpaceNames.length === 0);
check('post-position gaps agree exactly between the two independent sources (races 3, 5, 10 - each a real scratch, not a numbering disagreement)',
  new Set(real.dataQuality.postPositionGaps.map((g) => g.race)).size === 3
  && real.dataQuality.postPositionGaps.every((g) => [3, 5, 10].includes(g.race)));

if (failures) {
  console.error(`\ncheck-compare-parsers: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-compare-parsers: all checks passed');
