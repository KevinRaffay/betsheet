// Ingest API: parse previews and race-day persistence.
//
// The flow is preview-first (invariant 9): POST /api/parse/* returns the
// parsed structure + warnings and never writes anything; the client shows
// it for correction, and only POST /api/race-days persists - whatever the
// user confirmed, not whatever the parser said. Every parse gets a
// correlation id the client echoes back on save (x-correlation-id), so one
// ingest session reads as one trace (invariant 8).

import express from 'express';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { parseEntries } from '../shared/entries-parser.js';
import { parseChart } from '../shared/chart-parser.js';
import { parseProgramPdf } from './program-parser.js';
import { parseMlSheetPdf } from './ml-sheet-parser.js';
import { mergeMlAndProgram } from '../shared/entries-merge.js';
import { parseDmtcResults } from '../shared/dmtc-results-parser.js';
import { DEFAULT_RAW_DIR, dayDir, meetForDay, readManifest } from './dmtc-crawler.js';
import fs from 'node:fs';
import path from 'node:path';
import { listFetchers, loadExtraFetchers } from './fetchers/index.js';
import { fetchWithTimeout, recordAttempt, robotsDisallows, upsertSource } from './consensus.js';
import { extractPdfLines } from './pdf-text.js';
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('app');
const fetchLog = getLogger('fetch-audit');
const traceLog = getLogger('decision-trace');

export const ingestRouter = express.Router();

// D35: an unrecognized track still parses and saves - it gets a derived
// code (canonicalizeTrack), never a block - but the preview names it so a
// typo or a new track is visible before Save rather than surfacing later as
// a silent classification/fetch miss (D53's root cause).
function addTrackWarning(parsed) {
  if (!parsed?.track || !Array.isArray(parsed.warnings)) return parsed;
  const { recognized, code } = canonicalizeTrack(parsed.track);
  if (!recognized) {
    parsed.warnings.push({
      type: 'unrecognized_track',
      message: `"${parsed.track}" is not a known track; it will save under a derived code (${code}). Check the spelling above.`,
    });
  }
  return parsed;
}

