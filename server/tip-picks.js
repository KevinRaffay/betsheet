// TIPSHEET picks: the HTTP surface and the human-correction path (D169).
//
// D166 built extraction and a writer but no routes at all. This adds them,
// plus the one thing D166 explicitly deferred: a way to review what the model
// read and correct it when it read wrong.
//
// INVARIANT 9 IS INTACT, NOT EXCEPTED. The invariant governs the parse -> save
// path: a preview writes nothing and is READ-ONLY, and `confirm` never trusts
// the client's picks - it re-reads the ARCHIVED model response and re-parses
// it server-side, exactly as server/equibase-otr.js re-reads archived PDF
// bytes. What it cannot do is re-run the extraction, because that is a paid,
// non-deterministic call: so the archived artifact here is the model's OWN
// RESPONSE, and re-parsing it is the deterministic step confirm repeats.
//
// Correcting is a SEPARATE, later, recorded act on a stored row (migration
// 029), never an edit of the preview - which is what keeps the invariant
// literally true rather than carved out. See that migration for the reasoning.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath, URL } from 'node:url';
import { getDb } from './db.js';
import { validateTipPicks, hasBlocking } from '../shared/tip-picks.js';
import { normalizeSourceLabel } from '../shared/source-labels.js';
import {
  extractTipPicks, insertTipPicks, tipPicksForDay, parseExtractionJson, detectMediaType,
} from './tip-extraction.js';
import { getLogger, newCorrelationId } from './logging.js';

const traceLog = getLogger('decision-trace');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const now = () => new Date().toISOString();

export const tipPicksRouter = express.Router();

class TipPicksError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

const archiveDir = () => process.env.BETSHEET_TIP_ARCHIVE_DIR
  || path.join(ROOT, 'data', 'archive', 'tip-picks');

/**
 * Archive one extraction: the image bytes AND the model's response, keyed by
 * the image's own sha256 so a re-upload of the same screenshot is idempotent.
 *
 * The `.json` sidecar is what `confirm` re-reads. Keeping the image too costs
 * little and is what makes a disputed row re-checkable months later against
 * the picture it came from - which the row's own `image_sha256` then matches.
 */
function archiveExtraction(hash, imageBytes, mediaType, payload) {
  const dir = archiveDir();
  fs.mkdirSync(dir, { recursive: true });
  const img = path.join(dir, `${hash}.${EXT[mediaType] ?? 'bin'}`);
  if (!fs.existsSync(img)) fs.writeFileSync(img, imageBytes);
  fs.writeFileSync(path.join(dir, `${hash}.json`), JSON.stringify(payload, null, 2));
  return img;
}

