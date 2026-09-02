// Verification for the P/L views - exits non-zero on any failure.
// Run: npm run check-pl
//
// Everything here runs against the real server on a temp DB, because the
// endpoints ARE the deliverable. The scenario builds three days:
//   A) the real Del Mar fixtures, two sources -> FULL, two card variants,
//      the real chart -> both graded;
//   B) a synthetic day, no sources -> PROGRAM_ONLY, graded;
//   C) a day with a card and NO results -> ungraded.
// Then it holds the two invariants to the fire: buckets never pool (13) -
// no endpoint emits an all-bucket total and each bucket sums only its own
// cards - and soft-deleted days vanish from every aggregate (12).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-plcheck-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const prog = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/programs/delmar-2026-08-30.expected.json'), 'utf8'));
const sftb = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sources/sftb-delmar-2026-08-30.expected.json'), 'utf8'));
const chart = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/charts/dmr-2026-08-30.expected.json'), 'utf8'));

// A minimal synthetic day for the PROGRAM_ONLY bucket: two races, no
// external sources, and a matching synthetic chart.
const synthEntry = (pgm, name, ml, mld, rank) => ({
  programNumber: pgm, horseName: name, morningLine: ml, morningLineDecimal: mld,
  programRank: rank, bestBet: false, scratched: false,
});
const synthDay = {
  track: 'Santa Anita', date: '2026-08-30', bankrollCents: 5000, perRaceMinCents: 500,
  races: [
    { number: 1, raceType: 'CLAIMING', conditions: 'FOR THREE YEAR OLDS AND UPWARD', entries: [
      synthEntry('1', 'Alpha Marker', '2/1', 2, 1), synthEntry('2', 'Beta Cruiser', '4/1', 4, 2),
      synthEntry('3', 'Gamma Ray Burst', '8/1', 8, 3),
    ] },
    { number: 2, raceType: 'ALLOWANCE', conditions: 'FOR FOUR YEAR OLDS AND UPWARD', entries: [
      synthEntry('1', 'Delta Blues', '3/1', 3, 1), synthEntry('2', 'Epsilon Star', '5/1', 5, 2),
      synthEntry('3', 'Zeta Function', '10/1', 10, 3),
    ] },
  ],
};
const synthChart = {
  track: 'SANTA ANITA', date: '2026-08-30',
  races: [
    { number: 1, results: [
      { programNumber: '1', horseName: 'Alpha Marker', finishPosition: 1, winCents: 600, placeCents: 340, showCents: 280 },
      { programNumber: '3', horseName: 'Gamma Ray Burst', finishPosition: 2, winCents: null, placeCents: 700, showCents: 420 },
      { programNumber: '2', horseName: 'Beta Cruiser', finishPosition: 3, winCents: null, placeCents: null, showCents: 300 },
    ], exotics: [
      { betType: 'exacta', baseCents: 100, combination: '1-3', payoutCents: 1980, poolCents: 100000 },
    ], scratches: [] },
    { number: 2, results: [
      { programNumber: '2', horseName: 'Epsilon Star', finishPosition: 1, winCents: 1200, placeCents: 600, showCents: 440 },
      { programNumber: '1', horseName: 'Delta Blues', finishPosition: 2, winCents: null, placeCents: 320, showCents: 280 },
      { programNumber: '3', horseName: 'Zeta Function', finishPosition: 3, winCents: null, placeCents: null, showCents: 500 },
    ], exotics: [
      { betType: 'exacta', baseCents: 100, combination: '2-1', payoutCents: 2440, poolCents: 100000 },
      { betType: 'daily_double', baseCents: 200, combination: '1-2', payoutCents: 4300, poolCents: 50000 },
    ], scratches: [] },
  ],
};

// ---------- server ----------

