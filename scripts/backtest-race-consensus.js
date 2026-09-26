// Backtest for the combined per-race model (D434, DA of the combined-parlay
// plan). Run: npm run backtest-race-consensus [-- --db <path>] [--json <out>]
//
// READ-ONLY. Opens the database with `readonly: true` and never migrates it,
// writes no card, grades nothing into graded_tickets, logs no event. The only
// file it can write is the optional --json report.
//
// WHAT IT ASKS, in order:
//   1. Is the combined model a better forecaster of the WINNER than the market
//      it starts from? Log-loss and Brier per race, paired against the market
//      on the same races, with the mean difference's standard error - a
//      difference smaller than about two SEs is not a difference.
//   2. Which source carries it? Each source alone (tip sheets / LLM / OTR,
//      the others zeroed) against the same market.
//   3. Are the place/show probabilities (Harville) calibrated? Predicted vs
//      observed by decile, runner level.
//   4. What would a "most likely to cash" parlay have done? Per day, per leg
//      kind (win/place/show) and leg count, the legs with the highest P(hit)
//      - optionally subject to an estimated payout floor - graded with the
//      chart's REAL prices through shared/grading.js. Hit rate beside ROI,
//      because the take compounds on every leg and a parlay that cashes often
//      can still lose money.
//
// The chart's post-time odds are a REFERENCE row only ("the close") - never a
// model input, since they did not exist when anyone chose a horse. Every
// figure prints its n. Nothing here concludes; docs/findings/combined-parlay-v1.md
// does that, from this script's output.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { combineRace, DEFAULT_WEIGHTS, MARKET_ONLY_WEIGHTS } from '../shared/race-consensus.js';
import { impliedProbabilities } from '../shared/pick-scoring.js';
import { gradeTicket } from '../shared/grading.js';
import { loadDaySignals, gradedDayIds } from '../server/race-consensus.js';
import { loadDayResultsFor } from '../server/grading.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const dbPath = path.resolve(ROOT, arg('--db') ?? process.env.BETSHEET_DB ?? 'data/betsheet.sqlite');
const jsonOut = arg('--json');

// The take assumed by the payout-floor ESTIMATE only (never by grading, which
// uses real prices): a leg's estimated return per $1 is (1 - TAKE) / q, q the
// market's own probability of that leg hitting. A stated heuristic, labelled
// as one in the report; DB's builder replaces it with betmath estimates.
const TAKE = 0.17;
const FLOORS = [null, 2, 4];
const LEG_COUNTS = [2, 3];
const KINDS = ['win', 'place', 'show'];
const CANDIDATES_PER_RACE = 3;

const up = (p) => String(p).trim().toUpperCase();
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const se = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
};
const f = (x, d = 4) => (x === null || x === undefined ? '—' : x.toFixed(d));
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

const VARIANTS = {
  market: MARKET_ONLY_WEIGHTS,
  combined: DEFAULT_WEIGHTS,
  tipOnly: { ...MARKET_ONLY_WEIGHTS, tipTop: DEFAULT_WEIGHTS.tipTop, tipNamed: DEFAULT_WEIGHTS.tipNamed, maxBump: DEFAULT_WEIGHTS.maxBump },
  llmOnly: { ...MARKET_ONLY_WEIGHTS, llmPrimary: DEFAULT_WEIGHTS.llmPrimary, llmBacked: DEFAULT_WEIGHTS.llmBacked, maxBump: DEFAULT_WEIGHTS.maxBump },
  otrOnly: { ...MARKET_ONLY_WEIGHTS, otrWin: DEFAULT_WEIGHTS.otrWin, otrShow: DEFAULT_WEIGHTS.otrShow, maxBump: DEFAULT_WEIGHTS.maxBump },
};

function scoreForecast(runners, winners, key) {
  const pw = runners.filter((r) => winners.has(r.programNumber)).reduce((a, r) => a + r[key], 0);
  const brier = runners.reduce((a, r) => a + (r[key] - (winners.has(r.programNumber) ? 1 : 0)) ** 2, 0);
  const top = runners.reduce((b, r) => (r[key] > b[key] ? r : b), runners[0]);
  return { logLoss: -Math.log(Math.max(pw, 1e-9)), brier, topWon: winners.has(top.programNumber) };
}

