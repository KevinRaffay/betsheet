// TIPSHEET picks: the HTTP surface, manual entry, and the correction path.
//
// D166-D169 read these picks off a SCREENSHOT with a vision call. D177 removed
// that: it was slow, cost an API call per race, and a tip sheet is three horses
// and three ranks - faster to type (D176) than to photograph. What that removal
// deleted is the vision half only; the shape of the data, its validator, its
// writer and everything downstream are untouched, which is why scoring (D170)
// and staking (D171) needed no change at all.
//
// The `raw_extraction` / `model` / `image_sha256` COLUMNS survive on purpose.
// Rows extracted before the removal carry real values there, dropping a column
// needs a table rebuild, and a shipped migration is immutable regardless. They
// are simply NULL on everything typed since - which makes provenance readable
// without a flag anyone has to maintain.
//
// INVARIANT 9 IS INTACT, AND NOW TRIVIALLY SO. It governs the parse -> save
// path; there is no parse left. Manual entry still runs every typed ranking
// through the SAME `validateTipPicks` a model's output used to face, so a
// person cannot save a ranking the parser would have refused. Correcting a
// stored row (migration 029) remains a separate, recorded act.
//
// STAKING IS AUTOMATIC (D-new, replacing D183's "Stake all tip sheets into
// cards" button): every write here that changes what a source has picked -
// manual entry, a correction, a delete - restakes that source immediately via
// `autoStake` below, rather than leaving the user to press a separate button.
// A source left with no races-with-picks after the write (every sheet
// cleared) has nothing to stake; `persistTipCards`'s own "no tip picks"
// refusal is expected there, not an error, so it is swallowed. A day with no
// bankroll set is left alone the same way - there is nothing to size a stake
// from.

import express from 'express';
import { getDb } from './db.js';
import { validateTipPicks, hasBlocking } from '../shared/tip-picks.js';
import { normalizeSourceLabel } from '../shared/source-labels.js';
import { persistTipCards } from './tip-staking.js';

import { getLogger, newCorrelationId } from './logging.js';

const traceLog = getLogger('decision-trace');
const now = () => new Date().toISOString();

export const tipPicksRouter = express.Router();

class TipPicksError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function loadDay(db, id) {
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(id);
  if (!day) throw new TipPicksError(404, 'Race day not found.');
  if (day.deleted_at) throw new TipPicksError(410, 'This race day is deleted.');
  return day;
}

function requireRace(db, day, raceNo) {
  const n = Number(raceNo);
  if (!Number.isInteger(n) || n < 1) throw new TipPicksError(400, 'race must be a whole number of 1 or more.');
  const race = db.prepare('SELECT id FROM races WHERE race_day_id = ? AND number = ?').get(day.id, n);
  if (!race) throw new TipPicksError(404, `This day has no race ${n}.`);
  return n;
}

/**
 * Restake ONE source right after its picks changed. Never throws for the
 * ordinary "nothing to stake" cases - a source with zero races-with-picks
 * left (`persistTipCards` refuses that with a 404) or a day with no positive
 * bankroll - so a save/correct/delete never fails because staking had
 * nothing to do. Any OTHER error (a real bug) still propagates.
 */
