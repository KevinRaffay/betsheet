// Verification for the results-chart parser - exits non-zero on any
// failure. Run: npm run check-charts
//
// The fixture is the REAL Equibase chart for Del Mar 2026-08-30 - the same
// day as the program-PDF and SFTB fixtures, so the three real artifacts
// cross-validate each other: every finisher and every chart scratch must
// exist among the program's entries.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseChart } from '../shared/chart-parser.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIX = path.join(ROOT, 'tests', 'fixtures');

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
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
    const d = firstDiff(a[k], b[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

const text = fs.readFileSync(path.join(FIX, 'charts', 'dmr-2026-08-30.txt'), 'utf8');
const out = parseChart(text);

const golden = JSON.parse(fs.readFileSync(path.join(FIX, 'charts', 'dmr-2026-08-30.expected.json'), 'utf8'));
check('golden: dmr-2026-08-30.txt', !firstDiff(out, golden), firstDiff(out, golden) ?? '');

check('track and date from the chart headers',
  out.track === 'DEL MAR' && out.date === '2026-08-30');
check('10 races, numbered 1-10',
  out.races.length === 10 && out.races.every((r, i) => r.number === i + 1));
check('finisher counts per race',
  JSON.stringify(out.races.map((r) => r.results.length)) === '[6,9,9,8,10,11,7,9,9,12]',
  JSON.stringify(out.races.map((r) => r.results.length)));

// R1 - the race the generated card faded the favorite in.
const r1 = out.races[0];
check('R1: Howie\'s Law wins at 0.40*, pays 2.80/2.20/2.10', (() => {
  const w = r1.results[0];
  return w.programNumber === '1' && w.horseName === "Howie's Law" &&
    w.finishPosition === 1 && w.favorite === true && Math.abs(w.odds - 0.4) < 1e-9 &&
    w.winCents === 280 && w.placeCents === 220 && w.showCents === 210;
})(), JSON.stringify(r1.results[0]));
check('R1: Here\'s Some More second at $6.20 place (the fade thesis, graded)', (() => {
  const p = r1.results[1];
  return p.programNumber === '6' && p.placeCents === 620 && p.winCents === null;
})());
check('R1: exacta 1-6 pays $10.30 on a $1 base', (() => {
  const x = r1.exotics.find((e) => e.betType === 'exacta');
  return x && x.combination === '1-6' && x.baseCents === 100 && x.payoutCents === 1030;
})());
check('R1: trifecta 50c base, superfecta 10c base', (() => {
  const tri = r1.exotics.find((e) => e.betType === 'trifecta');
  const sup = r1.exotics.find((e) => e.betType === 'superfecta');
  return tri?.baseCents === 50 && tri?.payoutCents === 2215 &&
    sup?.baseCents === 10 && sup?.combination === '1-6-5-4';
})());

check('R9: the $41.60 bomb (Arrowthegreat) parses', (() => {
  const w = out.races[8].results[0];
  return w.horseName === 'Arrowthegreat' && w.winCents === 4160;
})());

check('every race: 1st has W/P/S, 2nd has P/S, 3rd has S',
  out.races.every((r) =>
    r.results[0].winCents > 0 && r.results[0].placeCents > 0 && r.results[0].showCents > 0 &&
    r.results[1].winCents === null && r.results[1].placeCents > 0 &&
    r.results[2].placeCents === null && r.results[2].showCents > 0));

// Scratches, including a name that itself contains parentheses.
check('scratches with reasons across 4 races', (() => {
  const flat = out.races.flatMap((r) => r.scratches.map((s) => `${r.number}:${s.horseName}(${s.reason})`));
  return flat.length === 8 &&
    flat.includes('2:Angels Revenge(Stewards)') &&
    flat.includes('5:The Chosen Bride(Trainer)') &&
    flat.includes('8:First Light(Veterinarian)') &&
    flat.includes('10:American Glory (GB)(Trainer)');
})(), JSON.stringify(out.races.flatMap((r) => r.scratches)));

// The exotic zoo of race 10.
const r10 = out.races[9];
check('R10: pick6 pays both tiers, pick4/pick5 with a two-winner leg', (() => {
  const p6 = r10.exotics.filter((e) => e.betType === 'pick6');
  return p6.length === 2 && p6[0].combination === '5-11-3-1/4-4-2' &&
    r10.exotics.some((e) => e.betType === 'pick4' && e.combination === '3-1/4-4-2');
})());
check('R10: named pool (Turf Pick 3) and Place Pick All parse',
  r10.exotics.some((e) => e.betType === 'turfpick3' && e.combination === '11-4-2') &&
  r10.exotics.some((e) => e.betType === 'place_pick_all' && e.combination === '8 OF 10'));
// Found by the D42 cross-check against the dmtc results page: nobody hit the
// Super High Five (the page says "paid $0.00"), so the two numbers under the
// Carryover column are the POOL ($41,039) and the CARRYOVER ($31,321) - the old
// parse read the pool as a $41,039 payout on a $31,321 pool.
check('R10: Super High Five - no payout, pool and carryover read from the Carryover column',
  r10.exotics.some((e) => e.betType === 'super_high_five' && e.payoutCents === 0 && e.poolCents === 4103900 && e.carryoverCents === 3132100),
  JSON.stringify(r10.exotics.find((e) => e.betType === 'super_high_five')));
check('R10: the $1 3x3 row parses (payout, pool, carryover) instead of warning',
  r10.exotics.some((e) => e.betType === '3x3' && e.combination === '3/4 OF 9' && e.payoutCents === 105 && e.poolCents === 3700 && e.carryoverCents === 187000));
check('no warnings on the real chart', out.warnings.length === 0, JSON.stringify(out.warnings));

// A tiny field prints no show pool: the mutuel header omits Show and two
// prices mean win/place (2026-08-28 R1 - found by the D42 cross-check).
const small = parseChart(['DEL MAR - August 28, 2026 - Race 1', 'MAIDEN CLAIMING - Thoroughbred', 'Distance: Six Furlongs On The Dirt',
  'Last Raced Pgm Horse Name (Jockey) Wgt M/E PP Start 1/4 1/2 Str Fin Odds Comments', 'Final Time: 1:11.01',
  'Pgm Horse Win Place Wager Type Winning Numbers Payoff Pool', '2 Sensational Dream 6.40 3.60 $1.00 Exacta 2-1 11.30 40,813', '1 Icons Only 3.80 $2.00 Quinella 1-2 11.60 2,475'].join(String.fromCharCode(10)));
check('no show pool: header without Show -> 2 prices = win/place, 1 = place', (() => {
  const r = small.races[0]; if (!r) return false;
  const w = r.results.find((x) => x.programNumber === '2'); const p = r.results.find((x) => x.programNumber === '1');
  return r.exotics.length === 2 && (!w || (w.winCents === 640 && w.placeCents === 360 && w.showCents === null)) && (!p || (p.placeCents === 380 && p.winCents === null));
})(), JSON.stringify(small.races[0]?.results));

// ---- cross-fixture: chart vs. the program for the SAME day ----

const prog = JSON.parse(fs.readFileSync(path.join(FIX, 'programs', 'delmar-2026-08-30.expected.json'), 'utf8'));
const nameKey = (s) => String(s ?? '').toUpperCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

check('every chart finisher exists in the program entries (same pgm + name)',
  out.races.every((r) => {
    const progRace = prog.races.find((p) => p.number === r.number);
    return r.results.every((res) => progRace.entries.some((e) =>
      e.programNumber === res.programNumber && nameKey(e.horseName) === nameKey(res.horseName)));
  }));
check('every chart scratch exists in the program entries',
  out.races.every((r) => {
    const progRace = prog.races.find((p) => p.number === r.number);
    return r.scratches.every((s) => progRace.entries.some((e) =>
      nameKey(e.horseName) === nameKey(s.horseName)));
  }));
check('finishers + chart scratches account for every program entry', (() => {
  // program entries = finishers + scratches, race by race
  return out.races.every((r) => {
    const progRace = prog.races.find((p) => p.number === r.number);
    return progRace.entries.length === r.results.length + r.scratches.length;
  });
})(), JSON.stringify(out.races.map((r) => {
  const p = prog.races.find((x) => x.number === r.number);
  return [r.number, p.entries.length, r.results.length + r.scratches.length];
})));

// ---- the PDF path: extraction must reproduce the paste fixture ----

{
  const { extractPdfLines } = await import('../server/pdf-text.js');
  const extracted = await extractPdfLines(path.join(FIX, 'charts', 'dmr-2026-08-30.pdf'));
  check('pdf extraction reproduces the paste fixture byte for byte',
    extracted.replace(/\r\n/g, '\n').trim() === text.replace(/\r\n/g, '\n').trim(),
    `extracted ${extracted.length} bytes vs fixture ${text.length}`);
  const fromPdf = parseChart(extracted);
  check('pdf-extracted text parses identically to the golden',
    !firstDiff(fromPdf, golden), firstDiff(fromPdf, golden) ?? '');
}

// ---- degenerate input ----

check('empty input: warns, never throws',
  parseChart('').races.length === 0 && parseChart('').warnings.some((w) => w.type === 'no_races'));
check('garbage input: warns, never throws', (() => {
  const g = parseChart('DEL MAR - August 30, 2026 - Race 1\nnothing useful here\n');
  return g.races.length === 1 && g.warnings.some((w) => w.type === 'empty_race');
})());

if (failures) {
  console.error(`\ncheck-charts: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-charts: all checks passed');
