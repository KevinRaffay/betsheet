// Simulation (D19): replay every strategy template against every stored
// race day that has real results. The engine input is assembled exactly
// as for a live card (server/cards.js) and the grader is the live grader
// (shared/grading.js), so "template X would have earned Y" is the same
// computation that produced and scored the live cards - only the rule set
// differs. Simulation-only templates are allowed HERE (that is what they
// are for; the live endpoint refuses them). Runs persist APPEND-ONLY into
// simulation_runs / simulation_results (schema D03); reads filter
// soft-deleted days (invariant 12) and never pool buckets (invariant 13).

import express from 'express';
import { TEMPLATES, resolveTemplate } from '../shared/templates.js';
import { simulateDay, summarizeRun } from '../shared/simulation.js';
import { ENGINE_VERSION } from '../shared/card-engine.js';
import { getDb } from './db.js';
import { assembleEngineInput, loadDayFull } from './cards.js';
import { loadDayResultsFor } from './grading.js';
import { templateIdFor } from './templates.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('app');
const traceLog = getLogger('decision-trace');

export const simulateRouter = express.Router();

/** Days a run covers: not deleted, results on file. Date order. */
function eligibleDayIds(db) {
  return db.prepare(`
    SELECT rd.id FROM race_days rd
    WHERE rd.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM race_results rr WHERE rr.race_day_id = rd.id)
    ORDER BY rd.date, rd.track, rd.id
  `).all().map((r) => r.id);
}

/**
 * Run one template over every eligible day and persist the run.
 * `bankrollCents` / `perRaceMinCents` override the day's own recipe when
 * given (one bankroll across the whole history); `startingBankrollCents`
 * only shapes the bankroll-over-time series. Returns the run id.
 */
export function runTemplate(db, templateName, {
  bankrollCents = null, perRaceMinCents = null, startingBankrollCents = null, correlationId,
} = {}) {
  const rules = resolveTemplate(templateName);
  if (!rules) throw new Error(`Unknown template "${templateName}".`);
  const rows = [];
  for (const id of eligibleDayIds(db)) {
    const day = loadDayFull(db, id);
    const dayResults = loadDayResultsFor(db, id);
    if (!dayResults) continue;
    const sim = simulateDay({
      bankrollCents: bankrollCents ?? day.bankroll_cents,
      perRaceMinCents: perRaceMinCents ?? day.per_race_min_cents,
      ...assembleEngineInput(db, day),
      rules,
      template: templateName,
    }, dayResults);
    rows.push({ raceDayId: id, track: day.track, date: day.date, ...sim });
  }
  const params = {
    template: templateName, engineVersion: ENGINE_VERSION, bankrollCents, perRaceMinCents, startingBankrollCents,
    correlationId, days: rows.length,
  };
  const { buckets } = summarizeRun(rows, { startingBankrollCents });
  const summary = { buckets: buckets.map(({ series, ...b }) => b) };

  const save = db.transaction(() => {
    const runId = db.prepare(`INSERT INTO simulation_runs
        (strategy_template_id, params, summary, finished_at)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`)
      .run(templateIdFor(db, templateName), JSON.stringify(params), JSON.stringify(summary)).lastInsertRowid;
    const ins = db.prepare(`INSERT INTO simulation_results (run_id, race_day_id, pl_cents, details)
        VALUES (?, ?, ?, ?)`);
    for (const r of rows) {
      const { raceDayId, track, date, plCents, ...details } = r;
      ins.run(runId, raceDayId, plCents, JSON.stringify(details));
    }
    return runId;
  });
  const runId = save();

  // One trace event per run: the recipe, the per-bucket outcome and every
  // day's P/L. The per-ticket detail lives in simulation_results and is
  // reproducible - the engine and grader are pure.
  traceLog.info('simulation_run', {
    correlationId, runId, template: templateName, params, buckets: summary.buckets,
    days: rows.map((r) => ({ raceDayId: r.raceDayId, date: r.date, track: r.track, completeness: r.completeness, plCents: r.plCents })),
  });
  log.info('simulation_run', { correlationId, runId, template: templateName, days: rows.length });
  return runId;
}

/**
 * One run read back. Soft-deleted days drop out (invariant 12) and the
 * buckets are re-rolled from the surviving rows, so the stored summary is
 * only what the run saw at the time - the read is always current.
 */
