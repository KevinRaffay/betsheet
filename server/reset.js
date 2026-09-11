// Factory reset: wipe every stored record and every log file, back to a
// just-installed state. The ONE sanctioned exception to invariant 12's
// "log files are never touched" - this is the explicit clean-slate action
// for development and testing, never a side effect of anything else.
//
// Shared by the API route (POST /api/reset, Danger zone in the UI) and the
// CLI (`npm run reset -- --yes`). The schema itself (schema_migrations)
// survives; the race-day id sequence restarts at 1, which is safe ONLY
// because the logs that could have referenced old ids are wiped in the
// same action.
//
// WARNING for any future caller: `resetApp` takes a `db`, but the log half of
// the reset does NOT. `resetLogs()` operates on the log directory the logger
// was CONFIGURED with, so calling `resetApp` against some other database - a
// copy, a probe, a fixture - still deletes the real log files. Found the hard
// way 2026-09-06, when a reset run against a scratch copy of the corpus wiped
// the live decision-trace and fetch-audit streams. If you want a reset that
// touches only a throwaway database, point BETSHEET_LOG_DIR somewhere
// throwaway too, in the same process, before the logger is first used.

import express from 'express';
import { getDb } from './db.js';
import { getLogger, newCorrelationId, resetLogs } from './logging.js';
import { seedTemplates } from './templates.js';

const log = getLogger('app');

// Children before parents. The ORDER is load-bearing and cannot be derived:
// most FKs here cascade, but `cards.strategy_template_id`,
// `simulation_runs.strategy_template_id`, `fetch_attempts.source_id` and
// `consensus_picks.source_id` are ON DELETE NO ACTION, so the referencing rows
// have to go first or the delete is refused.
const WIPE_ORDER = [
  'actual_stakes', 'publishes', 'graded_tickets', 'tickets', 'allocations',
  'human_race_state', 'llm_card_requests',
  'cards', 'simulation_results', 'simulation_runs', 'strategy_templates',
  'consensus_picks', 'fetch_attempts', 'sources',
  'result_scratches', 'exotic_payoffs', 'race_results', 'result_charts',
  // D224: children of race_days, and of each other. Named explicitly rather
  // than left to the `unnamed` catch-all above so a reset's own audit event
  // reports their row counts by name - which is the exact thing that went
  // missing for llm_notes and friends between migrations 015 and 023.
  'odds_capture_entries', 'odds_captures',
  'entries', 'races', 'llm_notes', 'tip_picks', 'race_days', 'backfill_queue',
];

// The schema, not user data - it is what makes the fresh era the same shape.
const KEEP = new Set(['schema_migrations']);

/** Every real table in the database, sqlite's own internals excluded. */
function allTables(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((r) => r.name);
}

export function resetApp(db) {
  const counts = {};
  // A table this list has never heard of is deleted FIRST, in the leaf-most
  // position, because a brand-new table is far likelier to be a child of an
  // existing one than a parent of one. This is what stops the list going
  // stale the way it did between migrations 015 and 023: `human_race_state`,
  // `llm_card_requests` and `llm_notes` were added after it was written, were
  // cleared only by cascade, and so were absent from `rowsRemoved` - 169 rows
  // destroyed and not named in the audit event this reset writes about itself.
  const unnamed = allTables(db).filter((t) => !WIPE_ORDER.includes(t) && !KEEP.has(t));

  const wipe = db.transaction(() => {
    for (const table of [...unnamed, ...WIPE_ORDER]) {
      counts[table] = db.prepare(`DELETE FROM ${table}`).run().changes;
    }
    // Fresh ids for a fresh era - safe only because the logs go too.
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'race_days'").run();

    // Nothing may survive a reset unnoticed. Asserted INSIDE the transaction,
    // so a table left with rows rolls the whole wipe back and throws - the
    // caller keeps its data and hears about it, rather than being told the
    // app is factory-fresh when it is not. The log files are untouched at
    // this point, which is why the assertion has to happen here and not after.
    const survivors = allTables(db)
      .filter((t) => !KEEP.has(t))
      .map((t) => [t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c])
      .filter(([, c]) => c > 0);
    if (survivors.length) {
      throw new Error(
        `Reset did not empty every table; nothing was wiped: ${
          survivors.map(([t, c]) => `${t}=${c}`).join(', ')}`,
      );
    }
  });
  wipe();
  db.exec('VACUUM');

  // The built-in strategy templates are code, not user data - a fresh era
  // still has them (cards reference them by FK from the first generate).
  seedTemplates(db);

  const logFilesRemoved = resetLogs();

  // The reset is the first entry of the new era - auditable, never silent.
  const correlationId = newCorrelationId();
  log.info('app_reset', { correlationId, rowsRemoved: counts, logFilesRemoved });
  return { correlationId, rowsRemoved: counts, logFilesRemoved };
}

export const resetRouter = express.Router();

resetRouter.post('/reset', (req, res) => {
  // The confirm token is the API-level safety: no accidental curl, no
  // stray client call, wipes anything.
  if (req.body?.confirm !== 'RESET') {
    return res.status(400).json({
      error: 'Factory reset requires { "confirm": "RESET" }. This deletes every stored record AND every log file.',
    });
  }
  res.json({ ok: true, ...resetApp(getDb()) });
});
