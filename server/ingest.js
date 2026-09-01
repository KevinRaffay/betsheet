// Ingest API: parse previews and race-day persistence.
//
// The flow is preview-first (invariant 9): POST /api/parse/* returns the
// parsed structure + warnings and never writes anything; the client shows
// it for correction, and only POST /api/race-days persists - whatever the
// user confirmed, not whatever the parser said. Every parse gets a
// correlation id the client echoes back on save (x-correlation-id), so one
// ingest session reads as one trace (invariant 8).

import express from 'express';
import { parseEntries } from '../shared/entries-parser.js';
import { parseProgramPdf } from './program-parser.js';
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('app');

export const ingestRouter = express.Router();

ingestRouter.post('/parse/entries-text', (req, res) => {
  const text = String(req.body?.text ?? '');
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const parsed = parseEntries(text);
  log.info('parse_completed', {
    correlationId,
    kind: 'entries_text',
    bytes: text.length,
    races: parsed.races.length,
    entries: parsed.races.reduce((a, r) => a + r.entries.length, 0),
    warnings: parsed.warnings.length,
  });
  res.json({ correlationId, ...parsed });
});

// The PDF arrives as a raw application/pdf body (no multipart dependency).
ingestRouter.post(
  '/parse/program-pdf',
  express.raw({ type: 'application/pdf', limit: '30mb' }),
  async (req, res) => {
    const correlationId = req.get('x-correlation-id') || newCorrelationId();
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Send the PDF as a raw application/pdf body.' });
    }
    try {
      const expected = {
        track: req.query.track || undefined,
        date: req.query.date || undefined,
      };
      const parsed = await parseProgramPdf(new Uint8Array(req.body), expected);
      log.info('parse_completed', {
        correlationId,
        kind: 'program_pdf',
        bytes: req.body.length,
        races: parsed.races.length,
        entries: parsed.races.reduce((a, r) => a + r.entries.length, 0),
        warnings: parsed.warnings.length,
      });
      res.json({ correlationId, ...parsed });
    } catch (err) {
      // A corrupt/non-PDF upload is a user-facing message, not a crash.
      log.warn('parse_failed', { correlationId, kind: 'program_pdf', error: String(err?.message ?? err) });
      res.status(422).json({ error: `Could not read that PDF: ${err?.message ?? err}` });
    }
  },
);

// ---------- race-day persistence ----------

const toInt = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v)));

function insertRaceDay(db, payload, correlationId) {
  const dayInfo = db.prepare(`INSERT INTO race_days
      (track, date, bankroll_cents, per_race_min_cents, correlation_id)
      VALUES (?, ?, ?, ?, ?)`)
    .run(payload.track, payload.date, toInt(payload.bankrollCents), toInt(payload.perRaceMinCents), correlationId);
  const dayId = dayInfo.lastInsertRowid;

  const insertRace = db.prepare(`INSERT INTO races
      (race_day_id, number, post_time, distance, surface, race_type, conditions,
       claiming_price_cents, wager_menu)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertEntry = db.prepare(`INSERT INTO entries
      (race_id, program_number, post_position, horse_name, morning_line,
       morning_line_decimal, jockey, trainer, weight, equipment, scratched,
       not_to_be_claimed, program_rank, best_bet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const race of payload.races) {
    const raceInfo = insertRace.run(
      dayId, race.number, race.postTime ?? null, race.distance ?? null,
      race.surface ?? null, race.raceType ?? null, race.conditions ?? null,
      toInt(race.claimingPriceCents), race.wagerMenu ?? null,
    );
    for (const e of race.entries) {
      // A scratched horse straight from the program can have no number;
      // the column is NOT NULL, so mark it visibly rather than dropping it.
      const equipment = [e.equipment, e.equipmentChange].filter(Boolean).join('; ') || null;
      insertEntry.run(
        raceInfo.lastInsertRowid,
        e.programNumber ?? 'SCR',
        toInt(e.postPosition), e.horseName ?? '(unnamed)',
        e.morningLine ?? null, e.morningLineDecimal ?? null,
        e.jockey ?? null, e.trainer ?? null, toInt(e.weight), equipment,
        e.scratched ? 1 : 0, e.notToBeClaimed ? 1 : 0,
        toInt(e.programRank), e.bestBet ? 1 : 0,
      );
    }
  }
  return dayId;
}

ingestRouter.post('/race-days', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const p = req.body ?? {};
  const problems = [];
  if (!p.track || typeof p.track !== 'string') problems.push('track is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date ?? '')) problems.push('date must be yyyy-mm-dd');
  if (!Array.isArray(p.races) || p.races.length === 0) problems.push('at least one race is required');
  for (const r of p.races ?? []) {
    if (!Number.isInteger(r.number)) problems.push(`race number missing on a race`);
    if (!Array.isArray(r.entries)) problems.push(`race ${r.number}: entries missing`);
  }
  if (problems.length) return res.status(400).json({ error: problems.join('; ') });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM race_days WHERE track = ? AND date = ?')
    .get(p.track, p.date);
  if (existing && !p.replace) {
    return res.status(409).json({
      error: `A race day for ${p.track} ${p.date} already exists.`,
      existingId: existing.id,
    });
  }

  const save = db.transaction(() => {
    if (existing) db.prepare('DELETE FROM race_days WHERE id = ?').run(existing.id);
    return insertRaceDay(db, p, correlationId);
  });
  const dayId = save();

  log.info('race_day_saved', {
    correlationId,
    raceDayId: dayId,
    track: p.track,
    date: p.date,
    races: p.races.length,
    entries: p.races.reduce((a, r) => a + r.entries.length, 0),
    replaced: Boolean(existing),
  });
  res.status(201).json({ id: dayId, correlationId, replaced: Boolean(existing) });
});

ingestRouter.get('/race-days', (_req, res) => {
  const db = getDb();
  const days = db.prepare(`
    SELECT rd.id, rd.track, rd.date, rd.bankroll_cents, rd.created_at,
           COUNT(DISTINCT r.id) AS races,
           COUNT(e.id) AS entries
    FROM race_days rd
    LEFT JOIN races r ON r.race_day_id = rd.id
    LEFT JOIN entries e ON e.race_id = r.id
    GROUP BY rd.id
    ORDER BY rd.date DESC, rd.track
  `).all();
  res.json(days);
});

ingestRouter.get('/race-days/:id', (req, res) => {
  const db = getDb();
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(req.params.id);
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  const races = db.prepare('SELECT * FROM races WHERE race_day_id = ? ORDER BY number').all(day.id);
  const entriesByRace = db.prepare('SELECT * FROM entries WHERE race_id = ? ORDER BY post_position, program_number');
  res.json({
    ...day,
    races: races.map((r) => ({ ...r, entries: entriesByRace.all(r.id) })),
  });
});
