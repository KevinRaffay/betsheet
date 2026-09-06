// Bulk entries ingest: one zip of saved Equibase entries pages -> every race
// day it contains.
//
// The single-file path (D116) is unchanged and remains the way to create one
// race day. This is the same thing done N times, for the case the single path
// is bad at: a full board on race day is 8-23 tracks, and uploading that one
// file at a time is 23 previews and 23 saves.
//
// WHY THE SERVER UNZIPS, when D116 deliberately reads the file in the browser:
// a day's raw HTML is 15-17 MB against `express.json`'s 10 mb limit, while the
// zip that contains it is ~2 MB. The compressed form is the only one that fits
// in one request. The property that mattered about the client-side read is
// kept - the server still never sees a path and never opens a file; it
// decompresses a buffer that arrived in the request body.
//
// Two routes, and the split is invariant 9's: preview writes NOTHING, and the
// save re-reads the zip from its own request body rather than trusting a
// client-shaped payload of parsed races - the same rule D54, D69 and D71
// follow. The client posts the same ~2 MB twice, which is cheaper than
// inventing a server-side staging area for it.

import express from 'express';
import { parseEquibaseEntriesHtml } from '../shared/parsers/equibase-entries.js';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { getDb } from './db.js';
import { insertRaceDay } from './ingest.js';
import { getLogger, newCorrelationId } from './logging.js';
import { readZip, ZipError } from './zip-read.js';

const log = getLogger('app');
const traceLog = getLogger('decision-trace');

export const entriesZipRouter = express.Router();

const isHtml = (name) => /\.html?$/i.test(name) && !name.split('/').pop().startsWith('.');

/**
 * Parse every HTML entry in the archive and work out what saving it would do.
 * Pure with respect to the database except for the existence lookup, which is
 * a read - this is what both routes agree on, so the preview cannot promise
 * one thing and the save do another.
 */
function planArchive(db, zipBuffer) {
  const files = readZip(zipBuffer, { filter: isHtml });
  if (files.length === 0) {
    throw new ZipError('No .html files in this archive. A day\'s entries zip holds one saved '
      + 'Equibase entries page per track.');
  }

  return files.map((file) => {
    const parsed = parseEquibaseEntriesHtml(file.bytes.toString('utf8'));
    const blocking = parsed.warnings.filter((w) => w.blocking);
    const entries = parsed.races.reduce((a, r) => a + r.entries.length, 0);
    const row = {
      file: file.name,
      track: parsed.track,
      date: parsed.date,
      races: parsed.races.length,
      entries,
      warnings: parsed.warnings.map((w) => ({ type: w.type, race: w.race ?? null, blocking: w.blocking, message: w.message })),
      // Each day keeps its OWN capture time, from its own zip entry, rather
      // than one timestamp for the whole upload - D117's staleness indicator
      // reads exactly this field, and the pages in one archive are not
      // necessarily saved at the same moment.
      oddsCapturedAt: file.modifiedAt ? file.modifiedAt.toISOString().replace(/\.\d+Z$/, 'Z') : null,
      existingId: null,
      existingWasDeleted: false,
      disposition: null,
      // Kept for the save, never sent to the client: the preview is a summary,
      // and shipping 23 parsed cards back would be megabytes for nothing.
      _parsed: parsed,
    };

    if (blocking.length) {
      // Policy A (D43): anything blocking is left alone and reported, never
      // half-saved. The named ones are the two "you saved the wrong page"
      // cases, which deserve to read as that rather than as a parse failure.
      row.disposition = blocking.some((w) => w.type === 'index_page_not_entries')
        ? 'skip_not_entries_page'
        : 'skip_blocking_warnings';
      return row;
    }
    if (!parsed.track || !parsed.date) {
      row.disposition = 'skip_no_track_or_date';
      return row;
    }

    const existing = db.prepare('SELECT id, deleted_at FROM race_days WHERE track_code = ? AND date = ?')
      .get(canonicalizeTrack(parsed.track).code, parsed.date);
    if (existing) {
      row.existingId = existing.id;
      row.existingWasDeleted = Boolean(existing.deleted_at);
      row.disposition = 'replace';
    } else {
      row.disposition = 'create';
    }
    return row;
  });
}

const publicRow = ({ _parsed, ...rest }) => rest;

