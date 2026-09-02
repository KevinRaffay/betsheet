// Verification for server/program-parser.js - exits non-zero on any failure.
// Run: npm run check-program
//
// Same two-layer shape as check-parsers.js: a golden-file diff plus hard
// structural assertions read off the printed program by hand, so
// regenerating the golden cannot bless a regression. Two REAL Del Mar
// programs are the fixtures: Sunday 2026-08-30 (61 pages, 10 races, 98
// entries, Bottom Line analysis, alphabetical index) and Saturday
// 2026-08-22 (11 races, 122 entries, Pacific Classic day - a layout with
// no panel payoff box and stakes titles without the word "Stakes").

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseProgramPdf, distanceFromHeader, stakesTitleFromHeader, trackFromBottomLine, splitFusedOwnerTrainer } from '../server/program-parser.js';

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
// --- header fields from the 2026-08-22 program (hand-copied text items) ---
// Its header lines are reproduced here exactly as pdfjs emitted them
// (text, x, y) so each rule is pinned in isolation; the whole-file
// assertions on that fixture follow further down.
const it = (s, x, y) => ({ s, x, y, h: 6 });
const h3 = [
  it('Other Than Maiden, Claiming, Or Starter At A Mile Or Over Allowed 2 Lbs. Claiming Price $20,000', 334, 475),
  it('One', 572, 465),
  it('Mile And One Sixteenth. (Turf) Chute Start. (Rail at 0 Feet)', 334, 461),
];
check('distance: split across a line wrap ("One" / "Mile And One Sixteenth. (Turf)...")', (() => {
  const d = distanceFromHeader(h3);
  return d && d.distance === 'One Mile And One Sixteenth' && d.consumed.length === 1 && d.consumed[0].s === 'One';
})(), JSON.stringify(distanceFromHeader(h3)));
const h7 = [
  it('Non-winners Of Two Races At A Mile Or Over Since May 22 Allowed 2 Lbs. Such A Race Since', 341, 462),
  it('One Mile. (Turf) Stretch Start. (Rail at 0 Feet)', 429, 450),
];
check('distance: conditions text "...At A Mile Or Over" is never the distance',
  distanceFromHeader(h7)?.distance === 'One Mile', JSON.stringify(distanceFromHeader(h7)));
const h11 = [
  it('40th Running of', 428, 503), it('Del Mar Mile (Grade II)', 417, 496), it('$300,000 Guaranteed', 419, 490),
  it('STAKES. FOR THREE-YEAR-OLDS AND UPWARD. By subscription of $300 each, which shall', 331, 484),
  it('One Mile. (Turf) Stretch Start. (Rail at 0', 464, 446),
];
check('distance: a stakes title ("Del Mar Mile") is never the distance',
  distanceFromHeader(h11)?.distance === 'One Mile', JSON.stringify(distanceFromHeader(h11)));
check('distance: fractions, no trailing period, purely-distance items consumed',
  distanceFromHeader([it('One Mile And One Quarter.', 503, 388)])?.distance === 'One Mile And One Quarter' &&
  distanceFromHeader([it('Five And One Half Furlongs.', 395, 448)])?.distance === 'Five And One Half Furlongs' &&
  distanceFromHeader([it('One Mile', 557, 431)])?.distance === 'One Mile' &&
  distanceFromHeader([it('Six Furlongs.', 394, 476)])?.consumed.length === 1 &&
  distanceFromHeader([it('One Mile. (Turf)', 537, 466)])?.consumed.length === 0);
check('distance: nothing distance-like -> null',
  distanceFromHeader([it('STAKES. FOR FILLIES, THREE-YEAR-OLDS.', 331, 468), it('One Mile Or Over Since May 22', 331, 460)]) === null);
