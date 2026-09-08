// TIPSHEET screenshot extraction (D166).
//
// Takes an image of a third-party handicapping app's picks and returns the
// structured, validated pick list shared/tip-picks.js defines. Extraction
// only: this module calls a vision model, normalizes what comes back, and can
// write it to a `tip_picks` row. It builds no tickets, stakes no money and
// grades nothing - those are later deliverables, and nothing here reaches a
// card, a bankroll or the grader.
//
// Invariant 9 in spirit: `extractTipPicks` NEVER writes. Persisting is a
// separate, explicit `insertTipPicks` call, so a preview surface can show
// exactly what a save would store before anything is stored.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { complete, MODEL, DEFAULT_REQUEST_PARAMS } from './anthropic-client.js';
import {
  validateTipPicks, normalizeSourceLabel, TIP_SOURCE_LABELS, TIP_SOURCE_FALLBACK,
} from '../shared/tip-picks.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const now = () => new Date().toISOString();

/** Media type from the file's own magic bytes, never from its extension. */
export function detectMediaType(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length > 6 && buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  return null;
}

export const TIP_SYSTEM_PROMPT = `You read a screenshot of a horse racing handicapping app's tip picks and return ONLY JSON.

Return a single JSON object with exactly these keys:
{
  "source_label": "<the app that published these picks>",
  "picks": [
    { "horse_no": "<program number as printed>", "horse_name": "<horse name>", "rank": <1 for the top pick, 2 for the second, ...>, "ml_odds": "<morning line, optional>", "live_odds": "<current odds, optional>" }
  ]
}

Rules:
- Output JSON and nothing else. No prose, no explanation, no markdown code fences.
- rank is the SOURCE's own ordering: 1ST PICK / TOP PICK is rank 1, 2ND PICK is rank 2, and so on. If the app numbers or badges its picks, use those. If it only lists them top to bottom, use the printed order.
- horse_no is the program number exactly as printed, as a STRING ("1A" and "7" are both valid). It is the small boxed number beside the horse, not the rank.
- OMIT ml_odds and live_odds entirely when the screenshot does not show them. Most tip sheets show no odds at all - that is normal and is NOT an error. NEVER estimate, infer or invent a price. Only report a price you can actually read in the image.
- When odds ARE shown, copy them exactly as printed ("4-5", "9/2", "EVEN", "8/1").
- source_label: read it from the visible interface - a tab name, a header, a logo, or a badge on each pick. Preferred values: ${TIP_SOURCE_LABELS.join(', ')}. Use "${TIP_SOURCE_FALLBACK}" only when no source is identifiable in the image.
- Include every pick the screenshot shows, in rank order. Do not include horses that are not among the picks.`;

const userPromptFor = (sourceHint) => (sourceHint
  ? `Extract the tip picks from this screenshot. The user says these picks are from: ${sourceHint}. Prefer the source visible in the image if it disagrees.`
  : 'Extract the tip picks from this screenshot.');

/**
 * The model's text -> a JSON object.
 *
 * Tolerates a fenced block and surrounding prose even though the prompt
 * forbids both: a response that is 95% right is worth recovering, and the
 * unedited text is stored in `raw_extraction` either way, so recovery is
 * auditable rather than silent.
 */
export function parseExtractionJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return { data: null, error: 'The model returned an empty response.' };
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? body.slice(start, end + 1) : body;
  try {
    return { data: JSON.parse(candidate), error: null };
  } catch (err) {
    return { data: null, error: `The model's response was not JSON: ${err.message}` };
  }
}

/**
 * Read a screenshot, return the structured picks. NEVER writes.
 *
 * `stubResponse` bypasses the API entirely and is honoured ONLY under
 * BETSHEET_TIP_TEST_MODE=1 - the same escape hatch shape as
 * BETSHEET_LLM_TEST_MODE in server/llm-cards.js, and for the same reason: the
 * shape/parse/normalize/persist path has to be verifiable without a paid
 * vision call, while the real path stays the one the check script exercises
 * when an image and a key are actually present.
 *
 * Returns `{ ok, picks, warnings, sourceLabel, raw, model, imageSha256,
 * mediaType, error }`. An API failure comes back as `ok: false` with a reason
 * rather than throwing - a failed extraction is a normal outcome at a
 * racetrack with bad signal, and the caller decides whether to retry.
 */
export async function extractTipPicks({
  imagePath, imageBuffer, sourceHint = '', model = MODEL, stubResponse,
  maxTokens = DEFAULT_REQUEST_PARAMS.maxTokens, temperature = null,
} = {}) {
  const buf = imageBuffer ?? (imagePath ? fs.readFileSync(imagePath) : null);
  if (!buf || !buf.length) {
    return { ok: false, error: 'No image was provided.', picks: [], warnings: [], raw: null, model, imageSha256: null, mediaType: null, sourceLabel: null };
  }
  const mediaType = detectMediaType(buf);
  const imageSha256 = sha256(buf);
  const base = { model, imageSha256, mediaType, picks: [], warnings: [], raw: null, sourceLabel: null };
  if (!mediaType) {
    return { ...base, ok: false, error: 'Unrecognized image format (expected PNG, JPEG, WebP or GIF).' };
  }

  const useStub = process.env.BETSHEET_TIP_TEST_MODE === '1' && stubResponse !== undefined;
  let raw;
  if (useStub) {
    raw = String(stubResponse);
  } else {
    try {
      // temperature is OMITTED (null), not pinned to 0. Transcription would
      // rather be deterministic, but claude-sonnet-5 rejects a non-default
      // temperature outright (400, `temperature is deprecated for this model`)
      // - found by this deliverable's own check run against a real screenshot.
      // So determinism is not on offer here, and pretending otherwise by
      // sending 0 just fails the call.
      const res = await complete({
        system: TIP_SYSTEM_PROMPT,
        user: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
          { type: 'text', text: userPromptFor(sourceHint) },
        ],
        model, maxTokens, temperature,
      });
      raw = res.text;
    } catch (err) {
      return { ...base, ok: false, error: err.message };
    }
  }

  const { data, error } = parseExtractionJson(raw);
  if (error) return { ...base, ok: false, raw, error };

  const { picks, warnings } = validateTipPicks(data?.picks);
  // The image wins over the hint when it names a source, because the hint is a
  // guess typed by someone holding a phone and the chrome is evidence.
  const sourceLabel = normalizeSourceLabel(data?.source_label || sourceHint);
  return { ...base, ok: true, raw, picks, warnings, sourceLabel, error: null };
}

/**
 * Persist one extraction. Separate from `extractTipPicks` on purpose - a
 * preview surface calls the extractor alone and shows what a save WOULD store.
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

/** Read one day's tip picks back, JSON decoded. */
export function tipPicksForDay(db, raceDayId) {
  return db.prepare('SELECT * FROM tip_picks WHERE race_day_id = ? ORDER BY race_no, source_label')
    .all(raceDayId)
    .map((r) => ({ ...r, picks: JSON.parse(r.picks) }));
}
