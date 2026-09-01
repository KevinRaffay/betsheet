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

import express from 'express';
import { getDb } from './db.js';
import { getLogger, newCorrelationId, resetLogs } from './logging.js';

const log = getLogger('app');

// Parents last where FKs cascade; standalone tables explicitly.
const WIPE_ORDER = [
  'actual_stakes', 'publishes', 'graded_tickets', 'tickets', 'allocations',
  'cards', 'simulation_results', 'simulation_runs', 'strategy_templates',
  'consensus_picks', 'fetch_attempts', 'sources',
  'result_scratches', 'exotic_payoffs', 'race_results', 'result_charts',
  'entries', 'races', 'race_days',
];

export function resetApp(db) {
  const counts = {};
  const wipe = db.transaction(() => {
    for (const table of WIPE_ORDER) {
      counts[table] = db.prepare(`DELETE FROM ${table}`).run().changes;
    }
    // Fresh ids for a fresh era - safe only because the logs go too.
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'race_days'").run();
  });
  wipe();
  db.exec('VACUUM');

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