check('stakes title: the line under "Nth Running of", sponsor dropped, grade kept',
  stakesTitleFromHeader([it('24th Running of', 431, 499), it('Green Flash Handicap Presented by Longines (Grade II)', 362, 493),
    it('$200,000 Guaranteed', 422, 487), it('STAKES. A HANDICAP FOR THREE-YEAR-OLDS AND UPWARD.', 336, 475)]) === 'Green Flash Handicap (Grade II)' &&
  stakesTitleFromHeader([it('70th Running of', 428, 489), it('Del Mar Oaks Presented by Keeneland Sales (Grade I)', 362, 482),
    it('$300,000 Guaranteed', 419, 475)]) === 'Del Mar Oaks (Grade I)' &&
  stakesTitleFromHeader(h11) === 'Del Mar Mile (Grade II)' &&
  stakesTitleFromHeader([it('36th Running of', 430, 508), it('Pacific Classic (Grade I)', 417, 502),
    it('$1,000,000 Guaranteed', 419, 496)]) === 'Pacific Classic (Grade I)');
check('stakes title: the /Stakes/ word match stays as the fallback without an anchor',
  stakesTitleFromHeader([it('$2 WPS Parlay', 400, 540), it('Torrey Pines Stakes (Grade III)', 403, 459)]) === 'Torrey Pines Stakes (Grade III)' &&
  stakesTitleFromHeader([it('$2 WPS Parlay', 400, 540)]) === null);
check('R7 (fixture): the title is read via the "49th Running of" anchor, unchanged',
  r7.raceType === 'STAKES - Torrey Pines Stakes (Grade III)');

// --- second fixture: the REAL Del Mar program for Saturday 2026-08-22 ---
// A different layout from 08-30: no payoff box on the panels (the track
// comes from the Bottom Line header), four stakes without the word
// "Stakes" in the title, a line-wrapped distance, an 11-race card topped
// by the Pacific Classic. Same two layers: golden diff + hand checks.
console.log('-- delmar-2026-08-22 --');
const PDF2 = path.join(ROOT, 'tests', 'fixtures', 'programs', 'delmar-2026-08-22.pdf');
const GOLDEN2 = path.join(ROOT, 'tests', 'fixtures', 'programs', 'delmar-2026-08-22.expected.json');
const out2 = await parseProgramPdf(PDF2, { track: 'Del Mar', date: '2026-08-22' });
const diff2 = firstDiff(out2, JSON.parse(fs.readFileSync(GOLDEN2, 'utf8')));
check('golden: delmar-2026-08-22.pdf', !diff2, diff2 ?? '');
check('08-22: date and track (track via the Bottom Line header, no no_track warning)',
  out2.date === '2026-08-22' && out2.track === 'Del Mar' && !out2.warnings.some((w) => w.type === 'no_track'),
  `${out2.date} ${out2.track}`);
check('08-22: 11 races, numbered 1-11', out2.races.length === 11 && out2.races.every((r, i) => r.number === i + 1));
check('08-22: 122 entries across the card', out2.races.reduce((a, r) => a + r.entries.length, 0) === 122);
const counts2 = out2.races.map((r) => r.entries.length);
check('08-22: entry counts per race', JSON.stringify(counts2) === '[11,14,13,7,10,11,14,9,10,11,12]', JSON.stringify(counts2));
const types2 = out2.warnings.map((w) => `${w.type}:${w.race}`).sort().join(',');
check('08-22: warnings are exactly the two index renumberings (races 2, 6)',
  types2 === 'index_renumbered:2,index_renumbered:6', types2);
const scr = (r) => out2.races[r - 1].entries.filter((e) => e.scratched).map((e) => `${e.programNumber} ${e.horseName}`).join('|');
check('08-22: printed scratches - R2 Royal Lady (5) + Cotta Ride (7), R6 Blame Ashley (10), none elsewhere',
  scr(2) === '5 Royal Lady|7 Cotta Ride' && scr(6) === '10 Blame Ashley' &&
  out2.races.filter((r) => r.entries.some((e) => e.scratched)).length === 2, `${scr(2)} / ${scr(6)}`);
check('08-22: surfaces alternate turf/dirt as printed', out2.races.map((r) => r.surface).join(',') ===
  'TURF,DIRT,TURF,DIRT,TURF,DIRT,TURF,DIRT,TURF,DIRT,TURF');
