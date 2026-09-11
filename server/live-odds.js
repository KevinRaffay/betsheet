// Live odds capture (D224): refresh a stored race day's tote board from a
// freshly-saved Equibase entries page, WITHOUT touching anything else on it.
//
// The board is the one input this project has never had. `entries.live_odds`
// has existed since migration 024 and was measured empty on 0 of 13,710 rows
// (D171, re-measured on the 2026-09-10 corpus), which is why
// `shared/tip-staking.js`'s ML-vs-live staking draft has sat unrunnable since
// D171 and why `shared/pick-scoring.js` has to use the MORNING-LINE favorite as
// its market baseline instead of the post-time one.
//
// WHY THIS IS NOT THE ENTRIES INGEST. The day already exists, so the ingest
// path's only way to update it is `?replace=1`, which HARD-DELETES the day and
// cascades away every card and ticket on it (the D204 gotcha: a Kentucky Downs
// day with 168 entries and 98 human tickets destroyed exactly that way). A
// price refresh must be additive, and every refusal that makes it additive
// lives in `shared/live-odds.js` - this file is the I/O half only.
//
// PREVIEW-FIRST (invariant 9): `/preview` never writes, and the confirm route
// re-parses the HTML server-side rather than trusting a client-shaped list of
// updates - the same rule `persistHumanRace` (D54) and `persistLlmRace` (D63)
// already follow, for the same reason.
//
// INVARIANT 6 IS UNTOUCHED. Nothing here fetches. The capture is a file a
// person saved from their own browser and uploaded, which is the same posture
// every other source in this codebase has had since D113.
//
// INVARIANT 11: every attempt - including one that read no prices at all -
// lands in `fetch_attempts` and the fetch-audit stream via `recordAttempt`, so
// a board that never came up is visible rather than silently absent.

import crypto from 'node:crypto';
import express from 'express';
import { parseEquibaseEntriesHtml } from '../shared/parsers/equibase-entries.js';
import { reconcileOddsCapture } from '../shared/live-odds.js';
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';
import { recordAttempt, upsertSource } from './source-audit.js';

const appLog = getLogger('app');
const traceLog = getLogger('decision-trace');

export const liveOddsRouter = express.Router();

const SOURCE_NAME = 'Equibase live odds (manual upload)';
const sha256 = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex');

/** The stored day in the exact shape `reconcileOddsCapture` reads. */
export function loadStoredDay(db, dayId) {
  const day = db.prepare('SELECT id, track, date, correlation_id, odds_captured_at FROM race_days WHERE id = ? AND deleted_at IS NULL').get(dayId);
  if (!day) return null;
  const races = db.prepare('SELECT id, number FROM races WHERE race_day_id = ? ORDER BY number').all(dayId);
  const entries = db.prepare(`
    SELECT e.race_id, e.program_number, e.horse_name, e.morning_line, e.live_odds, e.scratched
    FROM entries e JOIN races r ON r.id = e.race_id
    WHERE r.race_day_id = ? ORDER BY r.number, e.program_number`).all(dayId);
  const byRace = new Map(races.map((r) => [r.id, []]));
  for (const e of entries) {
    byRace.get(e.race_id)?.push({
      programNumber: e.program_number, horseName: e.horse_name,
      morningLine: e.morning_line, liveOdds: e.live_odds, scratched: Boolean(e.scratched),
    });
  }
  return {
    id: day.id, track: day.track, date: day.date,
    correlationId: day.correlation_id, oddsCapturedAt: day.odds_captured_at,
    races: races.map((r) => ({ id: r.id, number: r.number, entries: byRace.get(r.id) ?? [] })),
  };
}

/** Parse + reconcile. Shared by preview and confirm so they cannot diverge. */
function readCapture(db, dayId, html) {
  const stored = loadStoredDay(db, dayId);
  if (!stored) return { notFound: true };
  const parsed = parseEquibaseEntriesHtml(html);
  const result = reconcileOddsCapture({ stored, parsed });
  return {
    stored,
    parsed,
    ...result,
    // The parser's own warnings ride along with the reconciler's, ahead of
    // them: a page that failed to parse explains every downstream refusal.
    warnings: [...(parsed.warnings ?? []), ...result.warnings],
  };
}

function auditAttempt(db, { dayId, correlationId, html, outcome, priced, reason }) {
  const sourceId = upsertSource(db, { name: SOURCE_NAME, kind: 'manual' });
  recordAttempt(db, {
    raceDayId: dayId, sourceId, outcome, bytes: html.length,
    parseOk: outcome === 'manual_upload' ? 1 : 0,
    picksExtracted: priced ?? null, fallbackReason: reason ?? null, correlationId,
  });
}

/**
 * Preview. Writes NOTHING to the domain tables - the audit row is the one
 * exception and is the point of invariant 11: an upload that read no board is
 * exactly the event that must not vanish.
 */