function run(db) {
  const days = gradedDayIds(db);
  const races = [];              // one row per modellable, graded race
  const skipped = { noMarket: 0, noWinnerInField: 0, noResult: 0 };
  let llmPostResult = 0;
  const calib = { win: [], place: [], show: [] };   // [p, hit] runner-level, combined
  const byDay = [];

  for (const dayId of days) {
    const sig = loadDaySignals(db, dayId);
    const results = loadDayResultsFor(db, dayId);
    if (!sig || !results) continue;
    llmPostResult += sig.excluded.llmPostResult;
    const finishersByRace = new Map();
    for (const r of db.prepare('SELECT race_number, program_number, post_time_odds FROM race_results WHERE race_day_id = ?').all(dayId)) {
      if (!finishersByRace.has(r.race_number)) finishersByRace.set(r.race_number, []);
      finishersByRace.get(r.race_number).push({ programNumber: r.program_number, postTimeOdds: r.post_time_odds });
    }
    const dayRaces = [];
    for (const [raceNo, s] of [...sig.races].sort((a, b) => a[0] - b[0])) {
      const res = results.get(raceNo);
      if (!res) { skipped.noResult += 1; continue; }
      const models = {};
      for (const [name, weights] of Object.entries(VARIANTS)) {
        models[name] = combineRace({ entries: s.entries, tipRoles: s.tipRoles, llmRoles: s.llmRoles, otrRoles: s.otrRoles, weights });
      }
      if (!models.combined) { skipped.noMarket += 1; continue; }
      const winners = new Set([...(res.finishByPos.get(1) ?? [])].map(up));
      const inField = models.combined.runners.some((r) => winners.has(r.programNumber));
      if (!inField) { skipped.noWinnerInField += 1; continue; }
      const top2 = new Set([1, 2].flatMap((p) => [...(res.finishByPos.get(p) ?? [])]).map(up));
      const top3 = new Set([1, 2, 3].flatMap((p) => [...(res.finishByPos.get(p) ?? [])]).map(up));
      for (const r of models.combined.runners) {
        calib.win.push([r.combinedP, winners.has(r.programNumber)]);
        calib.place.push([r.placeP, top2.has(r.programNumber)]);
        calib.show.push([r.showP, top3.has(r.programNumber)]);
      }
      const hasSignal = s.tipRoles.length > 0 || s.llmRoles.length > 0 || s.otrRoles !== null;
      const scores = Object.fromEntries(Object.entries(models).map(([n, m]) => [n, scoreForecast(m.runners.map((r) => ({ ...r, p: r.combinedP })), winners, 'p')]));

      // The close: post-time odds, normalised - a reference, never an input.
      const close = impliedProbabilities(finishersByRace.get(raceNo) ?? []);
      let closeScore = null;
      if (close) {
        const rs = [...close].map(([programNumber, p]) => ({ programNumber, p }));
        if (rs.some((r) => winners.has(r.programNumber))) closeScore = scoreForecast(rs, winners, 'p');
      }
      const row = {
        dayId, raceNo, basis: models.combined.basis, hasSignal,
        sources: { tip: s.tipRoles.length, llm: s.llmRoles.length, otr: s.otrRoles !== null },
        scores, closeScore, models, res,
      };
      races.push(row);
      dayRaces.push(row);
    }
    byDay.push({ dayId, date: sig.day.date, track: sig.day.track_code ?? sig.day.track, races: dayRaces, results });
  }

  // ---- 1 + 2: forecasts ---------------------------------------------------
  const forecastTable = (rows, label) => {
    const out = { label, n: rows.length, variants: {} };
    for (const name of Object.keys(VARIANTS)) {
      const ll = rows.map((r) => r.scores[name].logLoss);
      const diff = rows.map((r) => r.scores[name].logLoss - r.scores.market.logLoss);
      out.variants[name] = {
        logLoss: mean(ll),
        brier: mean(rows.map((r) => r.scores[name].brier)),
        topWinRate: mean(rows.map((r) => (r.scores[name].topWon ? 1 : 0))),
        logLossVsMarket: mean(diff),
        seVsMarket: se(diff),
      };
    }
    const closeRows = rows.filter((r) => r.closeScore);
    out.close = {
      n: closeRows.length,
      logLoss: mean(closeRows.map((r) => r.closeScore.logLoss)),
      marketLogLossSameRaces: mean(closeRows.map((r) => r.scores.market.logLoss)),
      combinedLogLossSameRaces: mean(closeRows.map((r) => r.scores.combined.logLoss)),
    };
    return out;
  };
  const forecasts = [
    forecastTable(races, 'all graded races'),
    forecastTable(races.filter((r) => r.hasSignal), 'races with any source signal'),
    forecastTable(races.filter((r) => r.sources.tip && r.sources.llm), 'races with tip sheets AND an LLM card'),
    forecastTable(races.filter((r) => r.basis === 'live'), 'races priced off a typed live board'),
  ];

  // ---- 3: calibration -----------------------------------------------------
  const deciles = (pairs) => {
    const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, hits: 0 }));
    for (const [p, hit] of pairs) {
      const b = bins[Math.min(9, Math.floor(p * 10))];
      b.n += 1; b.p += p; b.hits += hit ? 1 : 0;
    }
    return bins.map((b, i) => ({ bin: `${i * 10}-${i * 10 + 10}%`, n: b.n, predicted: b.n ? b.p / b.n : null, observed: b.n ? b.hits / b.n : null }));
  };
  const calibration = { win: deciles(calib.win), place: deciles(calib.place), show: deciles(calib.show) };

  // ---- 4: parlays ---------------------------------------------------------
  const kindP = { win: 'combinedP', place: 'placeP', show: 'showP' };
  const parlays = [];
  for (const variant of ['market', 'combined']) {
    for (const kind of KINDS) {
      for (const legsN of LEG_COUNTS) {
        for (const floor of FLOORS) {
          const tally = { variant, kind, legs: legsN, floor, days: 0, hits: 0, predicted: [], costCents: 0, returnedCents: 0, refundedLegs: 0 };
          for (const d of byDay) {
            // Candidates per race: the top few by this kind's probability, each
            // with the MARKET's own probability for the same event (for the
            // payout estimate) - even under the combined variant, since the
            // tote pays off the crowd's book, not ours.
            const perRace = d.races.map((r) => {
              const m = r.models[variant];
              const mk = new Map(r.models.market.runners.map((x) => [x.programNumber, x]));
              const cands = [...m.runners].sort((a, b) => b[kindP[kind]] - a[kindP[kind]]).slice(0, CANDIDATES_PER_RACE)
                .map((x) => ({ raceNo: r.raceNo, pgm: x.programNumber, p: x[kindP[kind]], est: (1 - TAKE) / Math.max(1e-6, mk.get(x.programNumber)?.[kindP[kind]] ?? 1) }));
              return cands;
            });
            if (perRace.length < legsN) continue;
            const best = bestParlay(perRace, legsN, floor);
            if (!best) continue;
            tally.days += 1;
            tally.predicted.push(best.p);
            tally.costCents += 200;
            let factor = 1;
            let lost = false;
            for (const leg of best.legs) {
              const g = gradeTicket({ betType: kind, races: [leg.raceNo], legs: [[leg.pgm]], stakeCents: 200, costCents: 200 }, remapResults(d.results));
              if (g.outcome === 'refund') { tally.refundedLegs += 1; continue; }
              if (g.outcome !== 'win') { lost = true; break; }
              factor *= g.returnedCents / 200;
            }
            if (!lost) { tally.hits += 1; tally.returnedCents += Math.round(200 * factor); }
          }
          parlays.push({
            variant, kind, legs: legsN, floor, n: tally.days,
            hitRate: tally.days ? tally.hits / tally.days : null,
            hits: tally.hits,
            meanPredicted: mean(tally.predicted),
            costCents: tally.costCents, returnedCents: tally.returnedCents,
            roi: tally.costCents ? (tally.returnedCents - tally.costCents) / tally.costCents : null,
            refundedLegs: tally.refundedLegs,
          });
        }
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    db: dbPath,
    weights: DEFAULT_WEIGHTS,
    take: TAKE,
    corpus: {
      gradedDays: days.length, daysUsed: byDay.filter((d) => d.races.length).length, races: races.length,
      racesWithSignal: races.filter((r) => r.hasSignal).length,
      racesWithTip: races.filter((r) => r.sources.tip).length,
      racesWithLlm: races.filter((r) => r.sources.llm).length,
      racesWithOtr: races.filter((r) => r.sources.otr).length,
      racesLiveBasis: races.filter((r) => r.basis === 'live').length,
      skipped, llmPostResultExcluded: llmPostResult,
    },
    forecasts, calibration, parlays,
  };
  print(report);
  if (jsonOut) {
    fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nwrote ${path.resolve(jsonOut)}`);
  }
}

// gradeTicket keys results by race number and compares program numbers as
// stored; the model upper-cases them, so the results are re-keyed to match.
const remapCache = new WeakMap();
function remapResults(results) {
  if (remapCache.has(results)) return remapCache.get(results);
  const out = new Map();
  for (const [n, r] of results) {
    const finishByPos = new Map([...r.finishByPos].map(([pos, set]) => [pos, new Set([...set].map(up))]));
    const priceOf = new Map([...r.priceOf].map(([p, v]) => [up(p), v]));
    out.set(n, { ...r, finishByPos, priceOf, scratched: new Set([...r.scratched].map(up)) });
  }
  remapCache.set(results, out);
  return out;
}

/**
 * Exhaustive: every choice of `legsN` races, one candidate each, maximising
 * the product of P(hit) subject to the product of estimated multipliers
 * reaching `floor` (no constraint when null). Days are ~8-12 races with 3
 * candidates each, so C(12,3)·27 ≈ 6k products - no search heuristics needed.
 */
function bestParlay(perRace, legsN, floor) {
  let best = null;
  const pick = (start, chosen) => {
    if (chosen.length === legsN) {
      const p = chosen.reduce((a, c) => a * c.p, 1);
      const est = chosen.reduce((a, c) => a * c.est, 1);
      if (floor !== null && est < floor) return;
      if (!best || p > best.p) best = { p, est, legs: [...chosen] };
      return;
    }
    for (let i = start; i < perRace.length; i++) {
      for (const c of perRace[i]) { chosen.push(c); pick(i + 1, chosen); chosen.pop(); }
    }
  };
  pick(0, []);
  return best;
}

function print(r) {
  const c = r.corpus;
  console.log('Combined per-race model - backtest (read-only)');
  console.log(`db: ${r.db}`);
  console.log(`weights: ${JSON.stringify(r.weights)}`);
  console.log(`\ncorpus: ${c.gradedDays} graded days, ${c.daysUsed} used, ${c.races} races`);
  console.log(`  with a signal ${c.racesWithSignal} (tip ${c.racesWithTip}, llm ${c.racesWithLlm}, otr ${c.racesWithOtr}); live-board basis ${c.racesLiveBasis}`);
  console.log(`  skipped: ${JSON.stringify(c.skipped)}; LLM cards excluded as post-result: ${c.llmPostResultExcluded}`);

  console.log('\n1-2. WINNER FORECAST (lower log-loss/Brier is better; Δ vs market is paired on the same races)');
  for (const t of r.forecasts) {
    console.log(`\n  ${t.label}  (n=${t.n} races)`);
    console.log('    variant     logLoss   Δ vs mkt   ±SE      brier    top-pick won');
    for (const [name, v] of Object.entries(t.variants)) {
      console.log(`    ${name.padEnd(10)}  ${f(v.logLoss)}   ${f(v.logLossVsMarket).padStart(7)}   ${f(v.seVsMarket)}   ${f(v.brier)}   ${pct(v.topWinRate)}`);
    }
    console.log(`    the close (post-time odds, reference only; n=${t.close.n}): logLoss ${f(t.close.logLoss)} vs market ${f(t.close.marketLogLossSameRaces)} / combined ${f(t.close.combinedLogLossSameRaces)} on the same races`);
  }

  console.log('\n3. CALIBRATION, combined model, runner level (predicted vs observed)');
  for (const kind of ['win', 'place', 'show']) {
    console.log(`  ${kind}: ${r.calibration[kind].filter((b) => b.n).map((b) => `${b.bin} n=${b.n} ${pct(b.predicted)}→${pct(b.observed)}`).join(' | ')}`);
  }

  console.log(`\n4. "MOST LIKELY TO CASH" PARLAYS, one per day, $2, graded at real chart prices (payout floor uses est. (1-${r.take})/q_market)`);
  console.log('  variant   kind   legs floor   n days  hits  hit rate  mean P(hit)  cost     returned  ROI');
  for (const p of r.parlays) {
    console.log(`  ${p.variant.padEnd(8)}  ${p.kind.padEnd(5)}  ${String(p.legs).padEnd(4)} ${String(p.floor ?? '-').padEnd(6)}  ${String(p.n).padEnd(6)}  ${String(p.hits).padEnd(4)}  ${pct(p.hitRate).padEnd(8)}  ${pct(p.meanPredicted).padEnd(11)}  $${(p.costCents / 100).toFixed(2).padEnd(7)} $${(p.returnedCents / 100).toFixed(2).padEnd(8)} ${pct(p.roi)}`);
  }
}

if (!fs.existsSync(dbPath)) {
  console.error(`no database at ${dbPath} (pass --db <path>)`);
  process.exitCode = 2;
} else {
  run(new Database(dbPath, { readonly: true, fileMustExist: true }));
}
