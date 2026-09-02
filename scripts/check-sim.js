// Verification for the simulator (D19) - exits non-zero on any failure.
// Run: npm run check-sim
//
// Runs against the real server on a temp DB with check-pl's three-day
// scenario: A) the real Del Mar fixtures, two sources -> FULL, two live
// card variants, the real chart; B) a synthetic PROGRAM_ONLY day with a
// synthetic chart; C) a day with a card and NO results. Then: every
// template runs over the history; a simulated day equals the live card
// graded on that day (same engine, same grader, same chart); buckets
// never pool (13); deleted days drop out (12); runs are append-only; the
// trace carries one simulation_run event per run.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { TEMPLATES } = await import('../shared/templates.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-simcheck-'));

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
      // Delta Blues is the program's Best Bet: the D48 best-bet curve keys on it (a day with no Best Bet is flat = lean here).
      { ...synthEntry('1', 'Delta Blues', '3/1', 3, 1), bestBet: true }, synthEntry('2', 'Epsilon Star', '5/1', 5, 2),
      synthEntry('3', 'Zeta Function', '10/1', 10, 3),
    ] },
  ],
};
const synthChart = {
  track: 'SANTA ANITA', date: '2026-08-30',
  races: [
    // D50: Beta Cruiser is a CHART scratch (name only, resolved to #2 at
    // save exactly as grading does). Lean as generated boxes 1-2 and gets a
    // partial refund; built at the window it never names #2.
    { number: 1, results: [
      { programNumber: '1', horseName: 'Alpha Marker', finishPosition: 1, winCents: 600, placeCents: 340, showCents: 280 },
      { programNumber: '3', horseName: 'Gamma Ray Burst', finishPosition: 2, winCents: null, placeCents: 700, showCents: 420 },
    ], exotics: [
      { betType: 'exacta', baseCents: 100, combination: '1-3', payoutCents: 1980, poolCents: 100000 },
    ], scratches: [{ horseName: 'Beta Cruiser', reason: 'Veterinarian' }] },
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

const PORT = 8908;
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

  console.log('-- run every template --');
  const names = Object.keys(TEMPLATES);
  const runRes = await jpost('/api/simulations', {});
  const runBody = await runRes.json();
  check('POST /simulations: 201, one run per template in template order, a correlation id',
    runRes.status === 201 && runBody.runs.length === names.length &&
    runBody.runs.map((r) => r.template).join(',') === names.join(',') && typeof runBody.correlationId === 'string',
    JSON.stringify({ status: runRes.status, templates: runBody.runs?.map((r) => r.template) }));
  check('every run covers exactly the two days with charts (day C has no results -> excluded)',
    runBody.runs.every((r) => r.daysInRun === 2 && r.days.length === 2 &&
      r.days.every((d) => [dayA.id, dayB.id].includes(d.raceDayId))));
  check('run shape: buckets + days + params and NO pooled total (invariant 13)',
    runBody.runs.every((r) => Array.isArray(r.buckets) && !('plCents' in r) && !('total' in r) && !('costCents' in r)));
  check('FULL bucket holds only day A, PROGRAM_ONLY only day B, nothing else',
    runBody.runs.every((r) => {
      const f = r.buckets.find((b) => b.completeness === 'FULL');
      const p = r.buckets.find((b) => b.completeness === 'PROGRAM_ONLY');
      return r.buckets.length === 2 && f?.days === 1 && p?.days === 1 &&
        f.series[0].raceDayId === dayA.id && p.series[0].raceDayId === dayB.id;
    }), JSON.stringify(runBody.runs[0]?.buckets.map((b) => [b.completeness, b.days])));
  check('each bucket sums only its own days; pl = returned - cost', runBody.runs.every((r) => r.buckets.every((b) => {
    const mine = r.days.filter((d) => d.completeness === b.completeness);
    const s = (k) => mine.reduce((a, d) => a + d[k], 0);
    return s('costCents') === b.costCents && s('returnedCents') === b.returnedCents &&
      s('plCents') === b.plCents && b.plCents === b.returnedCents - b.costCents && b.tickets === s('tickets');
  })));
  check('series: running P/L is the cumulative sum in date order and ends at the bucket total',
    runBody.runs.every((r) => r.buckets.every((b) => {
      let acc = 0;
      return b.series.every((d, i) => { acc += d.plCents; return d.runningCents === acc && (i === 0 || d.date >= b.series[i - 1].date); }) &&
        b.series[b.series.length - 1].runningCents === b.plCents && b.series.every((d) => d.bankrollCents === null);
    })));

  console.log('-- a simulated day IS the live computation --');
  const lean = runBody.runs.find((r) => r.template === 'lean');
  const leanA = lean.days.find((d) => d.raceDayId === dayA.id);
  const liveA1 = await jget(`/api/cards/${cardA1.id}/grades`);
  check('simulated lean on day A == the live lean card graded on day A (same engine, same grader, same chart)',
    leanA.plCents === liveA1.summary.plCents && leanA.costCents === liveA1.summary.costCents &&
    leanA.returnedCents === liveA1.summary.returnedCents && leanA.tickets === liveA1.grades.length,
    JSON.stringify({ sim: leanA, live: liveA1.summary }));
  const noFadeA = runBody.runs.find((r) => r.template === 'no-fade').days.find((d) => d.raceDayId === dayA.id);
  const liveA2 = await jget(`/api/cards/${cardA2.id}/grades`);
  check('simulated no-fade == the live fadeThePrice:false variant',
    noFadeA.plCents === liveA2.summary.plCents && noFadeA.costCents === liveA2.summary.costCents);
  const leanB = lean.days.find((d) => d.raceDayId === dayB.id);
  const liveB = await jget(`/api/cards/${cardB.id}/grades`);
  check('simulated lean on the PROGRAM_ONLY day == its live card', leanB.plCents === liveB.summary.plCents);
  const noPlace = runBody.runs.find((r) => r.template === 'no-place-money');
  const leanDet = await jget(`/api/simulations/${lean.runId}/days/${dayA.id}`);
  const noPlaceDet = await jget(`/api/simulations/${noPlace.runId}/days/${dayA.id}`);
  check('per-day detail: every ticket with outcome + rule tags; lean carries place-money tickets, the simulation-only template none',
    leanDet.ticketDetails.length === leanA.tickets &&
    leanDet.ticketDetails.every((t) => Array.isArray(t.ruleTags) && ['win', 'refund', 'partial', 'loss'].includes(t.outcome)) &&
    leanDet.ticketDetails.some((t) => t.betType === 'place') &&
    noPlace.simulationOnly === true && !noPlaceDet.ticketDetails.some((t) => t.betType === 'place'));
  // D48: the four program-rank templates run in simulation (they are refused live) and DIVERGE from lean on the PROGRAM_ONLY day.
  const ticketKey = (det) => JSON.stringify(det.ticketDetails.map((t) => [t.betType, t.races, t.legs, t.stakeCents, t.costCents]));
  const leanBdet = await jget(`/api/simulations/${lean.runId}/days/${dayB.id}`);
  const d48 = {};
  for (const n of ['exacta-primary', 'no-exotics', 'box-depth-3', 'best-bet-weighted', 'box-only', 'straight-only']) d48[n] = await jget(`/api/simulations/${runBody.runs.find((r) => r.template === n).runId}/days/${dayB.id}`);
  check('D48 + D49 templates all ran (simulation allows what the live endpoint refuses) and every one differs from lean on the PROGRAM_ONLY day',
    Object.values(d48).every((det) => det.ticketDetails.length > 0) && Object.entries(d48).every(([, det]) => ticketKey(det) !== ticketKey(leanBdet)),
    JSON.stringify(Object.fromEntries(Object.entries(d48).map(([n, det]) => [n, det.ticketDetails.map((t) => t.betType + ':' + t.stakeCents)]))));
  // D49: the isolation pair - box-only has no straight exacta, straight-only
  // no exacta box, and the two differ from each other and from no-exotics.
  check('D49 on the PROGRAM_ONLY day: box-only = win/place + exacta_box only, straight-only = win/place + straight exacta only; four distinct ticket sets with lean and no-exotics; each still the whole bankroll',
    d48['box-only'].ticketDetails.every((t) => ['win', 'place', 'exacta_box'].includes(t.betType)) && d48['box-only'].ticketDetails.some((t) => t.betType === 'exacta_box') &&
    d48['straight-only'].ticketDetails.every((t) => ['win', 'place', 'exacta'].includes(t.betType)) && d48['straight-only'].ticketDetails.some((t) => t.betType === 'exacta') &&
    new Set([leanBdet, d48['no-exotics'], d48['box-only'], d48['straight-only']].map(ticketKey)).size === 4 &&
    d48['box-only'].costCents === 5000 && d48['straight-only'].costCents === 5000,
    JSON.stringify({ box: d48['box-only'].ticketDetails.map((t) => t.betType), straight: d48['straight-only'].ticketDetails.map((t) => t.betType) }));
  check('D48 no-exotics on the PROGRAM_ONLY day: win / place only; exacta-primary: win tickets at the per-race minimum and no place ticket',
    d48['no-exotics'].ticketDetails.every((t) => ['win', 'place'].includes(t.betType)) && d48['exacta-primary'].ticketDetails.filter((t) => t.betType === 'win').every((t) => t.stakeCents === 500) && !d48['exacta-primary'].ticketDetails.some((t) => t.betType === 'place'));
  const soB = await jget(`/api/simulations/${runBody.runs.find((r) => r.template === 'structure-only').runId}/days/${dayB.id}`);
  check('structure-only on the PROGRAM_ONLY day: single-race tickets only, still a whole day',
    soB.ticketDetails.length > 0 && soB.ticketDetails.every((t) => t.races.length === 1) && soB.costCents === 5000);

  console.log('-- D50: chart scratches applied before generation (the at-the-window baseline) --');
  // The default mode is what every check above measured: identical to the
  // live card, refunds included. Day B's chart scratches #2 (a name-only
  // chart scratch resolved at save), so lean as generated boxes 1-2 and
  // gets a partial refund there.
  check('default mode: runs record applyChartScratchesBeforeGeneration=false, mode as_generated, and lean as generated carries the refund on day B (the box named the chart-scratched #2)',
    runBody.runs.every((r) => r.applyChartScratchesBeforeGeneration === false && r.mode === 'as_generated') &&
    (leanBdet.outcomes.refund ?? 0) + (leanBdet.outcomes.partial ?? 0) > 0 && leanBdet.ticketDetails.some((t) => t.races[0] === 1 && t.legs.flat().includes('2')),
    JSON.stringify(leanBdet.outcomes));
  const scratchRun = await (await jpost('/api/simulations', { templates: ['lean'], applyChartScratchesBeforeGeneration: true })).json();
  const sLean = scratchRun.runs[0];
  check('scratch mode: the run records the flag, mode chart_scratches_applied, a scratch count, and still covers exactly the two days with results (day C skipped either way)',
    sLean.applyChartScratchesBeforeGeneration === true && sLean.mode === 'chart_scratches_applied' && sLean.scratchesApplied > 0 && sLean.daysInRun === 2 && sLean.days.length === 2,
    JSON.stringify({ flag: sLean.applyChartScratchesBeforeGeneration, mode: sLean.mode, n: sLean.scratchesApplied, days: sLean.daysInRun }));
  const sB = await jget(`/api/simulations/${sLean.runId}/days/${dayB.id}`);
  check('scratch mode on day B: no ticket names the chart-scratched #2, zero refunds / partials at grading, the day is still the whole bankroll, and the ticket set differs from the as-generated one',
    !sB.ticketDetails.some((t) => t.races.includes(1) && t.legs.flat().includes('2')) && !sB.outcomes.refund && !sB.outcomes.partial &&
    sB.costCents === 5000 && ticketKey(sB) !== ticketKey(leanBdet),
    JSON.stringify({ outcomes: sB.outcomes, tickets: sB.ticketDetails.map((t) => t.betType + ':' + t.legs.flat().join('/')) }));
  // Day A: the REAL chart's scratches (R2 x4, R5, R8, R10 x2), resolved by name against the real program's entries.
  const chartScratched = new Map();
  for (const r of chart.races) for (const s of r.scratches ?? []) {
    const e = prog.races.find((x) => x.number === r.number)?.entries.find((x) => x.horseName.toUpperCase() === s.horseName.toUpperCase());
    if (e) chartScratched.set(`${r.number}|${e.programNumber}`, s.horseName);
  }
  const sA = await jget(`/api/simulations/${sLean.runId}/days/${dayA.id}`);
  const namesScratched = (det) => det.ticketDetails.flatMap((t) => t.races.flatMap((race, i) => (t.legs[i] ?? []).filter((p) => chartScratched.has(`${race}|${p}`)).map((p) => `R${race} #${p}`)));
  check(`scratch mode on the real day: the chart's ${chartScratched.size} scratches resolve to program numbers, no ticket names any of them, zero refunds / partials at grading`,
    chartScratched.size >= 6 && namesScratched(sA).length === 0 && !sA.outcomes.refund && !sA.outcomes.partial && sA.ticketDetails.length > 0,
    JSON.stringify({ named: namesScratched(sA), outcomes: sA.outcomes }));
  check('the stored day is untouched: the default-mode identity with the live card still holds on a fresh as-generated run after the scratch run',
    (await (await jpost('/api/simulations', { templates: ['lean'] })).json()).runs[0].days.find((d) => d.raceDayId === dayA.id).plCents === liveA1.summary.plCents);
  check('a non-boolean applyChartScratchesBeforeGeneration -> 400', (await jpost('/api/simulations', { applyChartScratchesBeforeGeneration: 'yes' })).status === 400);
  const cmpModes = await jget('/api/simulations/compare');
  check('compare groups by (template, mode): lean has TWO rows - as_generated and chart_scratches_applied - never pooled; every other template one row',
    cmpModes.templates.filter((t) => t.template === 'lean').map((t) => t.mode).sort().join() === 'as_generated,chart_scratches_applied' &&
    cmpModes.templates.filter((t) => t.template === 'lean' && t.mode === 'chart_scratches_applied')[0].runId === sLean.runId &&
    cmpModes.templates.length === names.length + 1 && names.filter((n) => n !== 'lean').every((n) => cmpModes.templates.filter((t) => t.template === n).length === 1),
    JSON.stringify(cmpModes.templates.map((t) => [t.template, t.mode, t.runId])));

  console.log('-- overrides, listing, compare, append-only --');
  const over = await (await jpost('/api/simulations', { templates: ['lean'], bankrollCents: 10000, startingBankrollCents: 50000 })).json();
  check('bankroll override applies to every day; starting bankroll shapes the series',
    over.runs.length === 1 && over.runs[0].days.every((d) => d.costCents === 10000) &&
    over.runs[0].buckets.every((b) => b.series.every((d) => d.bankrollCents === 50000 + d.runningCents)),
    JSON.stringify(over.runs?.[0]?.days.map((d) => d.costCents)));
  check('unknown template -> 400', (await jpost('/api/simulations', { templates: ['nope'] })).status === 400);
  check('bad bankroll -> 400', (await jpost('/api/simulations', { bankrollCents: -5 })).status === 400);
  const list = await jget('/api/simulations');
  check('GET /simulations: every run, newest first', list.runs.length === names.length + 3 && list.runs[0].runId === over.runs[0].runId);
  const cmp = await jget('/api/simulations/compare');
  const cmpAsGen = cmp.templates.filter((t) => t.mode === 'as_generated');
  check('compare: the latest run per (template, mode) - as-generated lean is the override run, the rest the first pass, the scratch-mode lean row stays beside it',
    cmpAsGen.length === names.length && cmpAsGen.map((t) => t.template).join(',') === names.join(',') &&
    cmpAsGen.find((t) => t.template === 'lean').runId === over.runs[0].runId && cmp.templates.length === names.length + 1 &&
    cmp.templates.every((t) => Array.isArray(t.buckets) && !('days' in t)));
  check('runs are append-only: the earlier lean run still reads back unchanged',
    (await jget(`/api/simulations/${lean.runId}`)).buckets[0].plCents === lean.buckets[0].plCents && over.runs[0].runId > lean.runId);
  check('unknown run -> 404', (await fetch(`${BASE}/api/simulations/999999`)).status === 404);

  console.log('-- soft delete drops out of every aggregate (invariant 12) --');
  await fetch(`${BASE}/api/race-days/${dayB.id}`, { method: 'DELETE' });
  const leanAfter = await jget(`/api/simulations/${lean.runId}`);
  check('deleted day leaves an existing run: PROGRAM_ONLY bucket gone, FULL untouched',
    !leanAfter.buckets.some((b) => b.completeness === 'PROGRAM_ONLY') && leanAfter.days.length === 1 &&
    leanAfter.buckets.find((b) => b.completeness === 'FULL').plCents === lean.buckets.find((b) => b.completeness === 'FULL').plCents);
  check('deleted day detail answers 410', (await fetch(`${BASE}/api/simulations/${lean.runId}/days/${dayB.id}`)).status === 410);
  const fresh = await (await jpost('/api/simulations', { templates: ['lean'] })).json();
  check('a new run skips the deleted day', fresh.runs[0].daysInRun === 1 && fresh.runs[0].days.length === 1);
  await jpost(`/api/race-days/${dayB.id}/restore`, {});
  check('restore brings the day back into the old run', (await jget(`/api/simulations/${lean.runId}`)).days.length === 2);

  console.log('-- trace --');
  await new Promise((rr) => setTimeout(rr, 300));
  const traceFile = path.join(logDir, 'decision-trace.jsonl');
  const traceLines = fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const simEvents = traceLines.filter((l) => l.event === 'simulation_run' && l.correlationId === runBody.correlationId);
  check('decision-trace: one simulation_run event per run under the POST correlation id, naming template, buckets and days',
    simEvents.length === names.length && simEvents.every((e) => runBody.runs.some((r) => r.runId === e.runId && r.template === e.template) &&
      Array.isArray(e.buckets) && e.days.length === 2), `events=${simEvents.length}`);
  const scratchEvent = traceLines.find((l) => l.event === 'simulation_run' && l.runId === sLean.runId);
  check('decision-trace: the scratch-mode run carries applyChartScratchesBeforeGeneration=true (top level + params) and the default runs false',
    scratchEvent?.applyChartScratchesBeforeGeneration === true && scratchEvent.params.applyChartScratchesBeforeGeneration === true && scratchEvent.params.scratchesApplied > 0 &&
    simEvents.every((e) => e.applyChartScratchesBeforeGeneration === false), JSON.stringify(scratchEvent?.params));
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-sim: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-sim: all checks passed');
