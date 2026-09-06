// Verification for the Equibase entries HTML parser (D104).
//
// PURE - no server, no database, so a parser break reports as a parser break.
//
// Follows scripts/check-parsers.js's rule: a golden-file diff PLUS independent
// hand-counted assertions on the real fixture. The golden alone is not enough,
// because regenerating it would bless whatever the parser currently does; the
// hand counts come from reading the page, so they catch a regression the
// golden would happily absorb.
//
// Regenerate the golden deliberately:
//   node scripts/check-equibase-entries.js --write-golden
//
// Run: npm run check-equibase-entries

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseEquibaseEntriesHtml, unwrapViewSource } from '../shared/parsers/equibase-entries.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIR = path.join(ROOT, 'tests', 'fixtures', 'equibase-entries');
const FIXTURE = path.join(DIR, 'DMR090626USA-EQB.view-source.html');
const GOLDEN = path.join(DIR, 'DMR090626USA-EQB.expected.json');
const writeGolden = process.argv.slice(2).includes('--write-golden');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

// Equibase serves windows-1252; reading as latin1 keeps every byte addressable
// and the parser's entity handling does the rest.
const html = fs.readFileSync(FIXTURE, 'latin1');

console.log('-- the saved view-source wrapper --');
const unwrapped = unwrapViewSource(html);
check('a view-source save unwraps to the original markup',
  unwrapped.includes('<!DOCTYPE html>') && unwrapped.length > 900000, `${unwrapped.length} chars`);
check('unwrapping is a no-op on markup that was never wrapped',
  unwrapVerbatim('<html><body>hi</body></html>') === '<html><body>hi</body></html>');
function unwrapVerbatim(s) { return unwrapViewSource(s); }

console.log('\n-- the page --');
const out = parseEquibaseEntriesHtml(html);
check('track reads Del Mar', out.track === 'Del Mar', out.track);
check('date is normalised to ISO', out.date === '2026-09-06', out.date);
check('the printed date is kept alongside it', out.printedDate === 'September 6, 2026', out.printedDate);
check('11 races', out.races.length === 11, String(out.races.length));
check('no warnings at all on a clean page', out.warnings.length === 0,
  JSON.stringify(out.warnings.map((w) => w.type)));

console.log('\n-- post times (hand-read off the page) --');
const POSTS = ['1:30 PM', '2:05 PM', '2:38 PM', '3:11 PM', '3:44 PM', '4:14 PM',
  '4:44 PM', '5:14 PM', '5:44 PM', '6:14 PM', '6:44 PM'];
check('all 11 post times, in race order',
  JSON.stringify(out.races.map((r) => r.postTime)) === JSON.stringify(POSTS),
  JSON.stringify(out.races.map((r) => r.postTime)));

console.log('\n-- entry counts --');
// 116 table rows minus the three "Also Eligibles:" separators = 113 entries.
const total = out.races.reduce((a, r) => a + r.entries.length, 0);
check('113 entries across the card', total === 113, String(total));
check('per-race counts match the page',
  JSON.stringify(out.races.map((r) => r.entries.length)) === JSON.stringify([10, 8, 14, 5, 12, 9, 11, 8, 9, 14, 13]),
  JSON.stringify(out.races.map((r) => r.entries.length)));

console.log('\n-- race 1, field by field --');
const r1e1 = out.races[0].entries[0];
check('program number, post position and horse', r1e1.programNumber === '1' && r1e1.postPosition === '1'
  && r1e1.horseName === 'Broheim (KY)', JSON.stringify(r1e1));
check('the state suffix stays attached to the name', r1e1.horseName.endsWith('(KY)'));
check('age/sex, medication, jockey, weight, trainer',
  r1e1.ageSex === '5/G' && r1e1.medication === 'L' && r1e1.jockey === 'J J Hernandez'
  && r1e1.weight === '124' && r1e1.trainer === 'M W McCarthy', JSON.stringify(r1e1));
check('morning line, as text and as a decimal',
  r1e1.morningLine === '6/1' && r1e1.morningLineDecimal === 6);
check('an 11-column race carries no claim price', r1e1.claimPrice === null);

console.log('\n-- THE REGRESSION THAT MATTERS: 12-column claiming races --');
// A claiming race inserts `Claim $`. Reading a fixed index would put the claim
// price in `jockey` and slide M/L into `liveOdds` - which is exactly the error
// made while first analysing this file. Columns come from each race's header.
check('races 3, 6 and 7 are 12-column; the rest are 11',
  JSON.stringify(out.races.map((r) => r.columnCount)) === JSON.stringify([11, 11, 12, 11, 11, 12, 12, 11, 11, 11, 11]),
  JSON.stringify(out.races.map((r) => r.columnCount)));
