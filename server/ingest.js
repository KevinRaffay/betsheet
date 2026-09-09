// Ingest API: parse previews and race-day persistence.
//
// The flow is preview-first (invariant 9): POST /api/parse/* returns the
// parsed structure + warnings and never writes anything; the client shows
// it for correction, and only POST /api/race-days persists - whatever the
// user confirmed, not whatever the parser said. Every parse gets a
// correlation id the client echoes back on save (x-correlation-id), so one
// ingest session reads as one trace (invariant 8).

import express from 'express';
import { canonicalizeTrack, meetForDay } from '../shared/track-codes.js';
import { parseEquibaseEntriesHtml } from '../shared/parsers/equibase-entries.js';
import { parseChart } from '../shared/chart-parser.js';
import { parseDmtcResults } from '../shared/dmtc-results-parser.js';
import { extractPdfLines } from './pdf-text.js';
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('app');
const fetchLog = getLogger('fetch-audit');
const traceLog = getLogger('decision-trace');

export const ingestRouter = express.Router();

// This allowlist is the SECOND gate, and both are load-bearing: the column
// carries its own CHECK, and this array must name every value the CHECK
// allows - adding a source means editing a migration (033's successor) AND
// this array, never one of them. Module-scoped (not re-declared per call)
// so insertRaceDay's own gate and the /race-days route's validation can
// never drift into two different lists.
export const ENTRIES_SOURCES = ['program', 'ml_sheet', 'both', 'equibase_html', 'equibase_apify'];

// An omitted entriesSource defaults to 'program' (every ingest path that
// predates D115 relies on this); a PRESENT-but-unrecognized value is
// REFUSED rather than silently coerced to 'program' - the coercion this
// used to do was the bug (D190/D192's "finding 8": a typo or an
// unregistered source's provenance quietly filed under the wrong bucket,
// corrupting invariant 13's isolation without a trace).
function resolveEntriesSource(value) {
  if (value == null) return 'program';
  if (!ENTRIES_SOURCES.includes(value)) {
    throw new Error(`Unknown entriesSource "${value}". Valid values: ${ENTRIES_SOURCES.join(', ')}`);
  }
  return value;
}

// D116: a race day from a manually saved Equibase entries page - the ingest
// path for any track with no automated feed, and the reason a Kentucky Downs
// card is possible at all now that Del Mar program ingestion is gone.
//
// **Invariant 6 is not bent and this is not a fetcher.** The route takes the
// page's markup as a STRING that a person saved and uploaded; nothing here
// makes an outbound request, and there is no HTTP client left in the codebase
// to make one with. Same posture as the Equibase OTR sheet (D71).
//
// Preview only (invariant 9): this never writes. The client shows the parse
// with its warnings and the user confirms through POST /api/race-days, which
// re-reads whatever they confirmed rather than trusting this response.
//
// The body is JSON `{ html }` rather than a raw text/html body, so the same
// endpoint serves both capture routes the parser accepts - a saved file read
// client-side, and markup pasted into a textarea - without the client having
// to know which it has.
ingestRouter.post('/parse/equibase-entries', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const html = String(req.body?.html ?? '');
  if (!html.trim()) return res.status(400).json({ error: 'html (the saved entries page) is required.' });

  const parsed = parseEquibaseEntriesHtml(html);
  // The capture time is the ONE staleness fact this page can supply, and the
  // page does not print it - the file's own mtime is the best available
  // answer and only the client knows it. An absent value is honest: it reads
  // as "staleness unknown", never as "fresh".
  const oddsCapturedAt = typeof req.body?.oddsCapturedAt === 'string' ? req.body.oddsCapturedAt : null;

  log.info('parse_completed', {
    correlationId,
    kind: 'equibase_entries_html',
    bytes: html.length,
    track: parsed.track,
    date: parsed.date,
    races: parsed.races.length,
    entries: parsed.races.reduce((a, r) => a + r.entries.length, 0),
    warnings: parsed.warnings.length,
    blockingWarnings: parsed.warnings.filter((w) => w.blocking).length,
  });
  res.json({ correlationId, ...parsed, entriesSource: 'equibase_html', oddsCapturedAt });
});

