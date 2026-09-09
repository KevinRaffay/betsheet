// TIPSHEET picks (D166): the shape a screenshot of a third-party handicapping
// app extracts to, and the normalization/validation that shape must survive.
//
// PURE and browser-safe - no `node:` import, ever. It is imported by
// server/tip-picks.js today and is the module the manual entry dialog (D176)
// would validate with, so the browser and the server can never disagree about
// what a well-formed pick list is.
//
// Nothing here calls a model, reads a file or touches a database. Extraction
// is I/O; this is the contract that I/O has to meet.

import { morningLineToDecimal } from './betmath.js';
import { normalizeSourceLabel as normalizeAny, TIP_SOURCE_FALLBACK } from './source-labels.js';

// The source-label vocabulary and normalizer moved to shared/source-labels.js
// (D167), which is now the ONE place this codebase answers "who said this".
// Re-exported here so every D166 import keeps working unchanged, and so a
// reader of this file still sees what a tip source is - but there is exactly
// one implementation, and `tip_picks` and `llm_notes` cannot drift apart in
// the SHAPE of a label the way they had after D166.
export { TIP_SOURCE_LABELS, TIP_SOURCE_FALLBACK } from './source-labels.js';

/** A tip sheet's own source, falling back to "publisher unreadable". */
export const normalizeSourceLabel = (raw) =>
  normalizeAny(raw, TIP_SOURCE_FALLBACK);

/**
 * Odds as printed on a tip sheet -> the fraction string `morningLineToDecimal`
 * accepts, or null when there is nothing trustworthy to convert.
 *
 * The conversion that actually matters is the HYPHEN. Tote boards and most tip
 * apps print `4-5` and `9-2`; morningLineToDecimal's regex only admits `4/5`
 * and a bare number, so a hyphenated price passed straight through would read
 * back as `null` - odds captured, silently unusable. `EVEN` is the other real
 * one: it is a price (1/1), not a word to drop.
 *
 * NEVER invents a value. Anything that does not round-trip through
 * morningLineToDecimal comes back null, and a null here means "the sheet did
 * not show a usable price", never "assume the favorite".
 */
export function normalizeOdds(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().toUpperCase();
  if (!s || s === '-' || s === '--' || s === 'N/A' || s === 'SCR') return null;
  if (s === 'EVEN' || s === 'EVENS' || s === 'EVS' || s === 'E') return '1/1';
  s = s.replace(/\s*TO\s*/g, '/');   // "4 to 5"
  s = s.replace(/-/g, '/');          // "9-2" -> "9/2", the common tote form
  s = s.replace(/\s+/g, '');
  // `8/1` is deliberately NOT reduced to `8`, even though morningLineToDecimal
  // reads both as 8. The entries this bucket will be compared against store
  // the explicit denominator (`8/1`, `12/1`, `4/5` in the real corpus), and a
  // tipsheet price that renders differently from the morning line beside it
  // would read as a different kind of number when it is the same kind.
  return morningLineToDecimal(s) === null ? null : s;
}

/** Program numbers are TEXT throughout this schema ("1A"), never integers. */
const normalizeHorseNo = (raw) => String(raw ?? '').trim().toUpperCase();

/**
 * Validate and normalize an extracted pick list.
 *
 * Returns `{ picks, warnings }` and NEVER THROWS - the same contract every
 * parser in this codebase honours, and each warning carries its own `blocking`
 * boolean the way shared/parsers/human-picks.js does, so a caller decides what
 * refuses a save rather than this module deciding for it.
 *
 * The blocking/non-blocking split is the whole judgement here:
 *   BLOCKING   - the ranking itself is unusable: no picks, a missing or
 *                non-positive rank, a duplicated rank, the same horse twice.
 *                Rank IS the signal in this bucket, so a broken ranking is a
 *                broken extraction.
 *   NON-BLOCKING - anything about odds, and a gap in the rank sequence. A
 *                sheet that prints 1st/2nd/3rd and no prices is an ORDINARY
 *                tipsheet, not a failure, and a model that could not read a
 *                price correctly must drop it rather than guess it.
 */
export function validateTipPicks(rawPicks) {
  const warnings = [];
  const warn = (code, message, blocking) => warnings.push({ code, message, blocking });

  if (!Array.isArray(rawPicks) || rawPicks.length === 0) {
    warn('no_picks', 'No picks were extracted from the image.', true);
    return { picks: [], warnings };
  }

  const picks = [];
  const seenRank = new Map();
  const seenHorse = new Map();

  for (const [i, raw] of rawPicks.entries()) {
    const where = `pick ${i + 1}`;
    const horseNo = normalizeHorseNo(raw?.horse_no ?? raw?.horseNo);
    const horseName = String(raw?.horse_name ?? raw?.horseName ?? '').trim();
    const rank = Number(raw?.rank);

    if (!horseNo) warn('no_program_number', `${where}: no program number.`, true);
    if (!horseName) warn('no_horse_name', `${where}: no horse name.`, false);
    if (!Number.isInteger(rank) || rank < 1) {
      warn('bad_rank', `${where}: rank must be a whole number of 1 or more, got ${JSON.stringify(raw?.rank)}.`, true);
      continue;
    }
    if (seenRank.has(rank)) {
      warn('duplicate_rank', `${where}: rank ${rank} is already used by ${seenRank.get(rank)}.`, true);
    } else seenRank.set(rank, horseNo || horseName || where);
    if (horseNo && seenHorse.has(horseNo)) {
      warn('duplicate_horse', `${where}: #${horseNo} is picked twice (ranks ${seenHorse.get(horseNo)} and ${rank}).`, true);
    } else if (horseNo) seenHorse.set(horseNo, rank);

    const pick = { horse_no: horseNo, horse_name: horseName, rank };
    // Odds are OMITTED, never null-filled, when absent or unreadable - the
    // shape a consumer checks with `'ml_odds' in pick`, so "not shown" and
    // "shown but unreadable" are both honestly absent rather than a zero.
    for (const [key, src] of [['ml_odds', raw?.ml_odds ?? raw?.mlOdds], ['live_odds', raw?.live_odds ?? raw?.liveOdds]]) {
      if (src === null || src === undefined || String(src).trim() === '') continue;
      const odds = normalizeOdds(src);
      if (odds === null) warn('unreadable_odds', `${where}: ${key} ${JSON.stringify(src)} is not a price this app can read; dropped.`, false);
      else pick[key] = odds;
    }
    picks.push(pick);
  }

  picks.sort((a, b) => a.rank - b.rank);
  const ranks = picks.map((p) => p.rank);
  if (ranks.length && ranks[0] !== 1) warn('rank_not_from_one', `Ranking starts at ${ranks[0]}, not 1.`, false);
  for (let i = 1; i < ranks.length; i += 1) {
    if (ranks[i] !== ranks[i - 1] + 1) {
      warn('rank_gap', `Ranking jumps from ${ranks[i - 1]} to ${ranks[i]}.`, false);
      break;
    }
  }
  return { picks, warnings };
}

/** Convenience for the callers that only need "may this be saved?". */
export const hasBlocking = (warnings) => warnings.some((w) => w.blocking);
