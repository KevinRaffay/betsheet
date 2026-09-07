// Analyst notes for the LLM card generator (D92): the mutable DRAFT store, and
// the composition that turns a draft into the immutable snapshot recorded on
// each llm_card_requests row.
//
// Notes are keyed by (race_day_id, race_number), NOT by card_id. They are a
// property of a RACE: the same commentary should feed a Sonnet card and an Opus
// card, which is the comparison cards.llm_model (D76) exists to enable. A
// card_id key would also be unusable for the first preview of a brand-new card,
// which necessarily precedes that card's existence (D63, invariant 9).
// race_number 0 is the day-level note, prepended to every race's prompt.
//
// llm_notes is the only mutable table in the LLM subsystem, deliberately: it is
// a scratchpad. The immutable record is the per-call snapshot. That split is
// invariant 15's shape - record the facts, let the working surface move.

import crypto from 'node:crypto';
import { NOTES_MAX_CHARS, sanitizeNotesForPrompt } from './llm-prompt.js';

export const NOTES_SOURCE_FALLBACK = 'user';
const CARD_SCOPE_RACE_NUMBER = 0;
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** Every note on a day: the card-level one plus a map keyed by race number. */
export function readNotes(db, raceDayId) {
  const rows = db.prepare('SELECT * FROM llm_notes WHERE race_day_id = ? ORDER BY race_number').all(raceDayId);
  const shape = (r) => ({ text: r.notes_text, sourceLabel: r.source_label, updatedAt: r.updated_at, createdAt: r.created_at });
  const byRace = {};
  let cardNote = null;
  for (const r of rows) {
    if (r.race_number === CARD_SCOPE_RACE_NUMBER) cardNote = shape(r);
    else byRace[r.race_number] = shape(r);
  }
  return { cardNote, byRace };
}

/**
 * Upsert one note. Empty/whitespace text DELETES the row, so "clear this note"
 * is expressible without a second verb. `created_at` survives an update.
 */
export function writeNote(db, raceDayId, raceNumber, text, sourceLabel) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    db.prepare('DELETE FROM llm_notes WHERE race_day_id = ? AND race_number = ?').run(raceDayId, raceNumber);
    return null;
  }
  const ts = now();
  db.prepare(`
    INSERT INTO llm_notes (race_day_id, race_number, notes_text, source_label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(race_day_id, race_number) DO UPDATE SET
      notes_text = excluded.notes_text,
      source_label = excluded.source_label,
      updated_at = excluded.updated_at
  `).run(raceDayId, raceNumber, String(text), sourceLabel || null, ts, ts);
  return db.prepare('SELECT * FROM llm_notes WHERE race_day_id = ? AND race_number = ?').get(raceDayId, raceNumber);
}

/**
 * Compose one race's notes for a generate call: the sanitized, truncated blocks
 * the model will actually see, plus the snapshot the request row records.
 *
 * The hash and char count are over the COMPOSED MODEL-FACING payload, not the
 * raw text: notes_*_text answers "what did the human write", the hash answers
 * "what did the model see". Different questions, both worth recording.
 *
 * notesEnteredAt is the DRAFT's own updated_at - when the human wrote it, not
 * when the call happened (requested_at already records that). It is the only
 * column a future blindness derivation could be built from.
 */
export function loadNotesForRace(db, raceDayId, raceNumber) {
  const { cardNote, byRace } = readNotes(db, raceDayId);
  const raceNote = byRace[raceNumber] ?? null;
  const present = Boolean(cardNote?.text || raceNote?.text);

  if (!present) {
    return { present: false, prompt: null, truncated: [], sourceLabel: null, snapshot: null };
  }

  // One resolved label per call: the race's own, else the day's, else a default.
  const sourceLabel = raceNote?.sourceLabel || cardNote?.sourceLabel || NOTES_SOURCE_FALLBACK;
  const truncated = [];
  const compose = (note, scope) => {
    if (!note?.text) return null;
    const out = sanitizeNotesForPrompt(note.text, scope);
    if (out.truncated) truncated.push({ scope, cap: NOTES_MAX_CHARS[scope], omitted: out.omitted });
    return { text: out.text, sourceLabel };
  };
  const card = compose(cardNote, 'card');
  const race = compose(raceNote, 'race');

  const composed = [card?.text, race?.text].filter(Boolean).join('\n\n');
  // The draft timestamps a blindness derivation would key on: the LATEST of the
  // two, since either could have been written after the other.
  const enteredAt = [cardNote?.updatedAt, raceNote?.updatedAt].filter(Boolean).sort().pop() ?? null;
  const hasResults = db.prepare('SELECT 1 FROM race_results WHERE race_day_id = ? LIMIT 1').get(raceDayId) ? 1 : 0;

  return {
    present: true,
    prompt: { card, race },
    truncated,
    sourceLabel,
    // D149: the same composed/sanitized/truncated string notes_hash and
    // notes_char_count below are computed over - what the model actually
    // saw, as opposed to notes_race_text/notes_card_text's raw human input.
    // Exposed here rather than recomputed at the call site so there is
    // exactly one join expression for "what did the model see" in the codebase.
    composed,
    snapshot: {
      notes_present: 1,
      notes_race_text: raceNote?.text ?? null,
      notes_card_text: cardNote?.text ?? null,
      notes_source_label: sourceLabel,
      notes_hash: crypto.createHash('sha256').update(composed).digest('hex'),
      notes_char_count: composed.length,
      notes_entered_at: enteredAt,
      notes_post_result: hasResults,
    },
  };
}
