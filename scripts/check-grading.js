// Verification for the ticket grading engine - exits non-zero on any failure.
// Run: npm run check-grading
//
// Three layers: (1) synthetic units - every bet type, every scratch/refund
// rule, with hand-computed expected money; (2) the REAL day end to end,
// pure: the program golden generates a card, the Equibase chart golden
// grades it, and hand-audited payoffs (R1 exacta 1-6 at $10.30/$1, R3
// winner #2 at $16.40/$8.20) pin the math; (3) a server round-trip: save
// day -> generate -> grade refused (409, no results) -> save results ->
// every card auto-graded -> grades read back -> trace events on file.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { livePgms, makeHumanCard, winAndBoxText } from './lib/test-cards.js';
import { nameKey } from '../shared/parsers/human-picks.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-gradecheck-'));
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'unit-logs');

const { gradeTicket, buildDayResults, gradeCard } = await import('../shared/grading.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

// ---------- synthetic units ----------

console.log('-- synthetic units --');

// One hand-built day: R1 winner 3 ($14.40/$5.40/$4.60), runner-up 7
// ($6.20 pl/$3.40 sh), third 2 ($2.80 sh); 9 scratched. R2 winner 5 ($8.00).
const day = buildDayResults([
  {
    number: 1,
    results: [
      { programNumber: '3', finishPosition: 1, winCents: 1440, placeCents: 540, showCents: 460 },
      { programNumber: '7', finishPosition: 2, winCents: null, placeCents: 620, showCents: 340 },
      { programNumber: '2', finishPosition: 3, winCents: null, placeCents: null, showCents: 280 },
      { programNumber: '4', finishPosition: 4, winCents: null, placeCents: null, showCents: null },
    ],
    exotics: [
      { betType: 'exacta', baseCents: 100, combination: '3-7', payoutCents: 2560 },
      { betType: 'trifecta', baseCents: 50, combination: '3-7-2', payoutCents: 4120 },
    ],
    scratchedPgms: ['9'],
  },
  {
    number: 2,
    results: [
      { programNumber: '5', finishPosition: 1, winCents: 800, placeCents: 400, showCents: 300 },
      { programNumber: '1', finishPosition: 2, winCents: null, placeCents: 500, showCents: 320 },
    ],
    // Multi-race payoffs print in the pool's SETTLING race, as on real charts.
    exotics: [
      { betType: 'daily_double', baseCents: 200, combination: '3/1-5', payoutCents: 5000 },
    ],
    scratchedPgms: ['8'],
  },
]);

const g = (t) => gradeTicket(t, day);
const T = (betType, races, legs, stakeCents, costCents) =>
  ({ betType, races, legs, stakeCents, costCents: costCents ?? stakeCents });

let r = g(T('win', [1], [['3']], 400));
check('win hit: $4 at $14.40 returns $28.80', r.outcome === 'win' && r.returnedCents === 2880, JSON.stringify(r));
r = g(T('win', [1], [['7']], 400));
check('win on the runner-up loses', r.outcome === 'loss' && r.returnedCents === 0);
r = g(T('place', [1], [['7']], 400));
check('place hit on 2nd: $4 at $6.20 returns $12.40', r.outcome === 'win' && r.returnedCents === 1240);
r = g(T('show', [1], [['2']], 200));
check('show hit on 3rd: $2 at $2.80 returns $2.80', r.outcome === 'win' && r.returnedCents === 280);
r = g(T('show', [1], [['4']], 200));
check('show on 4th loses', r.outcome === 'loss');
r = g(T('win', [1], [['9']], 600));
check('WPS on a scratched horse refunds the stake', r.outcome === 'refund' && r.returnedCents === 600 && r.plCents === 0);

r = g(T('parlay', [1, 2], [['3'], ['5']], 200));
check('parlay both legs win: $2 x 14.40/2 x 8.00/2 = $57.60',
  r.outcome === 'win' && r.returnedCents === Math.round(200 * (1440 / 200) * (800 / 200)), JSON.stringify(r));
r = g(T('parlay', [1, 2], [['3'], ['1']], 200));
check('parlay with a lost leg loses whole', r.outcome === 'loss' && r.returnedCents === 0);
r = g(T('parlay', [1, 2], [['9'], ['5']], 200));
check('parlay scratched leg passes through at factor 1',
  r.outcome === 'win' && r.returnedCents === Math.round(200 * (800 / 200)) && /passed through/.test(r.note));
r = g(T('parlay', [1, 2], [['9'], ['8']], 200));
check('parlay with every leg scratched refunds', r.outcome === 'refund' && r.returnedCents === 200);

r = g(T('daily_double', [1, 2], [['3'], ['5']], 200));
check('double hit ($2 base, alternate first leg "3/1"): pays $50', r.outcome === 'win' && r.returnedCents === 5000);
r = g(T('daily_double', [1, 2], [['4'], ['5']], 200));
check('double miss loses', r.outcome === 'loss');
r = g(T('daily_double', [1, 2], [['3'], ['8']], 200));
check('double with a scratched-out leg refunds whole', r.outcome === 'refund' && r.returnedCents === 200);

r = g(T('exacta', [1], [['3'], ['7']], 300));
check('straight exacta hit: $3 at $25.60/$1 returns $76.80', r.outcome === 'win' && r.returnedCents === 7680);
r = g(T('exacta', [1], [['7'], ['3']], 300));
check('straight exacta reversed loses', r.outcome === 'loss');
r = g(T('exacta', [1], [['3'], ['7', '9']], 100, 200));
check('exacta with one scratched combo: hit + pro-rata refund = $25.60 + $1',
  r.outcome === 'win' && r.returnedCents === 2560 + 100 && /refunded/.test(r.note), JSON.stringify(r));
r = g(T('exacta', [1], [['4'], ['7', '9']], 100, 200));
check('exacta miss with one scratched combo grades partial ($1 back)',
  r.outcome === 'partial' && r.returnedCents === 100 && r.plCents === -100);
r = g(T('exacta_box', [1], [['3', '7', '9']], 100, 600));
check('exacta box with a scratched member: hit + refund of the 4 dead perms',
  r.outcome === 'win' && r.returnedCents === 2560 + 400, JSON.stringify(r));
r = g(T('quinella', [1], [['7', '3']], 200));
check('quinella is order-insensitive (no quinella row here -> loss, honest note)',
  r.outcome === 'loss' && /no quinella payoff/.test(r.note));
r = g(T('trifecta', [1], [['3'], ['7'], ['2']], 50));
check('trifecta hit: 50c at $41.20/50c returns $41.20', r.outcome === 'win' && r.returnedCents === 4120);
r = g(T('exacta', [1], [['9'], ['9']], 100));
check('exotic with every combination scratched refunds whole', r.outcome === 'refund' && r.returnedCents === 100);
r = g(T('martingale', [1], [['3']], 100));
check('unknown bet type grades loss with an honest note', r.outcome === 'loss' && /unknown bet type/.test(r.note));
r = g(T('win', [7], [['3']], 100));
check('missing race results grade loss + ungradable note', r.outcome === 'loss' && /ungradable/.test(r.note));

const miniGrades = gradeCard([
  T('win', [1], [['3']], 400), T('win', [1], [['9']], 600), T('exacta', [1], [['7'], ['3']], 300),
], day);
check('gradeCard summary: cost/returned/P&L consistent, outcomes counted', (() => {
  const s = miniGrades.summary;
  return s.costCents === 1300 && s.returnedCents === 2880 + 600 &&
    s.plCents === s.returnedCents - s.costCents &&
    s.outcomes.win === 1 && s.outcomes.refund === 1 && s.outcomes.loss === 1 &&
    Math.abs(s.topTicketShare - 2880 / 3480) < 1e-9;
})(), JSON.stringify(miniGrades.summary));

// ---------- the real day, pure ----------

console.log('-- real Del Mar day, pure --');

const prog = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/days/delmar-2026-08-30.entries.json'), 'utf8'));
const sftb = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sources/sftb-delmar-2026-08-30.expected.json'), 'utf8'));
const chart = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/charts/dmr-2026-08-30.expected.json'), 'utf8'));

const toDbEntry = (e) => ({
  program_number: e.programNumber, horse_name: e.horseName,
  morning_line: e.morningLine, morning_line_decimal: e.morningLineDecimal,
  program_rank: e.programRank, best_bet: e.bestBet ? 1 : 0,
  scratched: e.scratched ? 1 : 0,
});
const entriesByRace = Object.fromEntries(prog.races.map((x) => [x.number, x.entries.map(toDbEntry)]));
// The card this grades used to be generated here by the lean engine from a
// pick set and its D09 classification. D111 deleted the engine and D112 the
// classification, so the card is a FROZEN FIXTURE - the exact 30-ticket, $200
// set the engine last produced from this same program golden, which is still
// parsed for real above and supplies the entries the chart's scratches
// resolve against. Nothing about this proof weakened: the grader is what is
// under test, and it is handed the identical tickets it was handed before.
const card = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests/fixtures/engine-cards/delmar-2026-08-30.lean-1.1.json'), 'utf8'));

// The chart's grading view; scratches resolve to program numbers by name
// against the program entries - same policy the server applies at save.
const dayReal = buildDayResults(chart.races.map((x) => ({
  number: x.number,
  results: x.results.map((res) => ({
    programNumber: res.programNumber, finishPosition: res.finishPosition,
    winCents: res.winCents, placeCents: res.placeCents, showCents: res.showCents,
  })),
  exotics: x.exotics,
  scratchedPgms: (x.scratches ?? []).map((s) =>
    entriesByRace[x.number]?.find((e) => nameKey(e.horse_name) === nameKey(s.horseName))?.program_number)
    .filter((p) => p != null),
})));

const tickets = card.tickets.map((t, i) => ({
  id: i + 1, betType: t.betType, races: t.raceNumbers, legs: t.legs,
  stakeCents: t.stakeCents, costCents: t.costCents,
}));
const real = gradeCard(tickets, dayReal);
const byTicket = new Map(real.grades.map((x) => [x.ticket.id, x]));

check('every ticket on the card graded, one grade each',
  real.grades.length === tickets.length && real.grades.every((x) => ['win', 'loss', 'refund', 'partial'].includes(x.outcome)));
check('summary cost equals the full $200 bankroll', real.summary.costCents === 20000, `${real.summary.costCents}`);
check('summary P/L = returned - cost; per-ticket P/L sums to it', (() => {
  const sum = real.grades.reduce((a, x) => a + x.plCents, 0);
  return real.summary.plCents === real.summary.returnedCents - real.summary.costCents &&
    sum === real.summary.plCents;
})());
check('outcome counts sum to the ticket count',
  Object.values(real.summary.outcomes).reduce((a, n) => a + n, 0) === tickets.length);

// Hand-audited: R1's exacta 1-6 paid $10.30 per $1. The fade-the-price
// exacta (favorite on top over the field) cashes at stake/100 * 1030.
check('R1 fade exacta cashes at the printed $10.30 per $1', (() => {
  const t = tickets.find((x) => x.betType === 'exacta' && x.races[0] === 1 && x.legs[0].includes('1') && x.legs[1].includes('6'));
  if (!t) return false;
  const grade = byTicket.get(t.id);
  return grade.outcome === 'win' &&
    grade.returnedCents >= Math.round(t.stakeCents / 100 * 1030) &&
    grade.plCents === grade.returnedCents - t.costCents;
})(), JSON.stringify(real.grades.filter((x) => x.ticket.races[0] === 1 && x.ticket.races.length === 1)));

// Hand-audited: R3 winner is #2 Danzing Flyer, $16.40 win / $8.20 place.
check('R3 win on #2 pays exact $16.40 math', (() => {
  const t = tickets.find((x) => x.betType === 'win' && x.races[0] === 3 && x.legs[0][0] === '2');
  return t && byTicket.get(t.id).outcome === 'win' &&
    byTicket.get(t.id).returnedCents === Math.round(t.stakeCents * 1640 / 200);
})(), JSON.stringify(real.grades.filter((x) => x.ticket.races[0] === 3 && x.ticket.races.length === 1)));
check('R3 place money (the mandatory pair) pays exact $8.20 math', (() => {
  const t = tickets.find((x) => x.betType === 'place' && x.races[0] === 3 && x.legs[0][0] === '2');
  return t && byTicket.get(t.id).outcome === 'win' &&
    byTicket.get(t.id).returnedCents === Math.round(t.stakeCents * 820 / 200);
})());

// Hand-audited: the parlay rides the unanimous races 1 and 7, and both
// tops won - Howie's Law at $2.80 and Rabeeba at $4.20. $2 x 1.4 x 2.1
// = $5.88, exact.
check('the consensus parlay (R1+R7) cashes at exact chained win math: $5.88', (() => {
  const t = tickets.find((x) => x.betType === 'parlay');
  if (!t || t.races.join(',') !== '1,7') return false;
  const grade = byTicket.get(t.id);
  return grade.outcome === 'win' && grade.returnedCents === 588;
})(), JSON.stringify(real.grades.find((x) => x.ticket.betType === 'parlay')));

// ---------- server round-trip ----------

console.log('-- server round-trip --');
const PORT = 8904;
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

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); }
  }
  check('server boots', up, serverOut.slice(-300));

  const saved = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: '2026-08-30', bankrollCents: 20000, perRaceMinCents: 500,
    races: prog.races,
  })).json();

  // Was the engine's generate route until D111 removed it. A human card
  // locked race by race is the cheapest surviving producer, and nothing in
  // this file's subject - the GRADER - cares which one wrote the tickets.
  const storedDay = await (await fetch(`${BASE}/api/race-days/${saved.id}`)).json();
  const dayPgms = livePgms(storedDay);
  const lockRaces = storedDay.races
    .map((r) => ({ race: r.number, text: winAndBoxText(dayPgms[r.number] ?? []) }))
    .filter((r) => (dayPgms[r.race] ?? []).length >= 3);
  const genCardId = await makeHumanCard(jpost, saved.id, lockRaces);
  const genCard = await (await fetch(`${BASE}/api/cards/${genCardId}`)).json();
  genCard.correlationId = genCard.correlation_id;
  const preGrades = await (await fetch(`${BASE}/api/cards/${genCardId}/grades`)).json();
  check('card created before results: no grade yet',
    !preGrades.summary || preGrades.grades.length === 0,
    JSON.stringify(preGrades.summary ?? null));

  // Before any results land, the card document must still carry the results
  // key, empty - the sheet renders a per-race panel only where a finisher
  // exists, so "no results yet" has to be an empty list, never a missing key
  // the client would have to guard against.
  const preDoc = await (await fetch(`${BASE}/api/cards/${genCardId}`)).json();
  check('before results: card carries an EMPTY results set, not a missing key', (() => {
    const r = preDoc.results;
    return r && r.finishers.length === 0 && r.exotics.length === 0 && r.scratches.length === 0;
  })(), JSON.stringify(preDoc.results));

  const early = await jpost(`/api/cards/${genCard.id}/grade`, {});
  check('grading before results is refused (409)', early.status === 409,
    `${early.status} ${JSON.stringify(await early.json())}`);

  const resSave = await jpost(`/api/race-days/${saved.id}/results`, {
    track: chart.track, date: chart.date, sourceKind: 'paste', races: chart.races,
  });
  const resBody = await resSave.json();
  check('results save auto-grades every card of the day', (() => {
    const mine = (resBody.gradedCards ?? []).find((c) => c.cardId === genCard.id);
    return resSave.status === 201 && mine && Number.isInteger(mine.plCents);
  })(), JSON.stringify(resBody));

  const dayResultsRead = await (await fetch(`${BASE}/api/race-days/${saved.id}/results`)).json();
  check('chart scratches resolved to program numbers via the day\'s entries',
    dayResultsRead.scratches.length > 0 &&
    dayResultsRead.scratches.some((s) => s.program_number != null),
    JSON.stringify(dayResultsRead.scratches.slice(0, 3)));

  // The sheet renders a per-race results panel straight off GET /cards/:id,
  // so the card document has to carry the day's results - and carry them
  // SEPARATELY from the footer's program-time scratches, which are a
  // different set of horses (entries.scratched, known before the race) than
  // the chart's (result_scratches).
  const cardDoc = await (await fetch(`${BASE}/api/cards/${genCard.id}`)).json();
  check('card document carries the day results (finishers, exotics, scratches)', (() => {
    const r = cardDoc.results;
    return r && Array.isArray(r.finishers) && Array.isArray(r.exotics) && Array.isArray(r.scratches) &&
      r.finishers.length === dayResultsRead.results.length &&
      r.exotics.length === dayResultsRead.exotics.length &&
      r.scratches.length === dayResultsRead.scratches.length;
  })(), JSON.stringify({ got: Object.keys(cardDoc.results ?? {}), finishers: cardDoc.results?.finishers?.length }));
  check('card results agree with the day results endpoint, row for row', (() => {
    const key = (f) => `${f.race_number}|${f.finish_position}|${f.program_number}|${f.win_cents}`;
    return cardDoc.results.finishers.map(key).join(',') === dayResultsRead.results.map(key).join(',');
  })());
  check("chart scratches stay OUT of the footer's program-time scratch list", (() => {
    // Both lists exist and are not the same thing: the footer's come from
    // entries.scratched, the results panel's from the chart.
    const footer = (cardDoc.scratches ?? []).map((s) => `${s.race_number}#${s.program_number}`).sort();
    const chartScr = cardDoc.results.scratches.map((s) => `${s.race_number}#${s.program_number}`).sort();
    return Array.isArray(cardDoc.scratches) && chartScr.length > 0 &&
      JSON.stringify(footer) !== JSON.stringify(chartScr);
  })(), JSON.stringify({ footer: cardDoc.scratches?.length, chart: cardDoc.results.scratches.length }));
  check('every race with a finisher can render a panel (finish positions ordered, winner present)', (() => {
    const byRace = new Map();
    for (const f of cardDoc.results.finishers) {
      if (!byRace.has(f.race_number)) byRace.set(f.race_number, []);
      byRace.get(f.race_number).push(f);
    }
    if (byRace.size === 0) return false;
    return [...byRace.values()].every((rows) => rows.some((r) => r.finish_position === 1) &&
      rows.every((r, i) => i === 0 || rows[i - 1].finish_position <= r.finish_position));
  })(), `${new Set(cardDoc.results.finishers.map((f) => f.race_number)).size} races with finishers`);

  const grades = await (await fetch(`${BASE}/api/cards/${genCard.id}/grades`)).json();
  check('grades read back: one row per ticket, summary consistent', (() => {
    const s = grades.summary;
    return grades.grades.length === genCard.tickets.length &&
      s && s.plCents === s.returnedCents - s.costCents &&
      s.plCents === resBody.gradedCards.find((c) => c.cardId === genCard.id).plCents;
  })(), JSON.stringify(grades.summary));
  // The server's card differs from the pure-layer card (its sources are the
  // two pasted digests, not SFTB), so compare on the server's OWN tickets:
  // pure grader over the same tickets + same chart must equal what the
  // server persisted.
  check('server grades match the pure grader on the server\'s own tickets', (() => {
    const serverTickets = grades.grades.map((row) => ({
      id: row.ticket_id, betType: row.bet_type,
      races: row.selections.races, legs: row.selections.legs,
      stakeCents: row.stake_cents, costCents: row.cost_cents,
    }));
    const pure = gradeCard(serverTickets, dayReal);
    return pure.summary.plCents === grades.summary.plCents &&
      pure.summary.returnedCents === grades.summary.returnedCents;
  })(), JSON.stringify(grades.summary));

  const regrade = await jpost(`/api/cards/${genCard.id}/grade`, {});
  check('explicit regrade replaces, not duplicates', (() => regrade.status === 201)());
  const grades2 = await (await fetch(`${BASE}/api/cards/${genCard.id}/grades`)).json();
  check('after regrade still one row per ticket, same P/L',
    grades2.grades.length === genCard.tickets.length && grades2.summary.plCents === grades.summary.plCents);

  // A brand-new card created AFTER the chart has landed must grade in the
  // same call (omitting cardId always starts a new card, D28). The producer
  // changed with D111; the auto-grade-on-create behaviour under test did not.
  const gen2 = await (await jpost(`/api/race-days/${saved.id}/human-cards`,
    { race: lockRaces[0].race, text: lockRaces[0].text })).json();
  check('a card created AFTER results grades immediately (graded summary in the response)',
    gen2.graded && Number.isInteger(gen2.graded.summary?.plCents ?? gen2.graded.plCents),
    JSON.stringify(gen2.graded ?? null));

  await new Promise((rr) => setTimeout(rr, 300));
  const traceFile = path.join(logDir, 'decision-trace.jsonl');
  const traceLines = fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  check('trace: ticket_graded per ticket + card_graded, under the CARD\'s correlation id (invariant 8)', (() => {
    const graded = traceLines.filter((l) => l.event === 'ticket_graded' && l.cardId === genCard.id);
    const fin = traceLines.filter((l) => l.event === 'card_graded' && l.cardId === genCard.id);
    return graded.length >= genCard.tickets.length &&
      graded.every((l) => l.correlationId === genCard.correlationId) &&
      fin.length >= 1 && fin.every((l) => l.correlationId === genCard.correlationId);
  })(), `trace lines total=${traceLines.length}`);
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-grading: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-grading: all checks passed');
