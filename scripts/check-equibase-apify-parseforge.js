// Verification for the equibase-apify-parseforge adapter (M-1's registry,
// second entry) - shared/parsers/equibase-apify-parseforge.js.
//
// PURE - no server, no database, so a parser break reports as a parser
// break. Follows the same rule check-equibase-entries.js does: a golden-file
// diff PLUS independent hand-counted assertions on the real fixture, so
// regenerating the golden cannot bless a regression - the hand counts come
// from reading the fixture directly (node -e against the raw JSON, not the
// parser), not from trusting whatever the parser currently outputs.
//
// Regenerate the golden deliberately:
//   node scripts/check-equibase-apify-parseforge.js --write-golden
//
// Run: npm run check-equibase-apify-parseforge

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseApifyParseforgeDataset, apifyParseforgeToPayload } from '../shared/parsers/equibase-apify-parseforge.js';
import { morningLineToDecimal } from '../shared/betmath.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIR = path.join(ROOT, 'tests', 'fixtures', 'equibase-apify');
const FIXTURE = path.join(DIR, 'parseforge-ind-kd-2026-09-09.json');
const GOLDEN_IND = path.join(DIR, 'parseforge-ind-2026-09-09.expected.json');
const GOLDEN_KD = path.join(DIR, 'parseforge-kd-2026-09-09.expected.json');
const writeGolden = process.argv.slice(2).includes('--write-golden');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

const raw = fs.readFileSync(FIXTURE, 'utf8');

console.log('-- a file spanning multiple tracks, no context given --');
const ambiguous = parseApifyParseforgeDataset(raw);
check('refuses rather than guessing which track', ambiguous.track === null && ambiguous.date === null);
check('names every track actually present',
  JSON.stringify(ambiguous.warnings[0]?.tracks?.sort()) === JSON.stringify(['IND', 'KD']));
check('the refusal is blocking', ambiguous.warnings[0]?.blocking === true);

console.log('\n-- an unknown track code --');
const unknown = parseApifyParseforgeDataset(raw, { trackCode: 'ZZZ' });
check('refuses rather than returning an empty card',
  unknown.track === null && unknown.warnings[0]?.type === 'track_not_in_file');

console.log('\n-- Horseshoe Indianapolis (IND) --');
const ind = parseApifyParseforgeDataset(raw, { trackCode: 'IND' });
check('track name reads through from the source', ind.track === 'Horseshoe Indianapolis', ind.track);
check('date reads through unmodified', ind.date === '2026-09-09', ind.date);
check('finds all 9 races', ind.races.length === 9, ind.races.length);
check('race numbers are 1..9 in order', JSON.stringify(ind.races.map((r) => r.number)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]));

// Hand-counted directly from the raw JSON (node -e against the file, not
// the parser) - entries and scratches per race, and total row count as an
// independent cross-check.
const EXPECTED_IND = { 1: [7, 0], 2: [7, 1], 3: [6, 1], 4: [11, 3], 5: [7, 1], 6: [12, 2], 7: [10, 1], 8: [11, 1], 9: [10, 2] };
for (const race of ind.races) {
  const [entries, scratches] = EXPECTED_IND[race.number];
  check(`IND race ${race.number} has ${entries} entries`, race.entries.length === entries, race.entries.length);
  check(`IND race ${race.number} has ${scratches} scratch(es)`,
    race.entries.filter((e) => e.scratched).length === scratches);
}
check('IND total entries across all races is 81 (100 rows - 19 KD rows: 14 + 5)',
  ind.races.reduce((a, r) => a + r.entries.length, 0) === 81);

console.log('\n-- Kentucky Downs (KD), the second track in the same file --');
const kd = parseApifyParseforgeDataset(raw, { trackCode: 'KD' });
check('track name reads through from the source', kd.track === 'Kentucky Downs', kd.track);
check('finds both races', kd.races.length === 2 && kd.races[0].number === 1 && kd.races[1].number === 2);
check('KD race 1 has 14 entries, 2 scratches',
  kd.races[0].entries.length === 14 && kd.races[0].entries.filter((e) => e.scratched).length === 2);
check('KD race 2 has 5 entries, 0 scratches',
  kd.races[1].entries.length === 5 && kd.races[1].entries.filter((e) => e.scratched).length === 0);

console.log('\n-- the morning-line-decimal fix (load-bearing) --');
// The fixture's own morningLineDecimal for "7/5" is 2.4 (European decimal
// odds, fraction + 1). This codebase's own morningLineToDecimal returns the
// ratio alone (1.4). Asserting against the SHARED function, not a literal,
// so this check breaks the moment betmath.js's convention ever changes too.
const e1 = ind.races[0].entries.find((e) => e.horseName?.startsWith('Sweet Scorecard'));
check('the fixture really does carry the European-decimal trap (sanity check on the raw file)',
  JSON.parse(raw).find((r) => r.horse === 'Sweet Scorecard')?.morningLineDecimal === 2.4);