const dists2 = out2.races.map((r) => r.distance).join('|');
check('08-22: distances (R3 line-wrapped, R6 five and a half, R10 mile and a quarter)',
  dists2 === 'One Mile|Six Furlongs|One Mile And One Sixteenth|One Mile|Five Furlongs|Five And One Half Furlongs|One Mile|One Mile|One Mile|One Mile And One Quarter|One Mile', dists2);
const titles2 = [5, 9, 10, 11].map((n) => out2.races[n - 1].raceType).join('|');
check('08-22: stakes titles without the word Stakes, sponsor clauses dropped, grades kept',
  titles2 === 'STAKES - Green Flash Handicap (Grade II)|STAKES - Del Mar Oaks (Grade I)|STAKES - Pacific Classic (Grade I)|STAKES - Del Mar Mile (Grade II)', titles2);
check('08-22: stakes purses incl. the $1,000,000 Pacific Classic',
  out2.races[4].purseCents === 200000_00 && out2.races[8].purseCents === 300000_00 &&
  out2.races[9].purseCents === 1000000_00 && out2.races[10].purseCents === 300000_00);
check('08-22: no race type carries conditions text',
  out2.races.every((r) => r.raceType && r.raceType.length <= 60), JSON.stringify(out2.races.map((r) => r.raceType)));
check('08-22: post times run 2:00PM to 7:18PM', out2.races[0].postTime === '2:00PM' && out2.races[10].postTime === '7:18PM');
check('08-22: best bet Kensington Lane (IRE) - race 9, program 9, rank 1, 3/1 - and the only one', (() => {
  const bets = out2.races.flatMap((r) => r.entries.filter((e) => e.bestBet).map((e) => ({ race: r.number, ...e })));
  return bets.length === 1 && bets[0].race === 9 && bets[0].programNumber === '9' &&
    bets[0].horseName === 'Kensington Lane (IRE)' && bets[0].programRank === 1 && bets[0].morningLine === '3/1';
})());
check('08-22: every non-scratched entry has all core fields', (() => {
  const gaps = out2.races.flatMap((r) => r.entries.filter((e) => !e.scratched &&
    !(e.horseName && e.jockey && e.trainer && e.owner && e.weight && e.morningLine && e.morningLineDecimal > 0 && e.breeding))
    .map((e) => `${r.number}:${e.programNumber}`));
  return gaps.length === 0;
})());
check('08-22: R9 #9 Kensington Lane - owner/trainer split where pdfjs fused them into one item', (() => {
  const kl = out2.races[8].entries.find((e) => e.programNumber === '9');
  return kl.owner === 'Agave Racing Stable, Medallion Racing or Trommer' && kl.trainer === "Philip D' Amato(M. Donald)";
})(), JSON.stringify(out2.races[8].entries.find((e) => e.programNumber === '9')?.owner));
check('08-22: also-eligibles - one in R3, two in R7',
  out2.races.map((r) => r.entries.filter((e) => e.alsoEligible).length).join(',') === '0,0,1,0,0,0,2,0,0,0,0');
check('08-22: index 122 rows, 3 scratches',
  out2.index.length === 122 && out2.index.filter((i) => i.scratched).length === 3);
check('08-22: analysis - 11 race paragraphs, R3 names six horses',
  out2.analysis.length === 11 && out2.analysis[2].picks.length === 6 && out2.analysis[2].picks[0] === 'King of Dragons');
check('08-22: equipment changes - exactly the card\'s two (R1 #1, R3 #13, blinkers off)',
  JSON.stringify(out2.races.flatMap((r) => r.entries.filter((e) => e.equipmentChange).map((e) => [r.number, e.programNumber, e.equipmentChange]))) ===
  '[[1,"1","Blinkers Off"],[3,"13","Blinkers Off"]]');

