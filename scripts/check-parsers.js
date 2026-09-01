// Verification for the parsers - exits non-zero on any failure.
// Run: npm run check-parsers
//
// Two layers, on purpose:
//   1. Golden files: every tests/fixtures/entries/X.txt is parsed and
//      deep-compared against X.expected.json. Regenerate a golden ONLY
//      after auditing the new output by hand against the source text.
//   2. Hard structural assertions on the REAL fixture, independent of the
//      golden file - so regenerating a golden after a parser regression
//      cannot silently bless wrong output. These numbers were read off the
//      dmtc.com entries page by hand (Del Mar, Thursday 2026-09-03).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseEntries, morningLineToDecimal } from '../shared/entries-parser.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'entries');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

// --- layer 1: golden files ---

// Where the first difference between two JSON-compatible values lives.
function firstDiff(a, b, at = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

for (const f of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.txt')).sort()) {
  const expectedPath = path.join(FIXTURES, f.replace(/\.txt$/, '.expected.json'));
  if (!fs.existsSync(expectedPath)) {
    check(`golden exists for ${f}`, false, `missing ${path.basename(expectedPath)}`);
    continue;
  }
  const parsed = parseEntries(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const diff = firstDiff(parsed, expected);
  check(`golden: ${f}`, !diff, diff ?? '');
}

// --- layer 2: hard assertions on the real Del Mar fixture ---

const real = parseEntries(
  fs.readFileSync(path.join(FIXTURES, 'dmtc-2026-09-03.txt'), 'utf8'),
);

check('real: track and date', real.track === 'Del Mar' && real.date === '2026-09-03',
  `${real.track} ${real.date}`);
check('real: zero warnings on a clean card', real.warnings.length === 0,
  JSON.stringify(real.warnings));
check('real: 8 races, numbered 1-8',
  real.races.length === 8 && real.races.every((r, i) => r.number === i + 1));

const counts = real.races.map((r) => r.entries.length);
check('real: entry counts per race', JSON.stringify(counts) === '[5,9,14,9,8,14,10,12]',
  JSON.stringify(counts));

const r1 = real.races[0];
check('real: R1 header',
  r1.surface === 'TURF' && r1.distance === '5 FURLONGS' &&
  r1.raceType === 'ALLOWANCE OPTIONAL CLAIMING' && r1.purseCents === 84000_00 &&
  r1.postTime === '2:00PM' && r1.claimingPriceCents === 100000_00);
check('real: R1 favorite', (() => {
  const e = r1.entries.find((x) => x.horseName === "Bit's Tiger Magic");
  return e && e.programNumber === '4' && e.jockey === 'J. Hernandez' &&
    e.trainer === 'P. Miller' && e.weight === 122 &&
    e.morningLine === '8/5' && e.morningLineDecimal === 1.6;
})());

const r3 = real.races[2];
check('real: R3 scratch has reason from SCRATCHED footer', (() => {
  const s = r3.entries.find((x) => x.horseName === 'Charmz Away');
  return s && s.scratched && s.programNumber === null &&
    s.scratchReason === 'Reason Unavailable' && r3.scratches.length === 1;
})());
check('real: R3 also-eligibles flagged',
  r3.entries.filter((x) => x.alsoEligible).map((x) => x.horseName).join(',') ===
  'Zenjin,Low Tox,Rand Good');
check('real: R3 empty equipment parses as null with columns intact', (() => {
  const e = r3.entries.find((x) => x.horseName === 'Rand Good');
  return e && e.equipment === null && e.weight === 121 && e.morningLine === '30/1' &&
    e.postPosition === 14; // the card's own pp gap - real data, kept verbatim
})());

const r5 = real.races[4];
check('real: R5 has no claiming price', r5.claimingPriceCents === null);

const r6 = real.races[5];
check('real: R6 mid-card scratch leaves pgm 6 absent', (() => {
  const pgms = r6.entries.map((x) => x.programNumber);
  return !pgms.includes('6') && pgms.includes('5') && pgms.includes('7') &&
    r6.entries.find((x) => x.horseName === 'Catalina Cocktail')?.scratched === true;
})());

check('real: every non-scratched entry has jockey, trainer, weight and ML',
  real.races.every((r) => r.entries.filter((e) => !e.scratched).every(
    (e) => e.jockey && e.trainer && e.weight && e.morningLine && e.morningLineDecimal > 0,
  )));

check('real: every race has a wager menu', real.races.every((r) => r.wagerMenu));

// --- synthetic fixture behaviors ---

const syn = parseEntries(
  fs.readFileSync(path.join(FIXTURES, 'synthetic-coupled.txt'), 'utf8'),
);
check('synthetic: coupled entry 1A parses', (() => {
  const e = syn.races[0]?.entries.find((x) => x.programNumber === '1A');
  return e && e.horseName === 'Coupled Mate' && e.postPosition === 2;
})());
check('synthetic: space-separated stats line falls back cleanly', (() => {
  const e = syn.races[0]?.entries.find((x) => x.horseName === 'Loose Spacing');
  return e && e.jockey === 'D. Jockey' && e.trainer === 'E. Trainer' &&
    e.weight === 122 && e.morningLineDecimal === 1.8;
})());

// --- unit checks and degenerate input ---

check('morningLineToDecimal table',
  morningLineToDecimal('5/2') === 2.5 && morningLineToDecimal('8/5') === 1.6 &&
  morningLineToDecimal('15/1') === 15 && morningLineToDecimal('15') === 15 &&
  morningLineToDecimal('-') === null &&
  morningLineToDecimal('') === null && morningLineToDecimal('abc') === null);

const empty = parseEntries('');
check('empty input: warns, never throws',
  empty.races.length === 0 && empty.warnings.some((w) => w.type === 'no_races'));

const garbage = parseEntries('Race 1\nnot a header\nmore noise\n');
check('garbage race block: reports warnings instead of fabricating entries',
  garbage.races.length === 1 && garbage.races[0].entries.length === 0 &&
  garbage.warnings.some((w) => w.type === 'empty_race'));

if (failures) {
  console.error(`\ncheck-parsers: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-parsers: all checks passed');