// The PDF arrives as a raw application/pdf body (no multipart dependency).
ingestRouter.post('/parse/results-text', (req, res) => {
  const text = String(req.body?.text ?? '');
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const parsed = parseChart(text);
  log.info('parse_completed', {
    correlationId,
    kind: 'results_text',
    bytes: text.length,
    races: parsed.races.length,
    finishers: parsed.races.reduce((a, r) => a + r.results.length, 0),
    exotics: parsed.races.reduce((a, r) => a + r.exotics.length, 0),
    warnings: parsed.warnings.length,
  });
  res.json({ correlationId, ...parsed });
});

// A downloaded chart PDF: its text layer IS the paste format, so the PDF
// path extracts (server/pdf-text.js) and feeds the same parser.
ingestRouter.post(
  '/parse/results-pdf',
  express.raw({ type: 'application/pdf', limit: '30mb' }),
  async (req, res) => {
    const correlationId = req.get('x-correlation-id') || newCorrelationId();
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Send the chart PDF as a raw application/pdf body.' });
    }
    try {
      const text = await extractPdfLines(new Uint8Array(req.body));
      const parsed = parseChart(text);
      log.info('parse_completed', {
        correlationId,
        kind: 'results_pdf',
        bytes: req.body.length,
        races: parsed.races.length,
        finishers: parsed.races.reduce((a, r) => a + r.results.length, 0),
        exotics: parsed.races.reduce((a, r) => a + r.exotics.length, 0),
        warnings: parsed.warnings.length,
      });
      res.json({ correlationId, ...parsed });
    } catch (err) {
      log.warn('parse_failed', { correlationId, kind: 'results_pdf', error: String(err?.message ?? err) });
      res.status(422).json({ error: `Could not read that PDF: ${err?.message ?? err}` });
    }
  },
);

// ---------- race-day persistence ----------

const toInt = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v)));

