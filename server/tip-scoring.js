// TIPSHEET scoring API (D170).
//
// Reads tip_picks against saved results and reports, per SOURCE, how good the
// picks were. Read-only: this module writes nothing, grades no ticket and
// touches no card. Scoring a tip sheet is not grading a bet - nothing here
// stakes money, so there is no P/L and no engine_version anywhere in it.
//
// Two invariants ride on the queries below:
//   * INVARIANT 12 - a soft-deleted race day is excluded from every aggregate.
//     The corpus-wide route joins race_days and filters `deleted_at IS NULL`,
//     the same as every P/L and distribution query.
//   * INVARIANT 13 - sources are never pooled. There is no "all tipsheets"
//     total, by construction: `byTipSource` is the only total produced.

import express from 'express';
import { getDb } from './db.js';
import { scoreTipRace, byTipSource, aggregateTipScores } from '../shared/tip-scoring.js';

export const tipScoringRouter = express.Router();

/** One race's result, in the shape shared/tip-scoring.js expects. */
function resultFor(db, raceDayId, raceNumber) {
  const finishers = db.prepare(
    'SELECT program_number, finish_position FROM race_results WHERE race_day_id = ? AND race_number = ?',
  ).all(raceDayId, raceNumber);
  const scratched = db.prepare(
    'SELECT program_number FROM result_scratches WHERE race_day_id = ? AND race_number = ?',
  ).all(raceDayId, raceNumber).map((r) => r.program_number).filter(Boolean);
  return { finishers, scratched };
}

/** Every tip row on non-deleted days, already scored. Rows without results score null. */
function scoredRows(db, { sourceLabel = null, raceDayId = null } = {}) {
  const rows = db.prepare(`
    SELECT t.*, d.track_code, d.date, d.meet
      FROM tip_picks t
      JOIN race_days d ON d.id = t.race_day_id
     WHERE d.deleted_at IS NULL
       ${sourceLabel ? 'AND t.source_label = @sourceLabel' : ''}
       ${raceDayId ? 'AND t.race_day_id = @raceDayId' : ''}
     ORDER BY d.date, t.race_no, t.source_label
  `).all({ sourceLabel, raceDayId });

  return rows.map((r) => {
    const picks = JSON.parse(r.picks);
    const { finishers, scratched } = resultFor(db, r.race_day_id, r.race_no);
    return {
      id: r.id,
      raceDayId: r.race_day_id,
      date: r.date,
      trackCode: r.track_code,
      meet: r.meet,
      raceNo: r.race_no,
      sourceLabel: r.source_label,
      edited: Boolean(r.edited_at),
      score: scoreTipRace({
        picks,
        finishers: finishers.map((f) => ({ programNumber: f.program_number, finishPosition: f.finish_position })),
        scratched,
      }),
    };
  });
}

/**
 * GET /api/tip-scoring[?source=&meet=]
 *
 * Per-source records across the corpus. NO pooled total, deliberately.
 */
tipScoringRouter.get('/tip-scoring', (req, res) => {
  const db = getDb();
  let rows = scoredRows(db, { sourceLabel: req.query.source ?? null });
  if (req.query.meet) rows = rows.filter((r) => r.meet === req.query.meet);
  res.json({
    bySource: byTipSource(rows),
    // Rows a reader may want to check a rate against by hand. Every rate above
    // is derivable from these, which is what makes the numbers auditable
    // rather than asserted.
    races: rows.map(({ score, ...rest }) => ({
      ...rest,
      scored: score !== null,
      win: score?.win ?? null,
      place: score?.place ?? null,
      show: score?.show ?? null,
      top3Overlap: score?.top3Overlap ?? null,
      topPick: score?.topPick ?? null,
      winnerProgramNumber: score?.winnerProgramNumber ?? null,
      unknownPicks: score?.unknownPicks ?? [],
    })),
  });
});

/** GET /api/race-days/:id/tip-scoring - one day, per race and per source. */
tipScoringRouter.get('/race-days/:id/tip-scoring', (req, res) => {
  const db = getDb();
  const day = db.prepare('SELECT id, deleted_at FROM race_days WHERE id = ?').get(req.params.id);
  if (!day) return res.status(404).json({ error: 'Race day not found.' });
  if (day.deleted_at) return res.status(410).json({ error: 'This race day is deleted.' });

  const rows = scoredRows(db, { raceDayId: day.id });
  res.json({
    bySource: byTipSource(rows),
    day: aggregateTipScores(rows.map((r) => r.score)),
    races: rows.map((r) => ({ ...r, score: r.score })),
  });
});
