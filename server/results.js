// Results persistence: a confirmed chart parse -> race_results,
// exotic_payoffs and result_scratches for one race day, plus a
// result_charts provenance row per save.
//
// Preview-first (invariant 9): the /api/parse/results-* endpoints never
// write; this router persists exactly what the user confirmed. The chart's
// own track/date must match the race day - a mismatched chart is REFUSED,
// not partially used, because wrong results silently poison every grade
// and P/L built on them. Re-saving replaces the day's results (a corrected
// chart supersedes) while the provenance log appends.

import express from 'express';
import crypto from 'node:crypto';
import { getDb } from './db.js';
import { gradeAllCards } from './grading.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('app');
const traceLog = getLogger('decision-trace');

export const resultsRouter = express.Router();

// Results provenance (D42, migration 010): where the day's results came from.
// Re-saving from ANY source replaces the day's results and regrades every card.
const SOURCE_KINDS = { paste: 'equibase_paste', pdf: 'equibase_pdf', equibase_paste: 'equibase_paste', equibase_pdf: 'equibase_pdf', dmtc_html: 'dmtc_html' };

const lettersOnly = (s) => String(s ?? '').replace(/[^A-Za-z]/g, '').toUpperCase();
const nameKey = (s) => String(s ?? '').toUpperCase().replace(/[‘’]/g, "'")
  .replace(/\s+/g, ' ').trim();

resultsRouter.post('/race-days/:id/results', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) {
    return res.status(410).json({ error: 'This race day is deleted. Restore it before saving results.' });
  }

  const p = req.body ?? {};
  if (!Array.isArray(p.races) || p.races.length === 0) {
    return res.status(400).json({ error: 'races (from the results preview) are required.' });
  }
  // The chart names its own track and date; a mismatch is refused whole.
  if (p.date && p.date !== day.date) {
    return res.status(422).json({
      error: `This chart is for ${p.date}; the race day is ${day.date}. Wrong chart - nothing saved.`,
    });
  }
  if (p.track && lettersOnly(p.track) !== lettersOnly(day.track)) {
    return res.status(422).json({
      error: `This chart is for ${p.track}; the race day is ${day.track}. Wrong chart - nothing saved.`,
    });
  }

  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(p.races)).digest('hex');

  const counts = { results: 0, exotics: 0, scratches: 0, unresolvedFinishers: 0 };
  const save = db.transaction(() => {
    db.prepare('DELETE FROM race_results WHERE race_day_id = ?').run(day.id);
    db.prepare('DELETE FROM exotic_payoffs WHERE race_day_id = ?').run(day.id);
    db.prepare('DELETE FROM result_scratches WHERE race_day_id = ?').run(day.id);

    const insResult = db.prepare(`INSERT INTO race_results
        (race_day_id, race_number, program_number, horse_name, finish_position,
         win_cents, place_cents, show_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insExotic = db.prepare(`INSERT INTO exotic_payoffs
        (race_day_id, race_number, bet_type, base_cents, combination, payout_cents)
        VALUES (?, ?, ?, ?, ?, ?)`);
    const insScratch = db.prepare(`INSERT INTO result_scratches
        (race_day_id, race_number, program_number, horse_name)
        VALUES (?, ?, ?, ?)`);

    for (const race of p.races) {
      // The dmtc page names also-rans without program numbers (D42); resolve
      // them against the day's entries like scratches. Unresolved rows are
      // counted, not invented - the column is NOT NULL and grading keys on it.
      const entriesFor = db.prepare(`
        SELECT e.program_number, e.horse_name FROM entries e
        JOIN races r ON r.id = e.race_id
        WHERE r.race_day_id = ? AND r.number = ?
      `).all(day.id, race.number);
      for (const r of race.results ?? []) {
        let pgm = r.programNumber ?? null;
        if (pgm == null && r.horseName) pgm = entriesFor.find((e) => nameKey(e.horse_name) === nameKey(r.horseName))?.program_number ?? null;
        if (pgm == null) { counts.unresolvedFinishers++; continue; }
        insResult.run(day.id, race.number, pgm, r.horseName ?? null,
          r.finishPosition ?? null, r.winCents ?? null, r.placeCents ?? null, r.showCents ?? null);
        counts.results++;
      }
      for (const x of race.exotics ?? []) {
        insExotic.run(day.id, race.number, x.betType, x.baseCents, x.combination, x.payoutCents);
        counts.exotics++;
      }
      for (const s of race.scratches ?? []) {
        // Chart scratches carry names, not numbers; grading refunds key on
        // program numbers, so resolve against the day's entries here.
        let pgm = s.programNumber ?? null;
        if (pgm == null && s.horseName) {
          const entry = db.prepare(`
            SELECT e.program_number, e.horse_name FROM entries e
            JOIN races r ON r.id = e.race_id
            WHERE r.race_day_id = ? AND r.number = ?
          `).all(day.id, race.number)
            .find((e) => nameKey(e.horse_name) === nameKey(s.horseName));
          pgm = entry?.program_number ?? null;
        }
        insScratch.run(day.id, race.number, pgm, s.horseName ?? null);
        counts.scratches++;
      }
    }
    db.prepare(`INSERT INTO result_charts (race_day_id, source_kind, raw_digest, correlation_id)
        VALUES (?, ?, ?, ?)`)
      .run(day.id, SOURCE_KINDS[p.sourceKind] ?? 'equibase_paste', digest, correlationId);
  });
  save();

  const event = { correlationId, raceDayId: day.id, track: day.track, date: day.date, ...counts };
  log.info('results_saved', event);
  traceLog.info('results_saved', event);

  // Fresh results grade every existing card of the day automatically -
  // the generate -> grade loop closes the moment the chart lands.
  const graded = gradeAllCards(db, day.id, correlationId);

  res.status(201).json({ correlationId, ...counts, gradedCards: graded });
});

resultsRouter.get('/race-days/:id/results', (req, res) => {
  const db = getDb();
  const day = db.prepare('SELECT id FROM race_days WHERE id = ?').get(Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  const results = db.prepare(
    'SELECT * FROM race_results WHERE race_day_id = ? ORDER BY race_number, finish_position',
  ).all(day.id);
  const exotics = db.prepare(
    'SELECT * FROM exotic_payoffs WHERE race_day_id = ? ORDER BY race_number, id',
  ).all(day.id);
  const scratches = db.prepare(
    'SELECT * FROM result_scratches WHERE race_day_id = ? ORDER BY race_number, id',
  ).all(day.id);
  const charts = db.prepare(
    'SELECT id, source_kind, ingested_at FROM result_charts WHERE race_day_id = ? ORDER BY id DESC',
  ).all(day.id);
  res.json({ results, exotics, scratches, charts });
});