/** Preview only. Writes nothing (invariant 9). */
entriesZipRouter.post(
  '/parse/equibase-entries-zip',
  express.raw({ type: ['application/zip', 'application/x-zip-compressed'], limit: '30mb' }),
  (req, res) => {
    const correlationId = req.get('x-correlation-id') || newCorrelationId();
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Send the zip as a raw application/zip body.' });
    }
    let rows;
    try {
      rows = planArchive(getDb(), req.body);
    } catch (err) {
      if (err instanceof ZipError) return res.status(400).json({ error: err.message });
      throw err;
    }
    const dates = [...new Set(rows.map((r) => r.date).filter(Boolean))].sort();
    log.info('parse_completed', {
      correlationId,
      kind: 'equibase_entries_zip',
      bytes: req.body.length,
      files: rows.length,
      days: rows.filter((r) => r.disposition === 'create' || r.disposition === 'replace').length,
      skipped: rows.filter((r) => String(r.disposition).startsWith('skip')).length,
    });
    res.json({
      correlationId,
      files: rows.map(publicRow),
      dates,
      // Nothing breaks when an archive spans dates - the 91-file capture held
      // seven - but "a day's entries" is the intended shape, so say when it is
      // not that rather than silently ingesting a week.
      spansMultipleDates: dates.length > 1,
    });
  },
);

/**
 * Save. Re-reads and re-parses the archive from THIS request's body - it never
 * takes a client's word for what the zip contained.
 *
 * `replace` (default false) decides what happens to a day that already exists.
 * Re-ingesting a day replaces it outright, and its cards go with it (user
 * decision 2026-09-06: that is the intended behaviour, entries are the record
 * and a card built on stale entries is not worth keeping). So it is opt-in
 * per upload rather than assumed.
 */
entriesZipRouter.post(
  '/race-days/from-zip',
  express.raw({ type: ['application/zip', 'application/x-zip-compressed'], limit: '30mb' }),
  (req, res) => {
    const correlationId = req.get('x-correlation-id') || newCorrelationId();
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Send the zip as a raw application/zip body.' });
    }
    const replace = req.query.replace === '1';
    const bankrollCents = Number.isFinite(Number(req.query.bankrollCents)) ? Number(req.query.bankrollCents) : 20000;
    const perRaceMinCents = Number.isFinite(Number(req.query.perRaceMinCents)) ? Number(req.query.perRaceMinCents) : 500;

    const db = getDb();
    let rows;
    try {
      rows = planArchive(db, req.body);
    } catch (err) {
      if (err instanceof ZipError) return res.status(400).json({ error: err.message });
      throw err;
    }

    const saved = [];
    const skipped = [];
    for (const row of rows) {
      const out = publicRow(row);
      if (String(row.disposition).startsWith('skip')) { skipped.push(out); continue; }
      if (row.disposition === 'replace' && !replace) {
        skipped.push({ ...out, disposition: 'skip_exists' });
        continue;
      }
      // One transaction PER DAY, deliberately: a single bad file in a
      // 23-track archive must not roll back the 22 that were fine, and a day
      // is the unit a person thinks in.
      try {
        const dayId = db.transaction(() => {
          if (row.existingId) db.prepare('DELETE FROM race_days WHERE id = ?').run(row.existingId);
          return insertRaceDay(db, {
            track: row.track,
            date: row.date,
            bankrollCents,
            perRaceMinCents,
            entriesSource: 'equibase_html',
            oddsCapturedAt: row.oddsCapturedAt,
            races: row._parsed.races,
          }, correlationId);
        })();
        if (row.existingId) {
          traceLog.info('race_day_superseded', {
            correlationId,
            raceDayId: dayId,
            supersededRaceDayId: row.existingId,
            supersededWasDeleted: row.existingWasDeleted,
            track: row.track,
            date: row.date,
          });
        }
        saved.push({ ...out, id: dayId });
      } catch (err) {
        skipped.push({ ...out, disposition: 'skip_save_failed', error: String(err?.message ?? err) });
      }
    }

    log.info('race_days_saved_from_zip', {
      correlationId,
      bytes: req.body.length,
      files: rows.length,
      saved: saved.length,
      skipped: skipped.length,
      replace,
    });
    res.status(201).json({ correlationId, saved, skipped });
  },
);
