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
import { livePgms, makeHumanCard, winAndBoxText } from './lib/test-cards.js';

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
  // D111: the two cards on day A were engine variants (default / nofade).
  // With the engine gone the pair that matters is two different PRODUCERS on
  // one day - a HUMAN card and an LLM card - which is what invariant 13 has
  // to keep apart now. Different stakes on race 1 so the per-day compare
  // still has a real difference to show.
  const storedA = await jget(`/api/race-days/${dayA.id}`);
  const pgmsA = livePgms(storedA);
  const racesA = storedA.races
    .map((r) => ({ race: r.number, text: winAndBoxText(pgmsA[r.number] ?? []) }))
    .filter((r) => (pgmsA[r.race] ?? []).length >= 3);
  const cardA1Id = await makeHumanCard(jpost, dayA.id, racesA);
  const llmA = 'Reasoning: stub.\n\n<<<TICKETS>>>\nWin | #' + pgmsA[racesA[0].race][0] + ' | $40 | Test.\n<<<END TICKETS>>>\n';
  const llmPrevA = await (await jpost(`/api/race-days/${dayA.id}/llm-cards/preview`, { race: racesA[0].race, __stubResponse: llmA })).json();
  const cardA2Id = (await (await jpost(`/api/race-days/${dayA.id}/llm-cards`, { race: racesA[0].race, requestId: llmPrevA.requestId, bankrollCents: 20000 })).json()).cardId;
  const cardA1 = { id: cardA1Id };
  const cardA2 = { id: cardA2Id };
  await jpost(`/api/race-days/${dayA.id}/results`, {
    track: chart.track, date: chart.date, sourceKind: 'paste', races: chart.races,
  });

  // Day B: a SECOND day feeding the same HUMAN bucket, synthetic chart. That
  // is deliberately not a third bucket: a bucket spanning two days is what
  // catches an aggregate that sums the wrong rows, and it makes the
  // soft-delete test below a PARTIAL removal rather than a whole bucket
  // vanishing - which is where a bad join actually leaks.
  const dayB = await (await jpost('/api/race-days', synthDay)).json();
  const storedB = await jget(`/api/race-days/${dayB.id}`);
  const pgmsB = livePgms(storedB);
  const cardBId = await makeHumanCard(jpost, dayB.id, storedB.races
    .map((r) => ({ race: r.number, text: winAndBoxText(pgmsB[r.number] ?? []) }))
    .filter((r) => (pgmsB[r.race] ?? []).length >= 3));
  const cardB = { id: cardBId };
  const saveB = await jpost(`/api/race-days/${dayB.id}/results`, {
    track: synthChart.track, date: synthChart.date, sourceKind: 'paste', races: synthChart.races,
  });
  check('synthetic second HUMAN day built and graded',
    Number.isInteger(cardB.id) && saveB.status === 201,
    JSON.stringify({ card: cardB.id, save: saveB.status }));

  // Day C: card, no results.
  const dayC = await (await jpost('/api/race-days', {
    ...synthDay, track: 'Golden Gate Fields',
  })).json();
  const storedC = await jget(`/api/race-days/${dayC.id}`);
  const pgmsC = livePgms(storedC);
  const cardCId = await makeHumanCard(jpost, dayC.id, storedC.races
    .map((r) => ({ race: r.number, text: winAndBoxText(pgmsC[r.number] ?? []) }))
    .filter((r) => (pgmsC[r.race] ?? []).length >= 3));
  const cardC = { id: cardCId };

  console.log('-- the running view (invariant 13) --');
  // The producers write their own version labels ('human', 'llm'), which are
  // separate engine versions as far as invariant 14 is concerned, so the
  // cross-bucket view needs the explicit all-versions selector.
  const pl = await jget('/api/pl?engineVersion=all');
  check('response shape: buckets/cards/ungraded + the engine-version selector (D34) + the meet selector (D43) and NOTHING else - no pooled total',
    JSON.stringify(Object.keys(pl).sort()) === JSON.stringify(['buckets', 'cards', 'engineVersions', 'meets', 'selectedMeet', 'selectedVersion', 'ungraded']) &&
    pl.selectedVersion === 'all');
  check('no bucket is a pooled pseudo-bucket, and no engine bucket exists any more',
    pl.buckets.every((b) => ['HUMAN', 'LLM_GENERATED', 'EQB_OTR'].includes(b.completeness)),
    JSON.stringify(pl.buckets.map((b) => b.completeness)));
  check('LLM_GENERATED bucket holds exactly the one Del Mar LLM card', (() => {
    const b = pl.buckets.find((x) => x.completeness === 'LLM_GENERATED');
    return b && b.cards === 1 &&
      pl.cards.filter((c) => c.completeness === 'LLM_GENERATED').every((c) => c.raceDayId === dayA.id);
  })(), JSON.stringify(pl.buckets));
  check('HUMAN bucket spans BOTH graded days and holds only its own cards', (() => {
    const b = pl.buckets.find((x) => x.completeness === 'HUMAN');
    const mine = pl.cards.filter((c) => c.completeness === 'HUMAN');
    return b && b.cards === 2 && mine.length === 2 &&
      mine.some((c) => c.cardId === cardA1.id) && mine.some((c) => c.cardId === cardB.id);
  })(), JSON.stringify(pl.cards.map((c) => [c.cardId, c.completeness])));
  check('every bucket sums ONLY its own card rows', pl.buckets.every((b) => {
    const mine = pl.cards.filter((c) => c.completeness === b.completeness);
    const sum = (k) => mine.reduce((a, c) => a + c[k], 0);
    return sum('costCents') === b.costCents && sum('returnedCents') === b.returnedCents &&
      sum('plCents') === b.plCents && mine.length === b.cards;
  }));
  check('the two producers on ONE day never pool into a single bucket',
    pl.cards.find((c) => c.cardId === cardA1.id)?.completeness === 'HUMAN' &&
    pl.cards.find((c) => c.cardId === cardA2.id)?.completeness === 'LLM_GENERATED');
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
  check('both cards side by side, both graded',
    dayPL.cards.length === 2 && dayPL.cards.every((c) => c.graded),
    JSON.stringify(dayPL.cards.map((c) => [c.cardId, c.graded])));
  check('per-race rows cover only the races each card actually bet',
    dayPL.cards.every((c) => c.perRace.length > 0 &&
      c.perRace.every((x) => x.race === 'multi' || Number.isInteger(x.race))));
  check('per-race cells sum exactly to each card total', dayPL.cards.every((c) => {
    const sum = (k) => c.perRace.reduce((a, x) => a + x[k], 0);
    return sum('costCents') === c.costCents && sum('returnedCents') === c.returnedCents &&
      sum('plCents') === c.plCents;
  }));
  check('day view totals match the running view rows', dayPL.cards.every((c) =>
    pl.cards.find((x) => x.cardId === c.cardId)?.plCents === c.plCents));
  check('the compare really compares: the two producers differ on the race they share', (() => {
    const shared = racesA[0].race;
    const r = dayPL.cards.map((c) => c.perRace.find((x) => x.race === shared));
    return r[0] && r[1] && (r[0].costCents !== r[1].costCents || r[0].plCents !== r[1].plCents);
  })(), JSON.stringify(dayPL.cards.map((c) => c.perRace.find((x) => x.race === racesA[0].race))));
  const ungradedDayPL = await jget(`/api/race-days/${dayC.id}/pl`);
  check('a day without results reports its cards as ungraded, empty per-race',
    ungradedDayPL.cards.length === 1 && ungradedDayPL.cards[0].graded === false &&
    ungradedDayPL.cards[0].perRace.length === 0);
  const missing = await fetch(`${BASE}/api/race-days/99999/pl`);
  check('unknown day -> 404', missing.status === 404);

  console.log('-- soft delete drops out of every aggregate (invariant 12) --');
  const humanBefore = pl.buckets.find((b) => b.completeness === 'HUMAN');
  const cardBRow = pl.cards.find((c) => c.cardId === cardB.id);
  await fetch(`${BASE}/api/race-days/${dayB.id}`, { method: 'DELETE' });
  const plAfter = await jget('/api/pl?engineVersion=all');
  // A PARTIAL removal: the HUMAN bucket survives on day A's card, minus
  // exactly day B's contribution. A join that filtered deleted_at in one
  // place but not another would show up here as a bucket whose total no
  // longer matches its own rows.
  check('deleted day: its card leaves the running view and the bucket drops by exactly its cents', (() => {
    const after = plAfter.buckets.find((b) => b.completeness === 'HUMAN');
    return after && !plAfter.cards.some((c) => c.raceDayId === dayB.id) &&
      after.cards === humanBefore.cards - 1 &&
      after.costCents === humanBefore.costCents - cardBRow.costCents &&
      after.plCents === humanBefore.plCents - cardBRow.plCents;
  })(), JSON.stringify(plAfter.buckets));
  const deletedDayPL = await fetch(`${BASE}/api/race-days/${dayB.id}/pl`);
  check('deleted day: per-day P/L answers 410', deletedDayPL.status === 410);
  await jpost(`/api/race-days/${dayB.id}/restore`, {});
  const plRestored = await jget('/api/pl?engineVersion=all');
  check('restore brings the card back, numbers unchanged', (() => {
    const after = plRestored.buckets.find((b) => b.completeness === 'HUMAN');
    return after && after.plCents === humanBefore.plCents && after.cards === humanBefore.cards &&
      after.costCents === humanBefore.costCents;
  })(), JSON.stringify(plRestored.buckets));
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