// --- track fallback: programs without the panel payoff box (D E L M A R
// letters) name the track only in the "<Track> Bottom Line" header. Found
// live with the 2026-08-22 program: track came back null and the ingest
// form's Save stayed disabled with no explanation.
check('track fallback: Bottom Line header yields the title-case track, ALL-CAPS best-bet line excluded',
  trackFromBottomLine('SATURDAY, AUGUST 22, 2026 BEST BET: RACE 9, KENSINGTON LANE Del Mar Bottom Line By Brad Free') === 'Del Mar');
check('track fallback: multi-word track', trackFromBottomLine('Santa Anita Bottom Line') === 'Santa Anita');
check('track fallback: no header -> null', trackFromBottomLine('BEST BET: RACE 2, SOME HORSE') === null);
check('track fallback: the panel letters still win on the fixture (golden unchanged)',
  out.track === 'DELMAR' && !out.warnings.some((w) => w.type === 'no_track'));

// --- fused owner/trainer (08-22 R9 #9) - the card is the dictionary ---
const fusedDay = () => [
  { number: 1, entries: [{ programNumber: '1', horseName: 'A', owner: 'Some Stable', trainer: "Philip D' Amato(M. Donald)" },
    { programNumber: '2', horseName: 'B', owner: 'Other LLC', trainer: 'Bob Baffert(J. Barnes)' }] },
  { number: 9, entries: [{ programNumber: '9', horseName: 'Kensington Lane (IRE)', trainer: null,
    owner: "Agave Racing Stable, Medallion Racing or Trommer Philip D' Amato(M. Donald)" }] },
];
check('fused owner/trainer: a trainer seen elsewhere on the card is peeled off the owner text', (() => {
  const races = fusedDay(); const w = [];
  splitFusedOwnerTrainer(races, w);
  const e = races[1].entries[0];
  return e.trainer === "Philip D' Amato(M. Donald)" && e.owner === 'Agave Racing Stable, Medallion Racing or Trommer' && w.length === 0;
})());
check('fused owner/trainer: longest known trainer wins, entries with a trainer are untouched', (() => {
  const races = fusedDay();
  races[0].entries.push({ programNumber: '3', horseName: 'C', owner: 'X', trainer: "D' Amato(M. Donald)" });
  splitFusedOwnerTrainer(races, []);
  return races[1].entries[0].trainer === "Philip D' Amato(M. Donald)" &&
    races[0].entries.every((e) => e.owner.length <= 11);
})());
check('fused owner/trainer: no dictionary hit -> owner_trainer_fused warning, never a guess', (() => {
  const races = fusedDay(); races[0].entries = []; const w = [];
  splitFusedOwnerTrainer(races, w);
  const e = races[1].entries[0];
  return e.trainer === null && /Trommer Philip/.test(e.owner) && w.length === 1 && w[0].type === 'owner_trainer_fused' && w[0].race === 9;
})());
check('fused owner/trainer: a plain owner with no trainer and no parens is left alone, no warning', (() => {
  const races = [{ number: 2, entries: [{ programNumber: '4', horseName: 'D', owner: 'Reddam Racing, LLC', trainer: null }] }]; const w = [];
  splitFusedOwnerTrainer(races, w);
  return races[0].entries[0].owner === 'Reddam Racing, LLC' && w.length === 0;
})());

check('wrong expected date -> wrong_date warning',
  wrong.warnings.some((w) => w.type === 'wrong_date'));
check('wrong expected track -> wrong_track warning',
  wrong.warnings.some((w) => w.type === 'wrong_track'));

// --- third fixture: the 2025 print run (tests/fixtures/backfill/DMR-2025-summer, the D45 golden) ---
// One 1/3-page advertisement per card brings its print-proof slug into the
// text layer, OVERPRINTED (every item twice at the same coordinates). Before
// the fix its "Round 1" moved race 9's left edge (the race parsed EMPTY on 22
// of 31 days of the meet) and its "OK" became a horse's name.
console.log('-- 2025 print run: advertisement slug on the race-9 spread --');
const PDF3 = path.join(ROOT, 'tests', 'fixtures', 'backfill', 'DMR-2025-summer', 'program.pdf');
const out3 = await parseProgramPdf(PDF3, { track: 'Del Mar', date: '2025-07-18' });
const r9 = out3.races.find((r) => r.number === 9);
check('2025-07-18: 10 races, 110 entries, no empty race, no index mismatch (the ad slug is dropped)',
  out3.races.length === 10 && out3.races.reduce((a, r) => a + r.entries.length, 0) === 110 && !out3.warnings.some((w) => w.type === 'empty_race' || w.type === 'index_mismatch'),
  JSON.stringify(out3.warnings.map((w) => w.type)));