liveOddsRouter.post('/race-days/:id/live-odds/preview', (req, res) => {
  const db = getDb();
  const dayId = Number(req.params.id);
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const html = String(req.body?.html ?? '');
  if (!html.trim()) return res.status(400).json({ error: 'html (the saved Equibase entries page) is required.' });

  const out = readCapture(db, dayId, html);
  if (out.notFound) return res.status(404).json({ error: 'Race day not found.' });

  auditAttempt(db, {
    dayId, correlationId, html,
    outcome: out.ok ? 'manual_upload' : 'parse_error',
    priced: out.counts.priced,
    reason: out.ok ? null : (out.warnings.find((w) => w.blocking)?.type ?? 'unknown'),
  });
  appLog.info('parse_completed', {
    correlationId, kind: 'equibase_live_odds', bytes: html.length,
    track: out.parsed.track, date: out.parsed.date,
    races: out.counts.racesMatched, priced: out.counts.priced,
    warnings: out.warnings.length, blockingWarnings: out.warnings.filter((w) => w.blocking).length,
  });

  res.json({
    correlationId, ok: out.ok,
    track: out.parsed.track, date: out.parsed.date,
    day: { id: out.stored.id, track: out.stored.track, date: out.stored.date, oddsCapturedAt: out.stored.oddsCapturedAt },
    races: out.races, counts: out.counts, warnings: out.warnings,
  });
});

/**
 * Confirm. Re-parses the SAME html server-side; a client cannot hand this
 * route a price. Refuses (422) on anything the reconciler declined.
 */
liveOddsRouter.post('/race-days/:id/live-odds', (req, res) => {
  const db = getDb();
  const dayId = Number(req.params.id);
  const html = String(req.body?.html ?? '');
  const capturedAt = typeof req.body?.oddsCapturedAt === 'string' ? req.body.oddsCapturedAt : null;
  if (!html.trim()) return res.status(400).json({ error: 'html (the saved Equibase entries page) is required.' });

  const out = readCapture(db, dayId, html);
  if (out.notFound) return res.status(404).json({ error: 'Race day not found.' });
  // Every card session on this day shares its correlation id (invariant 8), so
  // a capture joins the day's own trace rather than opening a new one.
  const correlationId = req.get('x-correlation-id') || out.stored.correlationId || newCorrelationId();

  if (!out.ok) {
    auditAttempt(db, {
      dayId, correlationId, html, outcome: 'parse_error', priced: out.counts.priced,
      reason: out.warnings.find((w) => w.blocking)?.type ?? 'unknown',
    });
    return res.status(422).json({ error: 'This capture was refused.', warnings: out.warnings, counts: out.counts });
  }

  const raceIdByNumber = new Map(out.stored.races.map((r) => [r.number, r.id]));
  let captureId = null;

  db.transaction(() => {
    captureId = db.prepare(`INSERT INTO odds_captures
        (race_day_id, captured_at, source, raw_digest, correlation_id)
        VALUES (?, ?, 'equibase_html', ?, ?)`)
      .run(dayId, capturedAt, sha256(html), correlationId).lastInsertRowid;

    const insRow = db.prepare(`INSERT INTO odds_capture_entries
        (capture_id, race_number, program_number, live_odds, live_odds_decimal)
        VALUES (?, ?, ?, ?, ?)`);
    // `entries.live_odds` is the LATEST-capture cache (migration 034's own
    // note). The history above is what a later capture must never overwrite;
    // this row is what every existing reader already looks at.
    const updEntry = db.prepare('UPDATE entries SET live_odds = ?, live_odds_decimal = ? WHERE race_id = ? AND program_number = ?');

    for (const u of out.updates) {
      insRow.run(captureId, u.raceNumber, u.programNumber, u.liveOdds, u.liveOddsDecimal);
      const raceId = raceIdByNumber.get(u.raceNumber);
      if (raceId) updEntry.run(u.liveOdds, u.liveOddsDecimal, raceId, u.programNumber);
    }

    // One capture time for the whole card, because that is what the source can
    // supply - D117's staleness indicator exists precisely to make the later
    // races' extra staleness visible rather than to pretend it away. Only
    // moved FORWARD: re-uploading an older page must not make the day read
    // fresher than the board actually is.
    const prev = out.stored.oddsCapturedAt;
    if (capturedAt && (!prev || capturedAt > prev)) {
      db.prepare('UPDATE race_days SET odds_captured_at = ? WHERE id = ?').run(capturedAt, dayId);
    }
  })();

  auditAttempt(db, { dayId, correlationId, html, outcome: 'manual_upload', priced: out.counts.priced, reason: null });
  traceLog.info('live_odds_captured', {
    correlationId, raceDayId: dayId, captureId, capturedAt,
    races: out.counts.racesMatched, priced: out.counts.priced,
    changed: out.counts.changed, firstPrice: out.counts.firstPrice, unchanged: out.counts.unchanged,
  });

  const captures = db.prepare('SELECT COUNT(*) AS n FROM odds_captures WHERE race_day_id = ?').get(dayId).n;
  res.json({ correlationId, captureId, counts: out.counts, warnings: out.warnings, capturesOnDay: captures });
});

/** Read-only: every capture on a day, newest first. The drift is the point. */
liveOddsRouter.get('/race-days/:id/live-odds', (req, res) => {
  const db = getDb();
  const dayId = Number(req.params.id);
  const day = db.prepare('SELECT id FROM race_days WHERE id = ? AND deleted_at IS NULL').get(dayId);
  if (!day) return res.status(404).json({ error: 'Race day not found.' });
  const captures = db.prepare(`SELECT c.id, c.captured_at, c.source, c.ingested_at, c.correlation_id,
      (SELECT COUNT(*) FROM odds_capture_entries WHERE capture_id = c.id) AS prices
      FROM odds_captures c WHERE c.race_day_id = ? ORDER BY COALESCE(c.captured_at, c.ingested_at) DESC, c.id DESC`).all(dayId);
  res.json({ captures });
});