function autoStake(db, day, sourceLabel, correlationId) {
  const bankroll = Number(day.bankroll_cents);
  if (!Number.isFinite(bankroll) || bankroll <= 0) return null;
  try {
    return persistTipCards(db, day, sourceLabel, bankroll, correlationId).cards;
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

const shapeRow = (r) => ({
  id: r.id, raceNo: r.race_no, bucket: r.bucket, sourceLabel: r.source_label,
  picks: r.picks, picksExtracted: r.picks_extracted ? JSON.parse(r.picks_extracted) : null,
  edited: Boolean(r.edited_at), editedAt: r.edited_at, capturedAt: r.captured_at,
  // Legacy audit columns from the screenshot era (D166-D169, removed in D177).
  // Kept, and still reported, because rows extracted before the removal carry
  // real values here - dropping them would destroy that record, and a migration
  // is immutable anyway. NULL on every row typed since.
  model: r.model, imageSha256: r.image_sha256, createdAt: r.created_at,
});

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TipPicksError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
};

/** Read one day's tip picks back. */
tipPicksRouter.get('/race-days/:id/tip-picks', wrap(async (req, res) => {
  const db = getDb();
  const day = loadDay(db, req.params.id);
  res.json({ rows: tipPicksForDay(db, day.id).map(shapeRow) });
}));

/**
 * CORRECT a stored row. This is the edit path, and it is deliberately NOT the
 * preview: invariant 9's read-only preview stays read-only, and a save still
 * stores exactly what the model said. Correcting is a separate act on a row
 * that already exists, and it is RECORDED rather than silent.
 *
 * `picks_extracted` is written on the FIRST edit only, so it always holds the
 * model's original answer rather than the previous edit - which is what makes
 * every corrected row a labelled example of what the extraction got wrong.
 * The corrected picks go through the SAME validator the extraction did, so a
 * human cannot hand-write a ranking the parser would have refused.
 */
tipPicksRouter.patch('/tip-picks/:tipId', wrap(async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tip_picks WHERE id = ?').get(req.params.tipId);
  if (!row) throw new TipPicksError(404, 'Tip picks not found.');
  const day = loadDay(db, row.race_day_id);

  const { picks, warnings } = validateTipPicks(req.body?.picks);
  if (hasBlocking(warnings)) {
    return res.status(422).json({
      error: 'The corrected picks are not a usable ranking.',
      warnings,
    });
  }

  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const ts = now();
  db.prepare(`
    UPDATE tip_picks
       SET picks = ?,
           picks_extracted = COALESCE(picks_extracted, ?),
           edited_at = ?
     WHERE id = ?
  `).run(JSON.stringify(picks), row.picks, ts, row.id);

  traceLog.info('tip_picks_corrected', {
    raceDayId: day.id, raceNo: row.race_no, tipPicksId: row.id,
    sourceLabel: row.source_label, firstEdit: row.edited_at === null,
    before: JSON.parse(row.picks), after: picks,
  });
  const staked = autoStake(db, day, row.source_label, correlationId);
  const updated = db.prepare('SELECT * FROM tip_picks WHERE id = ?').get(row.id);
  res.json({ saved: shapeRow({ ...updated, picks: JSON.parse(updated.picks) }), warnings, staked });
}));

/** Remove a stored row. The archived image and response are NOT deleted. */
tipPicksRouter.delete('/tip-picks/:tipId', wrap(async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tip_picks WHERE id = ?').get(req.params.tipId);
  if (!row) throw new TipPicksError(404, 'Tip picks not found.');
  db.prepare('DELETE FROM tip_picks WHERE id = ?').run(row.id);
  traceLog.info('tip_picks_deleted', {
    raceDayId: row.race_day_id, raceNo: row.race_no, tipPicksId: row.id, sourceLabel: row.source_label,
  });
  // Removing a race's sheet changes the source's races-with-picks count, which
  // changes every OTHER race's per-race budget too - restake to keep the
  // source's cards in sync. A day that is gone or soft-deleted has nothing to
  // restake into.
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(row.race_day_id);
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const staked = day && !day.deleted_at ? autoStake(db, day, row.source_label, correlationId) : null;
  res.json({ deleted: row.id, staked });
}));

/**
 * MANUAL entry (D176): tip picks typed from the printed sheet, no vision call.
 *
 * Screenshot extraction is slow and costs an API call per race; a tip sheet is
 * three horses and three ranks, which is faster to type than to photograph.
 * This produces the IDENTICAL payload - the same `tip_picks` rows, through the
 * same `validateTipPicks` and the same `insertTipPicks` writer - so scoring
 * (D170) and staking (D171) cannot tell the two apart, and neither can a
 * findings query later.
 *
 * `raw_extraction` / `model` / `image_sha256` stay NULL, which is the honest
 * record: there was no model and no image. A row's provenance is therefore
 * readable as "typed" vs "extracted" without a flag anyone has to set.
 *
 * ODDS ARE NOT CAPTURED HERE, deliberately. The morning line already sits on
 * `entries` and staking reads it from there; a tip sheet's own printed price
 * is a different number, and copying the ML onto the pick would invent a
 * quotation the sheet never made.
 *
 * Body: `{ race, sheets: [{ sourceLabel, picks: [{ horse_no, rank }] }] }`.
 * A sheet with NO picks DELETES that source's row for the race, which is how
 * a column is cleared - there is no second verb for it, the same shape
 * `writeNote` uses for an emptied note.
 */