ingestRouter.post('/parse/entries-text', (req, res) => {
  const text = String(req.body?.text ?? '');
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const parsed = addTrackWarning(parseEntries(text));
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
      const parsed = addTrackWarning(await parseProgramPdf(new Uint8Array(req.body), expected));
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

// ---------- results-chart parsing (preview only; D14 persists) ----------

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
  const entriesSource = ['program', 'ml_sheet', 'both'].includes(payload.entriesSource) ? payload.entriesSource : 'program';
  const bottomLineByRace = new Map((payload.analysis ?? [])
    .filter((chunk) => chunk && Number.isInteger(chunk.race) && chunk.text)
    .map((chunk) => [chunk.race, String(chunk.text)]));
  const { code: trackCode, display: track } = canonicalizeTrack(payload.track);
  const dayInfo = db.prepare(`INSERT INTO race_days
      (track, track_code, date, bankroll_cents, per_race_min_cents, correlation_id, entries_source, meet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(track, trackCode, payload.date, toInt(payload.bankrollCents), toInt(payload.perRaceMinCents), correlationId, entriesSource,
      meetForDay(track, payload.date));
  const dayId = dayInfo.lastInsertRowid;

  const insertRace = db.prepare(`INSERT INTO races
      (race_day_id, number, post_time, distance, surface, race_type, conditions,
       claiming_price_cents, wager_menu, bottom_line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
      bottomLineByRace.get(race.number) ?? null,
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

// ---------- ML sheet (D40): the entries source of record ----------

// Parse an uploaded ML/changes PDF. Preview only - never writes.
ingestRouter.post(
  '/parse/ml-pdf',
  express.raw({ type: 'application/pdf', limit: '30mb' }),
  async (req, res) => {
    const correlationId = req.get('x-correlation-id') || newCorrelationId();
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Send the PDF as a raw application/pdf body.' });
    }
    try {
      const expected = { track: req.query.track || undefined, date: req.query.date || undefined };
      const parsed = addTrackWarning(await parseMlSheetPdf(new Uint8Array(req.body), expected));
      log.info('parse_completed', {
        correlationId, kind: 'ml_sheet', bytes: req.body.length, races: parsed.races.length,
        entries: parsed.races.reduce((a, r) => a + r.entries.length, 0), warnings: parsed.warnings.length,
      });
      res.json({ correlationId, entriesSource: 'ml_sheet', ...parsed });
    } catch (err) {
      log.warn('parse_failed', { correlationId, kind: 'ml_sheet', error: String(err?.message ?? err) });
      res.status(422).json({ error: `Could not read that PDF: ${err?.message ?? err}` });
    }
  },
);

// Merge an ML sheet parse with a program parse: the sheet is the record,
// the program contributes analysis; every disagreement is a warning.
ingestRouter.post('/parse/merge', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const { ml, program } = req.body ?? {};
  if (!ml || !Array.isArray(ml.races)) return res.status(400).json({ error: 'ml (an ML sheet parse) is required.' });
  if (program != null && !Array.isArray(program.races)) return res.status(400).json({ error: 'program must be a program parse or null.' });
  const merged = addTrackWarning(mergeMlAndProgram(ml, program ?? null));
  log.info('merge_completed', {
    correlationId, entriesSource: merged.entriesSource, races: merged.races.length,
    disagreements: merged.warnings.filter((w) => w.type === 'program_ml_disagreement').length,
    warnings: merged.warnings.length,
  });
  res.json({ correlationId, ...merged });
});

// Fetch the ML sheet from the track for a track/date and return its parse
// (preview only). Audited like every fetch (invariant 11): always to the
// fetch-audit stream, and to fetch_attempts too when the day already
// exists (the table keys on a race day).
ingestRouter.post('/fetch/ml-sheet', async (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const track = String(req.body?.track ?? '').trim();
  const date = String(req.body?.date ?? '').trim();
  if (!track || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'track and date (yyyy-mm-dd) are required.' });
  await loadExtraFetchers();
  const fetcher = listFetchers().find((f) => f.produces === 'entries' && f.supports({ track, date }));
  if (!fetcher) return res.status(404).json({ error: `No ML-sheet source is registered for ${track}. Upload the PDF instead.` });
  const db = getDb();
  const day = db.prepare('SELECT id FROM race_days WHERE track_code = ? AND date = ? AND deleted_at IS NULL')
    .get(canonicalizeTrack(track).code, date);
  const sourceId = upsertSource(db, fetcher);
  const audit = (outcome, extra = {}) => {
    fetchLog.info('fetch_attempt', { correlationId, source: fetcher.name, track, date, outcome, ...extra });
    if (day) recordAttempt(db, { raceDayId: day.id, sourceId, correlationId, outcome, ...extra });
  };
  const url = fetcher.buildUrl({ track, date });
  if (!url) { audit('http_error', { fallbackReason: 'no URL for this date' }); return res.status(400).json({ error: 'No URL for that date.' }); }
  try {
    if (await robotsDisallows(url)) {
      audit('blocked', { url, fallbackReason: 'disallowed by robots.txt - upload the PDF manually' });
      return res.status(403).json({ error: 'robots.txt disallows fetching the ML sheet; upload the PDF instead.', url });
    }
    const r = await fetchWithTimeout(url);
    if (!r.ok) {
      audit('http_error', { url, httpStatus: r.status, fallbackReason: `HTTP ${r.status}` });
      return res.status(r.status === 404 ? 404 : 502).json({ error: `The track answered HTTP ${r.status} for ${url}.`, url });
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    // pdfjs detaches the buffer while parsing: take the size first or the
    // audit line says 0 bytes.
    const byteLength = bytes.length;
    let parsed;
    try {
      parsed = await parseMlSheetPdf(bytes, { track, date });
    } catch (err) {
      audit('parse_error', { url, httpStatus: r.status, bytes: byteLength, parseOk: 0, fallbackReason: String(err?.message ?? err) });
      return res.status(422).json({ error: `Fetched the sheet but could not read it: ${err?.message ?? err}`, url });
    }
    const mismatch = parsed.warnings.find((w) => w.type === 'wrong_date' || w.type === 'wrong_track');
    if (mismatch) {
      audit('track_date_mismatch', { url, httpStatus: r.status, bytes: byteLength, parseOk: 1, fallbackReason: mismatch.message });
      return res.status(422).json({ error: mismatch.message, url });
    }
    audit('ok', { url, httpStatus: r.status, bytes: byteLength, parseOk: 1, picksExtracted: parsed.races.reduce((a, x) => a + x.entries.length, 0) });
    res.json({ correlationId, entriesSource: 'ml_sheet', fetchedFrom: url, ...parsed });
  } catch (err) {
    audit('network_error', { url, fallbackReason: String(err?.message ?? err) });
    res.status(502).json({ error: `Could not reach the track: ${err?.message ?? err}`, url });
  }
});

// ---------- dmtc results page (D42): the second results source ----------

// Parse an uploaded / pasted dmtc.com results page. Preview only.
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
ingestRouter.post('/race-days/:id/results/from-archive', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = db.prepare('SELECT id, track, date, deleted_at FROM race_days WHERE id = ?').get(Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) return res.status(410).json({ error: 'This race day is deleted.' });
  const rawDir = process.env.BETSHEET_RAW_DIR || DEFAULT_RAW_DIR;
  const file = path.join(dayDir(rawDir, day.date), 'results.html');
  if (!fs.existsSync(file)) return res.status(404).json({ error: `No archived results page for ${day.date}. Run: npm run dmtc-fetch -- --from ${day.date} --to ${day.date} --what results` });
  const manifest = readManifest(rawDir, day.date);
  const expected = { races: manifest?.calendar?.races ?? null };
  const parsed = parseDmtcResults(fs.readFileSync(file, 'utf8'), expected);
  const mismatch = parsed.warnings.find((w) => w.type === 'race_count_mismatch');
  log.info('parse_completed', {
    correlationId, kind: 'results_archive', raceDayId: day.id, races: parsed.races.length,
    expectedRaces: expected.races, warnings: parsed.warnings.length, mismatch: Boolean(mismatch),
  });
  if (mismatch) return res.status(422).json({ error: `${mismatch.message} Nothing to preview - the archived page is incomplete or the calendar is wrong.`, warnings: parsed.warnings });
  res.json({ correlationId, sourceKind: 'dmtc_html', archivedAt: manifest?.artifacts?.results?.fetched_at ?? null, ...parsed });
});

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
  // The one-day-per-track+date rule keys on the canonical code (D35), not
  // the raw text a parser happened to spell the track with - "Del Mar" and
  // "Delmar" collide on the same date instead of silently coexisting.
  const existingRows = db.prepare('SELECT id, correlation_id, deleted_at FROM race_days WHERE track_code = ? AND date = ? ORDER BY deleted_at IS NULL DESC, id')
    .all(canonicalizeTrack(p.track).code, p.date);
  const existing = existingRows[0] ?? null;
  // A LIVE duplicate needs an explicit replace; a soft-deleted tombstone
  // for the same track/date is superseded by re-ingesting - the user
  // already deleted it, and the code+date pair leaves no other slot.
  if (existingRows.some((row) => !row.deleted_at) && !p.replace) {
    return res.status(409).json({
      error: `A race day for ${p.track} ${p.date} already exists.`,
      existingId: existing.id,
    });
  }

  const oldRows = existingRows;
  const save = db.transaction(() => {
    for (const row of oldRows) db.prepare('DELETE FROM race_days WHERE id = ?').run(row.id);
    return insertRaceDay(db, p, correlationId);
  });
  const dayId = save();

  // A replaced/superseded day documents itself in the trace: the old id and
  // correlation id stay resolvable even though the row is gone, so log
  // events referencing them read as "that day was superseded by this one".
  for (const oldRow of oldRows) {
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
           COUNT(e.id) AS entries
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
ingestRouter.delete('/race-days/:id', (req, res) => {
  const db = getDb();
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(req.params.id);
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) return res.status(409).json({ error: 'Already deleted.' });

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
  if (changes !== 1) {
    log.error('race_day_delete_failed', { raceDayId: day.id, changes });
    return res.status(500).json({ error: 'Delete did not persist; nothing was logged as deleted.' });
  }

  const event = {
    correlationId: day.correlation_id,
    raceDayId: day.id,
    track: day.track,
    date: day.date,
    ...counts,
  };
  traceLog.info('race_day_deleted', event);
  log.info('race_day_deleted', event);
  res.json({ ok: true, ...counts });
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