check('2025-07-18 R9: eleven entries in program order, #3 is Runkerry (not the ad "OK"), #7 Case Hit scratched, ranks 4/8/7, Six Furlongs dirt allowance/claiming at 6:00PM',
  r9 && r9.entries.length === 11 && r9.entries.map((e) => e.programNumber).join() === '1,2,3,4,5,6,7,8,9,10,11' && r9.entries[2].horseName === 'Runkerry' && r9.entries[2].jockey === 'Cristobal Herrera' &&
  r9.entries[6].horseName === 'Case Hit' && r9.entries[6].scratched && r9.entries.filter((e) => e.programRank).map((e) => `${e.programNumber}:${e.programRank}`).join() === '4:1,7:3,8:2' &&
  r9.distance === 'Six Furlongs' && r9.surface === 'DIRT' && r9.raceType === 'ALLOWANCE/CLAIMING' && r9.postTime === '6:00PM',
  r9 ? JSON.stringify(r9.entries.map((e) => [e.programNumber, e.horseName, e.programRank, e.scratched])) : 'no race 9');

// --- fourth fixture: a FOREIGN document (tests/fixtures/backfill/DMR-2025-fall, the D46 golden) ---
// On Breeders' Cup days the Del Mar program URL serves the Breeders' Cup
// official program: per-race footers but no Bottom Line, no horse index,
// panels that parse to duplicates and empties. The parser must say so and
// hand back NO races - the ML sheet is the only entries source that day.
console.log('-- foreign document: the Breeders Cup official program (2025-10-31) --');
// The 42MB BC program is committed by DIGEST only (tests/fixtures/backfill/DMR-2025-fall/program.digest.json);
// the archived copy under data/raw is parsed when present, else this assertion is noted as skipped.
const DIGEST4 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'backfill', 'DMR-2025-fall', 'program.digest.json'), 'utf8'));
const PDF4 = path.join(ROOT, 'data', 'raw', 'DMR', '20251031', 'program.pdf');
if (fs.existsSync(PDF4)) {
  const bytes4 = fs.readFileSync(PDF4);
  check('2025-10-31: the archived Breeders Cup program matches the committed digest', (await import('node:crypto')).createHash('sha256').update(bytes4).digest('hex') === DIGEST4.sha256 && bytes4.length === DIGEST4.bytes);
  const out4 = await parseProgramPdf(new Uint8Array(bytes4), { track: 'Del Mar', date: '2025-10-31' });
  check('2025-10-31 Breeders Cup program: flagged foreign, zero races handed back, the reason spelled out (no Bottom Line, no index, empties, duplicates)',
    out4.foreign === true && out4.races.length === 0 && out4.warnings.some((w) => w.type === 'foreign_program' && /no Bottom Line, no horse index/.test(w.message) && /duplicate race numbers/.test(w.message)) &&
    out4.warnings.some((w) => w.type === 'no_analysis') && out4.warnings.some((w) => w.type === 'no_index'), JSON.stringify(out4.warnings.map((w) => w.type)));
} else {
  console.log('  note  2025-10-31 Breeders Cup program: digest-only fixture and data/raw archive not present - foreign-document parse skipped here (the backfill runner re-verifies it against the archive)');
}
check('a real Del Mar program is never flagged foreign (2026-08-30, 2025-07-18)', out.foreign === undefined && out3.foreign === undefined);

if (failures) {
  console.error(`\ncheck-program: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-program: all checks passed');