const PORT = 8905;
const BASE = `http://127.0.0.1:${PORT}`;
const logDir = path.join(tmp, 'server-logs');
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(PORT),
    BETSHEET_DB: path.join(tmp, 'check.sqlite'),
    BETSHEET_LOG_DIR: logDir,
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const jpost = (url, body) => fetch(BASE + url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const jget = (url) => fetch(BASE + url).then((r) => r.json());

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); }
  }
  check('server boots', up, serverOut.slice(-300));

  console.log('-- scenario build --');
  // Day A: FULL, two card variants, real chart.
  const dayA = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: '2026-08-30', bankrollCents: 20000, perRaceMinCents: 500,
    races: prog.races,
  })).json();
  for (const name of ['Digest One', 'Digest Two']) {
    const text = sftb.races.map((x) => `Race ${x.race}: ${x.picks.map((p) => p.programNumber).join(', ')}`).join('\n');
    const preview = await (await jpost(`/api/race-days/${dayA.id}/consensus/manual-preview`, { sourceName: name, text })).json();
    await jpost(`/api/race-days/${dayA.id}/consensus/manual`, { sourceName: name, races: preview.races });
  }
  const cardA1 = await (await jpost(`/api/race-days/${dayA.id}/cards`, { variant: 'default' })).json();
  const cardA2 = await (await jpost(`/api/race-days/${dayA.id}/cards`, {
    variant: 'nofade', rules: { fadeThePrice: false },
  })).json();
  await jpost(`/api/race-days/${dayA.id}/results`, {
    track: chart.track, date: chart.date, sourceKind: 'paste', races: chart.races,
  });

  // Day B: PROGRAM_ONLY, synthetic chart.
  const dayB = await (await jpost('/api/race-days', synthDay)).json();
  const cardB = await (await jpost(`/api/race-days/${dayB.id}/cards`, { variant: 'default' })).json();
  const saveB = await jpost(`/api/race-days/${dayB.id}/results`, {
    track: synthChart.track, date: synthChart.date, sourceKind: 'paste', races: synthChart.races,
  });
  check('synthetic PROGRAM_ONLY day built and graded',
    Number.isInteger(cardB.id) && cardB.completeness === 'PROGRAM_ONLY' && saveB.status === 201,
    JSON.stringify({ completeness: cardB.completeness, save: saveB.status }));

  // Day C: card, no results.
  const dayC = await (await jpost('/api/race-days', {
    ...synthDay, track: 'Golden Gate Fields',
  })).json();
  const cardC = await (await jpost(`/api/race-days/${dayC.id}/cards`, { variant: 'default' })).json();

  console.log('-- the running view (invariant 13) --');
  const pl = await jget('/api/pl');
  check('response shape: buckets/cards/ungraded and NOTHING else - no pooled total',
    JSON.stringify(Object.keys(pl).sort()) === JSON.stringify(['buckets', 'cards', 'ungraded']));
  check('no bucket is a pooled pseudo-bucket',
    pl.buckets.every((b) => ['FULL', 'PARTIAL', 'PROGRAM_ONLY'].includes(b.completeness)));
  check('FULL bucket holds exactly the two Del Mar cards', (() => {
    const b = pl.buckets.find((x) => x.completeness === 'FULL');
    return b && b.cards === 2 &&
      pl.cards.filter((c) => c.completeness === 'FULL').every((c) => c.raceDayId === dayA.id);
  })(), JSON.stringify(pl.buckets));
  check('PROGRAM_ONLY bucket holds exactly the synthetic card', (() => {
    const b = pl.buckets.find((x) => x.completeness === 'PROGRAM_ONLY');
    return b && b.cards === 1 &&
      pl.cards.find((c) => c.completeness === 'PROGRAM_ONLY')?.cardId === cardB.id;
  })());
  check('every bucket sums ONLY its own card rows', pl.buckets.every((b) => {
    const mine = pl.cards.filter((c) => c.completeness === b.completeness);
    const sum = (k) => mine.reduce((a, c) => a + c[k], 0);
    return sum('costCents') === b.costCents && sum('returnedCents') === b.returnedCents &&
      sum('plCents') === b.plCents && mine.length === b.cards;
  }));
  check('card rows agree with the grading endpoint, card by card', await (async () => {
    for (const c of pl.cards) {
      const gr = await jget(`/api/cards/${c.cardId}/grades`);
      if (gr.summary.plCents !== c.plCents || gr.summary.costCents !== c.costCents) return false;
    }
    return true;
  })());
  check('per-card P/L is internally consistent (pl = returned - cost)',
    pl.cards.every((c) => c.plCents === c.returnedCents - c.costCents));
  check('the ungraded card waits outside every bucket', (() => {
    const u = pl.ungraded.find((c) => c.cardId === cardC.id);
    return u && u.costCents > 0 &&
      !pl.cards.some((c) => c.cardId === cardC.id) &&
      !pl.buckets.some((b) => b.completeness === u.completeness && b.cards > pl.cards.filter((c) => c.completeness === u.completeness).length);
  })(), JSON.stringify(pl.ungraded));

  console.log('-- the per-day compare view --');
  const dayPL = await jget(`/api/race-days/${dayA.id}/pl`);
  check('both variants side by side, both graded',
    dayPL.cards.length === 2 && dayPL.cards.every((c) => c.graded) &&
    dayPL.cards.map((c) => c.variant).join(',') === 'default,nofade');
  check('per-race rows cover the 10 races plus the multi-race bucket',
    dayPL.cards.every((c) =>
      c.perRace.filter((x) => x.race !== 'multi').length === 10 &&
      c.perRace.some((x) => x.race === 'multi')));
  check('per-race cells sum exactly to each card total', dayPL.cards.every((c) => {
    const sum = (k) => c.perRace.reduce((a, x) => a + x[k], 0);
    return sum('costCents') === c.costCents && sum('returnedCents') === c.returnedCents &&
      sum('plCents') === c.plCents;
  }));
  check('day view totals match the running view rows', dayPL.cards.every((c) =>
    pl.cards.find((x) => x.cardId === c.cardId)?.plCents === c.plCents));
  check('the fade toggle shows up in the compare: R1 spend differs between variants', (() => {
    const r1 = dayPL.cards.map((c) => c.perRace.find((x) => x.race === 1));
    return r1[0] && r1[1] && (r1[0].costCents !== r1[1].costCents || r1[0].plCents !== r1[1].plCents);
  })(), JSON.stringify(dayPL.cards.map((c) => c.perRace.find((x) => x.race === 1))));
  const ungradedDayPL = await jget(`/api/race-days/${dayC.id}/pl`);
  check('a day without results reports its cards as ungraded, empty per-race',
    ungradedDayPL.cards.length === 1 && ungradedDayPL.cards[0].graded === false &&
    ungradedDayPL.cards[0].perRace.length === 0);
  const missing = await fetch(`${BASE}/api/race-days/99999/pl`);
  check('unknown day -> 404', missing.status === 404);

  console.log('-- soft delete drops out of every aggregate (invariant 12) --');
  await fetch(`${BASE}/api/race-days/${dayB.id}`, { method: 'DELETE' });
  const plAfter = await jget('/api/pl');
  check('deleted day: PROGRAM_ONLY bucket gone from the running view',
    !plAfter.buckets.some((b) => b.completeness === 'PROGRAM_ONLY') &&
    !plAfter.cards.some((c) => c.raceDayId === dayB.id));
  const deletedDayPL = await fetch(`${BASE}/api/race-days/${dayB.id}/pl`);
  check('deleted day: per-day P/L answers 410', deletedDayPL.status === 410);
  await jpost(`/api/race-days/${dayB.id}/restore`, {});
  const plRestored = await jget('/api/pl');
  check('restore brings the bucket back, numbers unchanged', (() => {
    const before = pl.buckets.find((b) => b.completeness === 'PROGRAM_ONLY');
    const after = plRestored.buckets.find((b) => b.completeness === 'PROGRAM_ONLY');
    return after && before && after.plCents === before.plCents && after.cards === before.cards;
  })());
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-pl: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-pl: all checks passed');
