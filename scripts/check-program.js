// Verification for server/program-parser.js - exits non-zero on any failure.
// Run: npm run check-program
//
// Same two-layer shape as check-parsers.js: a golden-file diff plus hard
// structural assertions read off the printed program by hand, so
// regenerating the golden cannot bless a regression. The fixture is the
// REAL Del Mar program for Sunday 2026-08-30 (61 pages, 10 races,
// 98 entries, Bottom Line analysis, alphabetical index).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseProgramPdf } from '../server/program-parser.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PDF = path.join(ROOT, 'tests', 'fixtures', 'programs', 'delmar-2026-08-30.pdf');
const GOLDEN = path.join(ROOT, 'tests', 'fixtures', 'programs', 'delmar-2026-08-30.expected.json');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

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

const out = await parseProgramPdf(PDF, { track: 'Del Mar', date: '2026-08-30' });

// --- layer 1: golden ---
const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const diff = firstDiff(out, expected);
check('golden: delmar-2026-08-30.pdf', !diff, diff ?? '');

// --- layer 2: hard assertions, hand-checked against the printed program ---

check('date and track', out.date === '2026-08-30' && out.track === 'DELMAR',
  `${out.date} ${out.track}`);
check('10 races, numbered 1-10',
  out.races.length === 10 && out.races.every((r, i) => r.number === i + 1));
check('98 entries across the card',
  out.races.reduce((a, r) => a + r.entries.length, 0) === 98);

const types = out.warnings.map((w) => w.type).sort().join(',');
check('warnings are exactly the two index renumberings (races 5, 10)',
  types === 'index_renumbered,index_renumbered' &&
  out.warnings.every((w) => [5, 10].includes(w.race)), types);

const entryCounts = out.races.map((r) => r.entries.length);
check('entry counts per race', JSON.stringify(entryCounts) === '[6,13,9,8,11,11,7,10,9,14]',
  JSON.stringify(entryCounts));

check('surfaces', out.races.map((r) => r.surface).join(',') ===
  'DIRT,TURF,DIRT,TURF,DIRT,TURF,DIRT,TURF,DIRT,TURF');
check('distances', out.races.map((r) => r.distance).join('|') ===
  'Seven Furlongs|Five Furlongs|Six Furlongs|One Mile|Six Furlongs|Five Furlongs|One Mile|One Mile|One Mile|One Mile');
check('post times run 2:00PM to 6:45PM',
  out.races[0].postTime === '2:00PM' && out.races[9].postTime === '6:45PM');

// R1: the favorite's full row.
const howie = out.races[0].entries.find((e) => e.horseName === "Howie's Law");
check('R1: Howie\'s Law full row', !!howie &&
  howie.programNumber === '1' && howie.postPosition === 1 &&
  howie.jockey === 'Emisael Jaramillo' && howie.trainer === "Doug F. O'Neill(L. Mora)" &&
  howie.owner === 'Superfecta King Stable or The Del Mar Group' &&
  howie.equipment === 'L' && howie.weight === 121 &&
  howie.morningLine === '4/5' && howie.morningLineDecimal === 0.8 &&
  howie.breeding.startsWith('3y.o. Ch. c (KY) by Tiz the Law') &&
  howie.color === 'Red' && howie.programRank === 1, JSON.stringify(howie));

// The jumbled-column trap: every non-scratched entry must have its own
// jockey, trainer, owner, weight, ML and breeding - a band misassignment
// shows up here as a missing or doubled field.
check('every non-scratched entry has all core fields',
  out.races.every((r) => r.entries.filter((e) => !e.scratched).every((e) =>
    e.horseName && e.jockey && e.trainer && e.owner && e.weight &&
    e.morningLine && e.morningLineDecimal > 0 && e.breeding)));