const r3e1 = out.races[2].entries[0];
check('the claim price lands in claimPrice, not jockey', r3e1.claimPrice === '$22,500', JSON.stringify(r3e1));
check('the jockey is still the jockey', r3e1.jockey === 'T J Pereira', r3e1.jockey);
check('M/L is M/L and did NOT slide into liveOdds',
  r3e1.morningLine === '30/1' && r3e1.liveOdds === null, JSON.stringify({ ml: r3e1.morningLine, live: r3e1.liveOdds }));
check('every 12-column race keeps a claim price on its live entries',
  [2, 5, 6].every((i) => out.races[i].entries.filter((e) => !e.scratched).every((e) => e.claimPrice)));

console.log('\n-- scratches (by row shape, not column index) --');
const scratched = out.races.flatMap((r) => r.entries.filter((e) => e.scratched).map((e) => `${r.number}:${e.horseName}`));
check('exactly 3, in races 3, 5 and 7',
  JSON.stringify(scratched) === JSON.stringify(['3:King of Clubs (KY)', '5:Cuban Flame (FR)', '7:Miso Phansy (CA)']),
  JSON.stringify(scratched));
check('a scratched horse is retained, not dropped',
  out.races[2].entries.some((e) => e.horseName === 'King of Clubs (KY)'));
check('scratches are excluded from the active count',
  out.races[2].activeEntries === out.races[2].entries.length - 1
  && out.races[4].activeEntries === out.races[4].entries.length - 1);
check('a scratch carries no effective odds', out.races.flatMap((r) => r.entries)
  .filter((e) => e.scratched).every((e) => e.effectiveOdds === null));
check('the dashed Scratched bar never becomes a horse name',
  !out.races.flatMap((r) => r.entries).some((e) => /Scratched/i.test(e.horseName)));

console.log('\n-- also-eligibles are a separator, never an entry --');
check('no entry is named "Also Eligibles:"',
  !out.races.flatMap((r) => r.entries).some((e) => /also eligible/i.test(e.horseName)));
check('races 3, 10 and 11 flag their AEs',
  JSON.stringify(out.races.filter((r) => r.entries.some((e) => e.alsoEligible)).map((r) => r.number))
  === JSON.stringify([3, 10, 11]));

console.log('\n-- odds fallback (this capture has no live odds at all) --');
const all = out.races.flatMap((r) => r.entries);
check('live odds are empty in all 113 entries - the capture predates wagering',
  all.every((e) => e.liveOdds === null));
check('effective odds therefore fall back to the morning line',
  all.filter((e) => !e.scratched).every((e) => e.effectiveOdds === e.morningLine));
check('effective odds are also exposed as a decimal',
  r1e1.effectiveOddsDecimal === 6 && r3e1.effectiveOddsDecimal === 30);

console.log('\n-- UI cruft never reaches a field --');
const blob = JSON.stringify(out);
check('"See More See Less" appears nowhere in the output', !/See More See Less/.test(blob));
check('"Jump to Race" appears nowhere in the output', !/Jump to Race/.test(blob));
check('no HTML entity survives into a value', !/&(?:nbsp|amp|ndash|quot|#\d+);/.test(blob),
  (blob.match(/&(?:nbsp|amp|ndash|quot|#\d+);/g) || []).slice(0, 3).join(' '));

console.log('\n-- race metadata --');
check('purse, distance and surface come off the header block',
  out.races[0].purseCents === 4100000 && /Five Furlongs/.test(out.races[0].distance ?? '')
  && out.races[0].surface === 'Turf',
  JSON.stringify({ p: out.races[0].purseCents, d: out.races[0].distance, s: out.races[0].surface }));

console.log('\n-- never throws --');
for (const junk of ['', '<html></html>', 'not html at all', '<table class="fullwidth"></table>']) {
  const r = parseEquibaseEntriesHtml(junk);
  check(`survives ${JSON.stringify(junk.slice(0, 24))} with warnings, not an exception`,
    Array.isArray(r.races) && r.warnings.some((w) => w.blocking));
}

console.log('\n-- golden --');
if (writeGolden) {
  fs.writeFileSync(GOLDEN, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`  wrote ${path.relative(ROOT, GOLDEN)} - audit the diff before committing it`);
} else if (!fs.existsSync(GOLDEN)) {
  check('golden exists', false, 'run with --write-golden and audit it');
} else {
  const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  check('parse matches the audited golden exactly',
    JSON.stringify(out) === JSON.stringify(expected),
    'run --write-golden and read the diff before accepting it');
}

if (failures) {
  console.error(`\ncheck-equibase-entries: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-equibase-entries: all checks passed');