function readArchivedExtraction(hash) {
  const file = path.join(archiveDir(), `${hash}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
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

/** Decode a base64 image posted as JSON. The browser reads the file, not us. */
function decodeImage(body) {
  const raw = String(body?.imageBase64 ?? '').replace(/^data:[^;]+;base64,/, '');
  if (!raw) throw new TipPicksError(400, 'imageBase64 is required.');
  let buf;
  try { buf = Buffer.from(raw, 'base64'); } catch { throw new TipPicksError(400, 'imageBase64 is not valid base64.'); }
  if (!buf.length) throw new TipPicksError(400, 'The image is empty.');
  const mediaType = detectMediaType(buf);
  if (!mediaType) throw new TipPicksError(400, 'Unrecognized image format (expected PNG, JPEG, WebP or GIF).');
  return { buf, mediaType };
}

const shapeRow = (r) => ({
  id: r.id, raceNo: r.race_no, bucket: r.bucket, sourceLabel: r.source_label,
  picks: r.picks, picksExtracted: r.picks_extracted ? JSON.parse(r.picks_extracted) : null,
  edited: Boolean(r.edited_at), editedAt: r.edited_at, capturedAt: r.captured_at,
  model: r.model, imageSha256: r.image_sha256, createdAt: r.created_at,
});

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TipPicksError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
};

/**
 * PREVIEW. Calls the model, archives the image and the response, returns what
 * a save WOULD store - and PERSISTS NOTHING (invariant 9).
 */
tipPicksRouter.post('/race-days/:id/tip-picks/preview', wrap(async (req, res) => {
  const db = getDb();
  const day = loadDay(db, req.params.id);
  const raceNo = requireRace(db, day, req.body?.race);
  const { buf, mediaType } = decodeImage(req.body);
  const hash = sha256(buf);
  const correlationId = req.body?.correlationId || newCorrelationId();

  const result = await extractTipPicks({
    imageBuffer: buf, sourceHint: req.body?.sourceHint ?? '',
    ...(req.body?.model ? { model: req.body.model } : {}),
    // Check-script-only escape hatch, same shape as BETSHEET_LLM_TEST_MODE in
    // server/llm-cards.js: a canned response travels the exact preview/save
    // path a real call would, so the route contract is verifiable without a
    // paid vision call. Never set this outside a check script.
    stubResponse: process.env.BETSHEET_TIP_TEST_MODE === '1' ? req.body?.__stubResponse : undefined,
  });

  // Archived REGARDLESS of outcome - a failed read is exactly the case worth
  // being able to look at later (invariant 11's spirit).
  archiveExtraction(hash, buf, mediaType, {
    raceDayId: day.id, raceNo, hash, mediaType, model: result.model,
    sourceHint: req.body?.sourceHint ?? '', raw: result.raw, ok: result.ok,
    error: result.error ?? null, extractedAt: now(), correlationId,
  });
  traceLog.info('tip_extraction_attempted', {
    correlationId, raceDayId: day.id, raceNo, imageSha256: hash,
    model: result.model, ok: result.ok, error: result.error ?? null,
    pickCount: result.picks.length,
  });

  if (!result.ok) throw new TipPicksError(422, result.error);
  res.json({
    parseToken: hash, correlationId, raceNo, sourceLabel: result.sourceLabel,
    model: result.model, picks: result.picks, warnings: result.warnings,
    blocking: hasBlocking(result.warnings), imageSha256: hash,
    existing: shapeRowOrNull(db, day.id, raceNo, result.sourceLabel),
  });
}));

function shapeRowOrNull(db, dayId, raceNo, sourceLabel) {
  const row = db.prepare(
    'SELECT * FROM tip_picks WHERE race_day_id = ? AND race_no = ? AND source_label = ?',
  ).get(dayId, raceNo, normalizeSourceLabel(sourceLabel));
  return row ? { id: row.id, edited: Boolean(row.edited_at) } : null;
}

/**
 * SAVE. Re-reads the ARCHIVED response and re-parses it here - the client's
 * own picks are never trusted, the same discipline confirmEquibaseOtr applies
 * to archived PDF bytes.
 */
tipPicksRouter.post('/race-days/:id/tip-picks', wrap(async (req, res) => {
  const db = getDb();
  const day = loadDay(db, req.params.id);
  const raceNo = requireRace(db, day, req.body?.race);
  const parseToken = String(req.body?.parseToken ?? '');
  if (!parseToken) throw new TipPicksError(400, 'parseToken (from the preview) is required.');

  const archived = readArchivedExtraction(parseToken);
  if (!archived) throw new TipPicksError(404, 'No archived extraction for that parseToken - preview again before saving.');
  if (!archived.ok || !archived.raw) throw new TipPicksError(422, 'That extraction failed and cannot be saved.');

  const { data, error } = parseExtractionJson(archived.raw);
  if (error) throw new TipPicksError(422, error);
  const { picks, warnings } = validateTipPicks(data?.picks);
  if (hasBlocking(warnings)) {
    throw new TipPicksError(422, `The extraction has blocking warnings: ${
      warnings.filter((w) => w.blocking).map((w) => w.message).join('; ')}`);
  }
  const sourceLabel = normalizeSourceLabel(data?.source_label || archived.sourceHint);

  insertTipPicks(db, {
    raceDayId: day.id, raceNo, sourceLabel, picks,
    capturedAt: req.body?.capturedAt ?? null, rawExtraction: archived.raw,
    model: archived.model, imageSha256: parseToken,
  });
  const row = db.prepare(
    'SELECT * FROM tip_picks WHERE race_day_id = ? AND race_no = ? AND source_label = ?',
  ).get(day.id, raceNo, sourceLabel);
  traceLog.info('tip_picks_saved', {
    correlationId: archived.correlationId ?? null, raceDayId: day.id, raceNo,
    tipPicksId: row.id, sourceLabel, pickCount: picks.length, imageSha256: parseToken,
  });
  res.status(201).json({ saved: shapeRow({ ...row, picks }) });
}));

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
  const updated = db.prepare('SELECT * FROM tip_picks WHERE id = ?').get(row.id);
  res.json({ saved: shapeRow({ ...updated, picks: JSON.parse(updated.picks) }), warnings });
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
  res.json({ deleted: row.id });
}));