// Shared by the save route and the batch backfill (D43): one writer, so a
// backfilled day and a clicked one are the same rows. `meet` is derived
// from the track + date (DMR-<year>-summer / -fall), never typed. The track
// is canonicalized here too (D35) - the ONE place a race day's track and
// track_code are decided, regardless of which ingest path's spelling
// (program panel letters, Bottom Line fallback, ML sheet header, ...) it
// arrived with.
export function insertRaceDay(db, payload, correlationId) {
  const entriesSource = resolveEntriesSource(payload.entriesSource);
  const bottomLineByRace = new Map((payload.analysis ?? [])
    .filter((chunk) => chunk && Number.isInteger(chunk.race) && chunk.text)
    .map((chunk) => [chunk.race, String(chunk.text)]));
  const { code: trackCode, display: track } = canonicalizeTrack(payload.track);
  const dayInfo = db.prepare(`INSERT INTO race_days
      (track, track_code, date, bankroll_cents, per_race_min_cents, correlation_id,
       entries_source, meet, odds_captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(track, trackCode, payload.date, toInt(payload.bankrollCents), toInt(payload.perRaceMinCents), correlationId, entriesSource,
      meetForDay(track, payload.date),
      // D115: ONE timestamp for the whole card - when the entries page was
      // captured. Only the Equibase path supplies it; every other path leaves
      // it null, which reads as "staleness unknown" rather than "fresh".
      payload.oddsCapturedAt ?? null);
  const dayId = dayInfo.lastInsertRowid;

  const insertRace = db.prepare(`INSERT INTO races
      (race_day_id, number, post_time, distance, surface, race_type, conditions,
       claiming_price_cents, wager_menu, bottom_line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertEntry = db.prepare(`INSERT INTO entries
      (race_id, program_number, post_position, horse_name, morning_line,
       morning_line_decimal, jockey, trainer, weight, equipment, scratched,
       not_to_be_claimed, program_rank, best_bet,
       live_odds, live_odds_decimal, medication, age_sex, claim_price, also_eligible)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const race of payload.races) {
    const raceInfo = insertRace.run(
      dayId, race.number, race.postTime ?? null, race.distance ?? null,
      race.surface ?? null, race.raceType ?? null, race.conditions ?? null,
      toInt(race.claimingPriceCents), race.wagerMenu ?? null,
      bottomLineByRace.get(race.number) ?? null,
    );
    // D180: a scratched horse can have NO printed program number - Equibase
    // replaces the number and post-position cells with a colspan SCR marker -
    // and since migration 032 the column is NULLABLE, so that fact is stored
    // as NULL rather than as the literal 'SCR'.
    //
    // This is what D122's 'SCR' / 'SCR-2' / 'SCR-3' placeholders existed to
    // work around: they collided on UNIQUE(race_id, program_number) whenever a
    // race scratched two horses, which broke 10 of 91 real days outright.
    // SQLite's UNIQUE permits any number of NULLs, so the collision is now
    // impossible rather than suffixed around - and the stored value no longer
    // depends on the order rows happen to be parsed in, which 'SCR-2' did.
    for (const e of race.entries) {
      // A scratched horse can have no number printed at all; the column is
      // NOT NULL, so mark it visibly rather than dropping the horse.
      const equipment = [e.equipment, e.equipmentChange].filter(Boolean).join('; ') || null;
      insertEntry.run(
        raceInfo.lastInsertRowid,
        e.programNumber ?? null,
        toInt(e.postPosition), e.horseName ?? '(unnamed)',
        e.morningLine ?? null, e.morningLineDecimal ?? null,
        e.jockey ?? null, e.trainer ?? null, toInt(e.weight), equipment,
        e.scratched ? 1 : 0, e.notToBeClaimed ? 1 : 0,
        toInt(e.programRank), e.bestBet ? 1 : 0,
        // D115/D116: the Equibase page's own fields. Every other ingest path
        // leaves them null, which is why they are read off the entry with a
        // fallback rather than required. Live odds sit BESIDE the morning
        // line and never replace it - see the migration for why feeding them
        // to generation would be an ENGINE_VERSION-class change.
        e.liveOdds ?? null, e.liveOddsDecimal ?? null,
        e.medication ?? null, e.ageSex ?? null, e.claimPrice ?? null,
        e.alsoEligible ? 1 : 0,
      );
    }
  }
  return dayId;
}

// ---------- ML sheet (D40): the entries source of record ----------

// Parse an uploaded ML/changes PDF. Preview only - never writes.
// D113 removed three parse routes and one fetch route from here with the
// parsers behind them: /parse/program-pdf, /parse/ml-pdf, /parse/merge and
// /fetch/ml-sheet, plus /race-days/:id/results/from-archive, which read the
// dmtc raw archive the crawler built. What is left is the pasted-entries
// preview (which the Equibase HTML ingest replaces when it is wired, and
// which stays until then so a race day can still be created) and the three
// results previews, all of which the pivot keeps.

ingestRouter.post('/parse/results-html', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const html = String(req.body?.html ?? '');
  if (!html.trim()) return res.status(400).json({ error: 'html (the results page source) is required.' });
  const parsed = parseDmtcResults(html);
  log.info('parse_completed', {
    correlationId, kind: 'results_html', bytes: html.length, races: parsed.races.length,
    finishers: parsed.races.reduce((a, r) => a + r.results.length, 0),
    exotics: parsed.races.reduce((a, r) => a + r.exotics.length, 0), warnings: parsed.warnings.length,
  });
  res.json({ correlationId, sourceKind: 'dmtc_html', ...parsed });
});

// Preview a race day's results from the D41 raw archive (never the network).
// The calendar's race count must equal the parsed count - a mismatch is a
// hard error for the day (422), per the D42 rule.
ingestRouter.post('/race-days', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const p = req.body ?? {};
  const problems = [];
  if (!p.track || typeof p.track !== 'string') problems.push('track is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date ?? '')) problems.push('date must be yyyy-mm-dd');
  if (!Array.isArray(p.races) || p.races.length === 0) problems.push('at least one race is required');
  if (p.entriesSource != null && !ENTRIES_SOURCES.includes(p.entriesSource)) {
    problems.push(`entriesSource "${p.entriesSource}" is not recognized. Valid values: ${ENTRIES_SOURCES.join(', ')}`);
  }
  for (const r of p.races ?? []) {
    if (!Number.isInteger(r.number)) problems.push(`race number missing on a race`);
    if (!Array.isArray(r.entries)) problems.push(`race ${r.number}: entries missing`);
  }
  if (problems.length) return res.status(400).json({ error: problems.join('; ') });

  const db = getDb();
  // The one-day-per-track+date rule keys on the canonical code (D35), not
  // the raw text a parser happened to spell the track with - "Del Mar" and
  // "Delmar" collide on the same date instead of silently coexisting.
  const existing = db.prepare('SELECT id, deleted_at FROM race_days WHERE track_code = ? AND date = ?')
    .get(canonicalizeTrack(p.track).code, p.date);
  // A LIVE duplicate needs an explicit replace; a soft-deleted tombstone
  // for the same track/date is superseded by re-ingesting - the user
  // already deleted it, and the code+date pair leaves no other slot.
  if (existing && !existing.deleted_at && !p.replace) {
    return res.status(409).json({
      error: `A race day for ${p.track} ${p.date} already exists.`,
      existingId: existing.id,
    });
  }

  const oldRow = existing
    ? db.prepare('SELECT id, correlation_id, deleted_at FROM race_days WHERE id = ?').get(existing.id)
    : null;
  const save = db.transaction(() => {
    if (existing) db.prepare('DELETE FROM race_days WHERE id = ?').run(existing.id);
    return insertRaceDay(db, p, correlationId);
  });
  const dayId = save();

  // A replaced/superseded day documents itself in the trace: the old id and
  // correlation id stay resolvable even though the row is gone, so log
  // events referencing them read as "that day was superseded by this one".
  if (oldRow) {
    traceLog.info('race_day_superseded', {
      correlationId,
      raceDayId: dayId,
      supersededRaceDayId: oldRow.id,
      supersededCorrelationId: oldRow.correlation_id,
      supersededWasDeleted: Boolean(oldRow.deleted_at),
      track: p.track,
      date: p.date,
    });
  }

  log.info('race_day_saved', {
    correlationId,
    raceDayId: dayId,
    track: p.track,
    date: p.date,
    races: p.races.length,
    entries: p.races.reduce((a, r) => a + r.entries.length, 0),
    entriesSource: p.entriesSource ?? 'program',
    replaced: Boolean(existing),
  });
  res.status(201).json({ id: dayId, correlationId, replaced: Boolean(existing) });
});

ingestRouter.get('/race-days', (req, res) => {
  const db = getDb();
  const showDeleted = req.query.deleted === '1';
  const days = db.prepare(`
    SELECT rd.id, rd.track, rd.date, rd.bankroll_cents, rd.created_at, rd.deleted_at,
           COUNT(DISTINCT r.id) AS races,
           COUNT(e.id) AS entries,
           EXISTS(SELECT 1 FROM race_results rr WHERE rr.race_day_id = rd.id) AS graded
    FROM race_days rd
    LEFT JOIN races r ON r.race_day_id = rd.id
    LEFT JOIN entries e ON e.race_id = r.id
    WHERE rd.deleted_at IS ${showDeleted ? 'NOT NULL' : 'NULL'}
    GROUP BY rd.id
    ORDER BY rd.date DESC, rd.track
  `).all();
  res.json(days);
});

// What a deletion would remove - the confirmation dialog's numbers.
ingestRouter.get('/race-days/:id/deletion-preview', (req, res) => {
  const db = getDb();
  const day = db.prepare('SELECT id FROM race_days WHERE id = ?').get(req.params.id);
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  const one = (sql) => db.prepare(sql).get(day.id).n;
  res.json({
    races: one('SELECT COUNT(*) n FROM races WHERE race_day_id = ?'),
    entries: one('SELECT COUNT(*) n FROM entries e JOIN races r ON r.id = e.race_id WHERE r.race_day_id = ?'),
    sources: one(`SELECT COUNT(DISTINCT cp.source_id) n FROM consensus_picks cp
                  JOIN races r ON r.id = cp.race_id WHERE r.race_day_id = ?`),
    cards: one('SELECT COUNT(*) n FROM cards WHERE race_day_id = ?'),
    tickets: one('SELECT COUNT(*) n FROM tickets t JOIN cards c ON c.id = t.card_id WHERE c.race_day_id = ?'),
    results: one('SELECT COUNT(*) n FROM race_results WHERE race_day_id = ?'),
  });
});

// Soft delete: the row (and, by filter, its whole tree) disappears from
// every default query. The decision-trace and fetch-audit LOG FILES are
// deliberately untouched - a deleted day's history stays readable under
// its correlation ids - and the deletion itself becomes a trace event.
// Shared by the single-day route below and the bulk-delete route further
// down, so both log the exact same event shape under the day's OWN
// correlation id (invariant 8) rather than a batch id that would mean
// nothing to that day's own trace.
function softDeleteRaceDay(db, day) {
  const counts = {
    races: db.prepare('SELECT COUNT(*) n FROM races WHERE race_day_id = ?').get(day.id).n,
    entries: db.prepare('SELECT COUNT(*) n FROM entries e JOIN races r ON r.id = e.race_id WHERE r.race_day_id = ?').get(day.id).n,
    cards: db.prepare('SELECT COUNT(*) n FROM cards WHERE race_day_id = ?').get(day.id).n,
    tickets: db.prepare('SELECT COUNT(*) n FROM tickets t JOIN cards c ON c.id = t.card_id WHERE c.race_day_id = ?').get(day.id).n,
  };
  // The write comes first, and the success event is only logged if the
  // write demonstrably landed - the trace never asserts something that
  // didn't happen.
  const changes = db.prepare(
    "UPDATE race_days SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND deleted_at IS NULL",
  ).run(day.id).changes;
  if (changes !== 1) return { ok: false, counts };

  const event = {
    correlationId: day.correlation_id,
    raceDayId: day.id,
    track: day.track,
    date: day.date,
    ...counts,
  };
  traceLog.info('race_day_deleted', event);
  log.info('race_day_deleted', event);
  return { ok: true, counts };
}

ingestRouter.delete('/race-days/:id', (req, res) => {
  const db = getDb();
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(req.params.id);
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) return res.status(409).json({ error: 'Already deleted.' });

  const { ok, counts } = softDeleteRaceDay(db, day);
  if (!ok) {
    log.error('race_day_delete_failed', { raceDayId: day.id });
    return res.status(500).json({ error: 'Delete did not persist; nothing was logged as deleted.' });
  }
  res.json({ ok: true, ...counts });
});

// Bulk delete from the race-days list (checkbox selection): one request,
// many ids, each handled independently so one bad id can't block the rest
// (the same posture server/entries-zip.js's Policy A batch save uses).
// **Scoped to bulk-delete only** - the single-day route above is
// deliberately untouched and still has no grading guard (user decision
// 2026-09-07): a graded race day (one with saved results) is refused HERE,
// server-side and unconditionally, regardless of what the client selected -
// the disabled checkbox in the UI is a convenience, not the only guard,
// the same "never trust a client-shaped payload" posture invariant 9 uses
// elsewhere.
ingestRouter.post('/race-days/bulk-delete', (req, res) => {
  const db = getDb();
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Number.isInteger(id))) {
    return res.status(400).json({ error: 'ids must be a non-empty array of integers.' });
  }

  const deleted = [];
  const skipped = [];
  for (const id of ids) {
    const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(id);
    if (!day) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    if (day.deleted_at) {
      skipped.push({ id, track: day.track, date: day.date, reason: 'already_deleted' });
      continue;
    }
    const graded = db.prepare('SELECT 1 FROM race_results WHERE race_day_id = ? LIMIT 1').get(day.id);
    if (graded) {
      skipped.push({ id, track: day.track, date: day.date, reason: 'graded' });
      continue;
    }
    const { ok, counts } = softDeleteRaceDay(db, day);
    if (!ok) {
      log.error('race_day_delete_failed', { raceDayId: day.id });
      skipped.push({ id, track: day.track, date: day.date, reason: 'write_failed' });
      continue;
    }
    deleted.push({ id, track: day.track, date: day.date, ...counts });
  }
  res.json({ deleted, skipped });
});

ingestRouter.post('/race-days/:id/restore', (req, res) => {
  const db = getDb();
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(req.params.id);
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (!day.deleted_at) return res.status(409).json({ error: 'Not deleted.' });
  db.prepare('UPDATE race_days SET deleted_at = NULL WHERE id = ?').run(day.id);
  const event = { correlationId: day.correlation_id, raceDayId: day.id, track: day.track, date: day.date };
  traceLog.info('race_day_restored', event);
  log.info('race_day_restored', event);
  res.json({ ok: true });
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