function readRun(db, runId, { withDays = true } = {}) {
  const run = db.prepare(`
    SELECT sr.*, st.name AS template FROM simulation_runs sr
    JOIN strategy_templates st ON st.id = sr.strategy_template_id
    WHERE sr.id = ?
  `).get(runId);
  if (!run) return null;
  const params = JSON.parse(run.params ?? '{}');
  const rows = db.prepare(`
    SELECT s.race_day_id, s.pl_cents, s.details, rd.track, rd.date
    FROM simulation_results s JOIN race_days rd ON rd.id = s.race_day_id
    WHERE s.run_id = ? AND rd.deleted_at IS NULL
  `).all(runId);
  const days = rows.map((r) => {
    const d = JSON.parse(r.details ?? '{}');
    return {
      raceDayId: r.race_day_id, track: r.track, date: r.date, completeness: d.completeness,
      costCents: d.costCents, returnedCents: d.returnedCents, plCents: r.pl_cents,
      tickets: d.tickets, wins: d.wins, outcomes: d.outcomes, topTicketShare: d.topTicketShare,
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.track.localeCompare(b.track) || a.raceDayId - b.raceDayId);
  const { buckets } = summarizeRun(days, { startingBankrollCents: params.startingBankrollCents ?? null });
  const out = {
    runId: run.id, template: run.template,
    simulationOnly: Boolean(TEMPLATES[run.template]?.simulationOnly),
    params, startedAt: run.started_at, finishedAt: run.finished_at,
    daysInRun: params.days ?? rows.length, buckets,
  };
  if (withDays) out.days = days;
  return out;
}

const centsOrNull = (v, name) => {
  if (v == null) return { value: null };
  if (!Number.isInteger(v) || v <= 0) return { error: `${name} must be a positive integer number of cents.` };
  return { value: v };
};

// Run every template (or the named ones) over the whole stored history.
simulateRouter.post('/simulations', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const names = Array.isArray(req.body?.templates) && req.body.templates.length
    ? req.body.templates.map(String) : Object.keys(TEMPLATES);
  const unknown = names.filter((n) => !TEMPLATES[n]);
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown template(s): ${unknown.join(', ')}. Templates: ${Object.keys(TEMPLATES).join(', ')}.` });
  }
  const opts = { correlationId };
  for (const k of ['bankrollCents', 'perRaceMinCents', 'startingBankrollCents']) {
    const { value, error } = centsOrNull(req.body?.[k], k);
    if (error) return res.status(400).json({ error });
    opts[k] = value;
  }
  const runs = names.map((n) => readRun(db, runTemplate(db, n, opts)));
  res.status(201).json({ correlationId, runs });
});

// Every run, newest first (buckets re-rolled live, deleted days excluded).
simulateRouter.get('/simulations', (_req, res) => {
  const db = getDb();
  const ids = db.prepare('SELECT id FROM simulation_runs ORDER BY id DESC').all().map((r) => r.id);
  res.json({ runs: ids.map((id) => readRun(db, id, { withDays: false })) });
});

// The compare surface: the latest run per template, side by side.
simulateRouter.get('/simulations/compare', (_req, res) => {
  const db = getDb();
  const latest = db.prepare(`
    SELECT MAX(sr.id) AS id, st.name AS template FROM simulation_runs sr
    JOIN strategy_templates st ON st.id = sr.strategy_template_id
    GROUP BY sr.strategy_template_id
  `).all();
  const order = Object.keys(TEMPLATES);
  const templates = latest
    .sort((a, b) => order.indexOf(a.template) - order.indexOf(b.template))
    .map((r) => readRun(db, r.id, { withDays: false }));
  res.json({ templates });
});

simulateRouter.get('/simulations/:id', (req, res) => {
  const run = readRun(getDb(), Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'No such simulation run.' });
  res.json(run);
});

// One simulated day in full: every ticket with its outcome and rule tags.
simulateRouter.get('/simulations/:id/days/:dayId', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT s.*, rd.track, rd.date, rd.deleted_at FROM simulation_results s
    JOIN race_days rd ON rd.id = s.race_day_id
    WHERE s.run_id = ? AND s.race_day_id = ?
  `).get(Number(req.params.id), Number(req.params.dayId));
  if (!row) return res.status(404).json({ error: 'No such simulated day.' });
  if (row.deleted_at) return res.status(410).json({ error: 'This race day is deleted; deleted days are excluded from simulation reporting.' });
  const details = JSON.parse(row.details ?? '{}');
  res.json({ runId: row.run_id, raceDayId: row.race_day_id, track: row.track, date: row.date, plCents: row.pl_cents, ...details });
});