tipPicksRouter.post('/race-days/:id/tip-picks/manual', wrap(async (req, res) => {
  const db = getDb();
  const day = loadDay(db, req.params.id);
  const raceNo = requireRace(db, day, req.body?.race);
  const sheets = Array.isArray(req.body?.sheets) ? req.body.sheets : null;
  if (!sheets) throw new TipPicksError(400, 'sheets must be an array.');

  // The day's own entries are the authority on a horse's name and on whether a
  // program number exists at all - never the client's copy of them.
  const race = db.prepare('SELECT id FROM races WHERE race_day_id = ? AND number = ?').get(day.id, raceNo);
  const entries = db.prepare('SELECT program_number, horse_name FROM entries WHERE race_id = ?').all(race.id);
  // D180: a scratched horse may have no number; skip it rather than keying the
  // map on the string "null", which a pick could then match.
  const nameOf = new Map(entries.filter((e) => e.program_number != null)
    .map((e) => [String(e.program_number).toUpperCase(), e.horse_name]));

  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const results = [];
  const write = db.transaction(() => {
    for (const sheet of sheets) {
      const source = normalizeSourceLabel(sheet?.sourceLabel);
      if (!source) throw new TipPicksError(400, 'Each sheet needs a sourceLabel.');
      const raw = Array.isArray(sheet?.picks) ? sheet.picks : [];

      if (raw.length === 0) {
        const gone = db.prepare(
          'DELETE FROM tip_picks WHERE race_day_id = ? AND race_no = ? AND source_label = ?',
        ).run(day.id, raceNo, source).changes;
        if (gone) {
          traceLog.info('tip_picks_deleted', {
            correlationId, raceDayId: day.id, raceNo, sourceLabel: source, reason: 'cleared_manually',
          });
        }
        results.push({ sourceLabel: source, picks: 0, cleared: true });
        continue;
      }

      const unknown = raw.map((p) => String(p?.horse_no ?? '').toUpperCase())
        .filter((pgm) => pgm && !nameOf.has(pgm));
      if (unknown.length) {
        throw new TipPicksError(422, `Race ${raceNo} has no horse ${unknown.map((u) => `#${u}`).join(', ')}.`);
      }

      // The SAME validator a model's output passes, so a typed ranking cannot
      // be something extraction would have refused.
      const { picks, warnings } = validateTipPicks(raw.map((p) => ({
        horse_no: p.horse_no,
        horse_name: nameOf.get(String(p.horse_no).toUpperCase()) ?? '',
        rank: p.rank,
      })));
      if (hasBlocking(warnings)) {
        throw new TipPicksError(422, `${source}: ${
          warnings.filter((w) => w.blocking).map((w) => w.message).join('; ')}`);
      }

      insertTipPicks(db, {
        raceDayId: day.id, raceNo, sourceLabel: source, picks,
        capturedAt: req.body?.capturedAt ?? null,
      });
      traceLog.info('tip_picks_saved', {
        correlationId, raceDayId: day.id, raceNo, sourceLabel: source,
        pickCount: picks.length, entryMode: 'manual',
      });
      results.push({ sourceLabel: source, picks: picks.length, cleared: false });
    }
  });
  write();
  // Restake every source this request touched - including a source cleared
  // to zero picks, which `autoStake` recognises as "nothing to stake" rather
  // than an error. A source untouched by this request keeps its existing
  // cards; only sources whose picks just changed need re-pricing.
  const staked = [];
  for (const source of new Set(results.map((r) => r.sourceLabel))) {
    const cards = autoStake(db, day, source, correlationId);
    if (cards) staked.push({ sourceLabel: source, cards });
  }
  res.status(201).json({ raceNo, sheets: results, correlationId, staked });
}));

/**
 * Persist one race's picks for one source. The ONE writer, used by manual
 * entry (D176) and by the check scripts.
 *
 * Re-extracting the same (day, race, source) REPLACES: a second screenshot of
 * one app's picks for one race is a correction, not a second opinion. Both
 * `raw_extraction` rows cannot be kept under that UNIQUE, which is the
 * deliberate trade - the audit answer to "what did the model see last" is the
 * one worth keeping while this is still extraction-only.
 */
export function insertTipPicks(db, {
  raceDayId, raceNo, sourceLabel, picks, capturedAt = null,
  rawExtraction = null, model = null, imageSha256 = null,
}) {
  return db.prepare(`
    INSERT INTO tip_picks (race_day_id, race_no, bucket, source_label, picks,
      captured_at, raw_extraction, model, image_sha256, created_at)
    VALUES (?, ?, 'TIPSHEET', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (race_day_id, race_no, source_label) DO UPDATE SET
      picks = excluded.picks, captured_at = excluded.captured_at,
      raw_extraction = excluded.raw_extraction, model = excluded.model,
      image_sha256 = excluded.image_sha256, created_at = excluded.created_at
  `).run(raceDayId, raceNo, normalizeSourceLabel(sourceLabel),
    JSON.stringify(picks), capturedAt, rawExtraction, model, imageSha256, now());
}

/** Read one day's tip picks back, JSON decoded. The ONE reader. */
export function tipPicksForDay(db, raceDayId) {
  return db.prepare('SELECT * FROM tip_picks WHERE race_day_id = ? ORDER BY race_no, source_label')
    .all(raceDayId)
    .map((r) => ({ ...r, picks: JSON.parse(r.picks) }));
}