check('the parser recomputed 1.4, not the source\'s own 2.4',
  e1?.morningLineDecimal === 1.4 && e1?.morningLineDecimal === morningLineToDecimal('7/5'));

console.log('\n-- horse name and age/sex composition --');
check('horse name carries the state suffix, matching the HTML parser\'s own convention',
  e1?.horseName === 'Sweet Scorecard (KY)');
check('age/sex composes to the HTML parser\'s "N/S" convention', e1?.ageSex === '4/F');
check('a scratch has no age/sex, no program number, no post position',
  ind.races[1].entries.find((e) => e.scratched).ageSex === null
  && ind.races[1].entries.find((e) => e.scratched).programNumber === null
  && ind.races[1].entries.find((e) => e.scratched).postPosition === null);

console.log('\n-- claim price, "as printed" like every other parser --');
const claimedEntry = ind.races[1].entries.find((e) => e.horseName?.startsWith('Bourbon Curiosity'));
check('an entered-to-be-claimed horse gets a dollar string, not a bare number',
  claimedEntry?.claimPrice === '$40,000', claimedEntry?.claimPrice);
check('race-level claiming price converts straight to cents (no per-entry aggregation needed - unlike the HTML adapter, this source already gives a clean race-level figure)',
  ind.races[1].claimingPriceCents === 4000000);
check('a non-claiming race (KD race 1, MAIDEN SPECIAL WEIGHT) has no claiming price',
  kd.races[0].raceType === 'MAIDEN SPECIAL WEIGHT' && kd.races[0].claimingPriceCents === null);

console.log('\n-- data-quality glitches this real fixture actually contains --');
const weightWarnings = ind.warnings.filter((w) => w.type === 'implausible_weight');
check('flags exactly the 3 real weight: 1137 rows, non-blocking',
  weightWarnings.length === 3 && weightWarnings.every((w) => w.blocking === false && w.weight === 1137),
  JSON.stringify(weightWarnings));

console.log('\n-- fields this source structurally never carries (declared on the registry entry, not returned per-call) --');
check('post time is always null (this source never prints one)', ind.races.every((r) => r.postTime === null));
check('live odds are always null on every entry', ind.races.every((r) => r.entries.every((e) => e.liveOdds === null && e.liveOddsDecimal === null)));
check('also-eligible is always false (no field for it in this source)', ind.races.every((r) => r.entries.every((e) => e.alsoEligible === false)));

console.log('\n-- not wired to any save path, deliberately --');
let threw = false;
try { apifyParseforgeToPayload(ind, new Date().toISOString(), new Set()); } catch { threw = true; }
check('toPayload refuses rather than silently mislabeling entries_source', threw);

console.log('\n-- malformed input never throws (the same contract every parser here holds) --');
check('non-JSON input returns a blocking warning, not an exception',
  parseApifyParseforgeDataset('not json at all').warnings[0]?.type === 'invalid_json');
check('a JSON object (not an array) is refused the same way',
  parseApifyParseforgeDataset('{}').warnings[0]?.type === 'not_an_array');
check('an empty array is refused as no races', parseApifyParseforgeDataset('[]').warnings[0]?.type === 'no_races');

console.log('\n-- golden --');
if (writeGolden) {
  fs.writeFileSync(GOLDEN_IND, `${JSON.stringify(ind, null, 2)}\n`);
  fs.writeFileSync(GOLDEN_KD, `${JSON.stringify(kd, null, 2)}\n`);
  console.log(`  wrote ${path.relative(ROOT, GOLDEN_IND)} and ${path.relative(ROOT, GOLDEN_KD)} - audit the diff before committing`);
} else if (!fs.existsSync(GOLDEN_IND) || !fs.existsSync(GOLDEN_KD)) {
  check('goldens exist', false, 'run with --write-golden and audit them');
} else {
  const expectedInd = JSON.parse(fs.readFileSync(GOLDEN_IND, 'utf8'));
  const expectedKd = JSON.parse(fs.readFileSync(GOLDEN_KD, 'utf8'));
  check('IND parse matches the audited golden exactly', JSON.stringify(ind) === JSON.stringify(expectedInd));
  check('KD parse matches the audited golden exactly', JSON.stringify(kd) === JSON.stringify(expectedKd));
}

if (failures) {
  console.error(`\ncheck-equibase-apify-parseforge: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-equibase-apify-parseforge: all checks passed');