// R5: the printed scratch with the index renumbered around it.
const r5 = out.races[4];
check('R5: The Chosen Bride printed as program 4, SCRATCHED overlay', (() => {
  const s = r5.entries.find((e) => e.horseName === 'The Chosen Bride');
  return s && s.programNumber === '4' && s.scratched && s.scratchReason === 'scratched in program';
})());
check('R5: Beautiful Dawn keeps her printed program 5',
  r5.entries.find((e) => e.horseName === 'Beautiful Dawn')?.programNumber === '5');

// R7: the stakes-header layout.
const r7 = out.races[6];
check('R7: Torrey Pines stakes header',
  /Torrey Pines Stakes \(Grade III\)/.test(r7.raceType) && r7.purseCents === 150000_00);
const rabeeba = r7.entries.find((e) => e.horseName === 'Rabeeba');
check('R7: Rabeeba row (trainer not polluted by the odds column)',
  rabeeba?.trainer === 'Bob Baffert(J. Barnes)' && rabeeba?.morningLine === '8/5' &&
  rabeeba?.programRank === 1);

// R10: densest layout - explicit P.P. labels, 14 bands, index scratch.
const r10 = out.races[9];
check('R10: all 14 jockeys parsed', r10.entries.filter((e) => e.jockey).length >= 13);
check('R10: American Glory (GB) scratched via program index',
  r10.entries.find((e) => e.horseName === 'American Glory (GB)')?.scratched === true);
check('R10: Single Track Mind (IRE) flagged also-eligible',
  r10.entries.find((e) => e.horseName === 'Single Track Mind (IRE)')?.alsoEligible === true);

// R2: also-eligible trio below the separator.
check('R2: also-eligibles are programs 11-13',
  out.races[1].entries.filter((e) => e.alsoEligible).map((e) => e.programNumber).join(',') === '11,12,13');

// R3: the HISA not-to-be-claimed footnote.
check('R3: Fun to Run entered not to be claimed',
  out.races[2].entries.find((e) => e.horseName === 'Fun to Run')?.notToBeClaimed === true);

// Equipment changes across the card.
const changes = out.races.flatMap((r) => r.entries.filter((e) => e.equipmentChange)
  .map((e) => `${e.horseName}:${e.equipmentChange}`)).sort().join('|');
// Four on this card - including Her Strut, which the Bottom Line itself
// corroborates ("adds blinkers"). The first draft of this check counted
// three by hand and the parser found the fourth.
check('equipment changes: exactly the card\'s four',
  changes === 'Cruisin for Cali:Blinkers Off|Her Strut:Blinkers On|Hothead:Blinkers Off|Waiting For You (GB):Blinkers On', changes);

// Analysis: ranks and the Best Bet.
check('analysis: 10 race paragraphs', out.analysis.length === 10);
check('analysis: R1 picks ranked in mention order',
  JSON.stringify(out.analysis.find((a) => a.race === 1)?.picks) ===
  JSON.stringify(["Howie's Law", "Here's Some More", 'Letmein', "Fumano's Magic"]));
check('best bet: Run With Liberty, race 4, rank 1', (() => {
  const e = out.races[3].entries.find((x) => x.horseName === 'Run With Liberty');
  return e?.bestBet === true && e?.programRank === 1;
})());
check('exactly one best bet on the card',
  out.races.flatMap((r) => r.entries.filter((e) => e.bestBet)).length === 1);

// Index: parsed and cross-checked.
check('index: 98 rows, 2 scratches', out.index.length === 98 &&
  out.index.filter((r) => r.scratched).length === 2);
check('index: spot row (Agency, program 1, race 6)', (() => {
  const row = out.index.find((r) => r.horseName === 'Agency');
  return row && row.programNumber === '1' && row.race === 6 && !row.scratched;
})());

// Expected-track/date verification fires on a mismatch.
const wrong = await parseProgramPdf(PDF, { track: 'Santa Anita', date: '2026-09-01' });
check('wrong expected date -> wrong_date warning',
  wrong.warnings.some((w) => w.type === 'wrong_date'));
check('wrong expected track -> wrong_track warning',
  wrong.warnings.some((w) => w.type === 'wrong_track'));

if (failures) {
  console.error(`\ncheck-program: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-program: all checks passed');
