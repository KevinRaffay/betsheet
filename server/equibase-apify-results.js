// Preview for the Apify results source (D195-D196, `docs/requirements/
// apify-equibase-ingest.md`). Day-scoped, unlike the other results preview
// routes in server/ingest.js - `shared/parsers/equibase-apify-results.js`'s
// scratch derivation needs the day's own already-saved entries
// (`context.entriesByRace`), and entries are always ingested before results
// for every race day this codebase handles (the resolved design, see the
// parser's own header). Preview-first (invariant 9): this route never
// writes; the confirmed preview response is sent to the EXISTING
// `POST /race-days/:id/results` route to save, unchanged - `parse()`'s
// output already matches `saveResults`'s `p` shape exactly, so no new save
// route is needed here, only the new parse step.

import express from 'express';
import { getDb } from './db.js';
import { parseApifyResultsDataset } from '../shared/parsers/equibase-apify-results.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('app');

export const equibaseApifyResultsRouter = express.Router();

// {[raceNumber]: [{programNumber, horseName}]} for one day, in one query
// rather than per-race - the shape shared/parsers/equibase-apify-results.js
// diffs its finisher list against to derive scratches.
function entriesByRaceFor(db, raceDayId) {
  const rows = db.prepare(`
    SELECT r.number AS race_number, e.program_number, e.horse_name
    FROM entries e
    JOIN races r ON r.id = e.race_id
    WHERE r.race_day_id = ? AND e.program_number IS NOT NULL
  `).all(raceDayId);
  const byRace = {};
  for (const row of rows) {
    (byRace[row.race_number] ??= []).push({ programNumber: row.program_number, horseName: row.horse_name });
  }
  return byRace;
}

equibaseApifyResultsRouter.post('/race-days/:id/results-apify/preview', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = db.prepare('SELECT id, deleted_at FROM race_days WHERE id = ?').get(Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) {
    return res.status(410).json({ error: 'This race day is deleted. Restore it before previewing results.' });
  }

  const data = req.body?.data;
  if (typeof data !== 'string' || !data) {
    return res.status(400).json({ error: 'data (the raw Apify dataset JSON, as text) is required.' });
  }

  const entriesByRace = entriesByRaceFor(db, day.id);
  const parsed = parseApifyResultsDataset(data, { entriesByRace });

  log.info('parse_completed', {
    correlationId,
    kind: 'results_apify',
    bytes: data.length,
    track: parsed.track,
    date: parsed.date,
    races: parsed.races.length,
    finishers: parsed.races.reduce((a, r) => a + r.results.length, 0),
    scratchesDerived: parsed.races.reduce((a, r) => a + r.scratches.length, 0),
    warnings: parsed.warnings.length,
  });
  res.json({ correlationId, ...parsed, sourceKind: 'equibase_apify' });
});
