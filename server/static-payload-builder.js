// Static payload build logic (D150, redesigned to v4 by D329), extracted
// from scripts/build-static-payload.js so a live HTTP route (D336) and the
// CLI can call the exact same functions rather than one hand-rolling a
// second copy - the same "never a second copy of the shape" discipline
// D329 already applied one layer down (getCardCore/getDayRaces/getDayFooter
// in server/cards.js, getCardGrades in server/grading.js).
//
// This file lives in server/, not scripts/, on purpose: server/ never
// imports from scripts/ anywhere in this codebase, and scripts/ already
// imports from server/ (this file's own imports below are the same shape
// scripts/build-static-payload.js used before this extraction) - so keeping
// the build logic here keeps that dependency direction one-way instead of
// creating a cycle the moment a route needed it too.
//
// Still a READ against the database - it selects, computes and returns; it
// never inserts, updates or deletes, and a build is not an event in any
// card's history and does not appear in any trace.

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { getCardCore, getDayRaces, getDayFooter } from './cards.js';
import { getCardGrades } from './grading.js';
import { readNotes } from './llm-notes.js';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { KNOWN_MODELS } from './anthropic-client.js';
import { canonicalPayloadText, STATIC_PAYLOAD_SCHEMA, STATIC_PAYLOAD_SCHEMA_VERSION, validateStaticPayload } from '../shared/static-payload.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// `BETSHEET_STATIC_PAYLOAD_OUT` overrides the destination, the same
// "override the default rather than trust it" convention BETSHEET_DB and
// BETSHEET_LOG_DIR already use - it exists so a check script can exercise
// the PUBLISH ROUTE (server/static-payload-route.js) without overwriting the
// real committed static/public/payload.json. The CLI's own `--out` flag
// already covers the same need for a terminal invocation; the route accepts
// no client-supplied path at all (a browser choosing an arbitrary file path
// to write on this machine is not a request parameter this app will ever
// take), so this env var is the only way to redirect what the route writes.
export const DEFAULT_OUT = process.env.BETSHEET_STATIC_PAYLOAD_OUT
  ? path.resolve(process.env.BETSHEET_STATIC_PAYLOAD_OUT)
  : path.join(ROOT, 'static', 'public', 'payload.json');

/** sha256 of a day's canonical text, in the "sha256:<hex>" form the rest of the codebase uses. */
export function payloadHashOf(day) {
  return `sha256:${crypto.createHash('sha256').update(canonicalPayloadText(day), 'utf8').digest('hex')}`;
}

/**
 * Display label for an LLM model id, resolved at BUILD TIME (Node, home
 * side) from the same `KNOWN_MODELS` list `server/anthropic-client.js`
 * already maintains - never a second copy of the mapping. The browser gets
 * the resolved string; it must never import anthropic-client.js itself
 * (check-static-app.js forbids the Anthropic client from the bundle).
 */
function modelLabel(id) {
  if (!id) return null;
  return KNOWN_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Every non-deleted card on a day, in the exact shape CardSheet.jsx already reads (snake_case, D237). */
function loadCards(db, dayId) {
  const rows = db.prepare('SELECT id FROM cards WHERE race_day_id = ? ORDER BY card_number').all(dayId);
  return rows.map(({ id }) => {
    const card = getCardCore(db, id);
    const graded = getCardGrades(db, id);
    return {
      id: card.id,
      card_number: card.card_number,
      name: card.name,
      variant: card.variant,
      template: card.template,
      llm_model: card.llm_model,
      llm_model_label: modelLabel(card.llm_model),
      notes_present: card.notes_present,
      consensus_completeness: card.consensus_completeness,
      engine_version: card.engine_version,
      bankroll_cents: card.bankroll_cents,
      per_race_min_cents: card.per_race_min_cents,
      created_at: card.created_at,
      allocations: card.allocations,
      tickets: card.tickets,
      grades: { rows: graded.grades, summary: graded.summary },
    };
  });
}

/**
 * Build the bundle entry for one race day. Returns `{day}` or `{error}` -
 * never throws for an ordinary "no such day" case, so a caller can report
 * rather than stack-trace.
 */
export function buildStaticDay(db, raceDayId) {
  const rd = db.prepare('SELECT * FROM race_days WHERE id = ?').get(raceDayId);
  if (!rd) return { error: `No race day ${raceDayId}.` };
  // Invariant 12: a soft-deleted day is excluded everywhere by default, and
  // publishing one would be the loudest possible violation.
  if (rd.deleted_at) return { error: `Race day ${raceDayId} is deleted (${rd.track} ${rd.date}). Restore it first.` };

  const races = getDayRaces(db, rd.id);
  if (!races.length) return { error: `Race day ${raceDayId} (${rd.track} ${rd.date}) has no races.` };

  const day = {
    raceDay: {
      raceDayId: rd.id,
      track: rd.track,
      trackCode: rd.track_code,
      date: rd.date,
      meet: rd.meet,
      bankrollCents: rd.bankroll_cents,
      perRaceMinCents: rd.per_race_min_cents,
      oddsCapturedAt: rd.odds_captured_at,
      // Precomputed here, at build time, so the browser's calendar never
      // needs the track registry itself - only shared/race-calendar.js's
      // pure hour-placement math against this one string.
      timezone: canonicalizeTrack(rd.track).timezone,
    },
    races: races.map((r) => ({
      number: r.number,
      postTime: r.post_time,
      distance: r.distance,
      surface: r.surface,
      raceType: r.race_type,
      conditions: r.conditions,
      bottomLine: r.bottom_line,
      // LOAD-BEARING, not decoration: a null wager menu silently falls back
      // to Del Mar's minimums (CLAUDE.md, Gotchas). Ship whatever the day
      // actually has.
      wagerMenu: r.wager_menu,
      entries: r.entries.map((e) => ({
        // snake_case: the DB's own shape, which CardSheet.jsx and
        // EntriesTable.jsx already read directly.
        program_number: e.program_number,
        horse_name: e.horse_name,
        post_position: e.post_position,
        jockey: e.jockey,
        trainer: e.trainer,
        morning_line: e.morning_line,
        morning_line_decimal: e.morning_line_decimal,
        scratched: Boolean(e.scratched),
        also_eligible: Boolean(e.also_eligible),
      })),
    })),
  };

  const { sources, scratches, results } = getDayFooter(db, rd.id);
  day.sources = sources;
  day.scratches = scratches;
  day.results = results;
  const { byRace } = readNotes(db, rd.id);
  day.notesByRace = byRace;
  day.cards = loadCards(db, rd.id);

  // Hash last, over the race-day-and-races region only - see
  // shared/static-payload.js for what is excluded and why.
  day.payloadHash = payloadHashOf(day);

  return { day };
}

/** Resolve which race-day ids a build call covers: explicit ids, or a date range. */
export function resolveDayIds(db, { dayIds, from, to, track }) {
  if (dayIds && dayIds.length) return dayIds;
  let sql = 'SELECT id FROM race_days WHERE deleted_at IS NULL AND date >= ? AND date <= ?';
  const params = [from, to];
  if (track) { sql += ' AND track = ?'; params.push(track); }
  sql += ' ORDER BY date, track';
  return db.prepare(sql).all(...params).map((r) => r.id);
}

/** Build the full bundle. Returns `{payload}` or `{error}`. */
export function buildStaticPayload(db, resolveArgs) {
  const dayIds = resolveDayIds(db, resolveArgs);
  if (!dayIds.length) return { error: 'No race days matched the given ids/range.' };

  const raceDays = [];
  for (const id of dayIds) {
    const { day, error } = buildStaticDay(db, id);
    if (error) return { error };
    raceDays.push(day);
  }

  const payload = {
    schema: STATIC_PAYLOAD_SCHEMA,
    schemaVersion: STATIC_PAYLOAD_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    raceDays,
  };

  const problems = validateStaticPayload(payload);
  if (problems.length) {
    return { error: `Payload failed validation:\n  - ${problems.join('\n  - ')}` };
  }
  return { payload };
}

/** One-line-per-day summary, the shape both the CLI's console output and the UI's result panel render. */
export function summarizePayload(payload) {
  return payload.raceDays.map((day) => {
    const entries = day.races.reduce((a, r) => a + r.entries.length, 0);
    const scratched = day.races.reduce((a, r) => a + r.entries.filter((e) => e.scratched).length, 0);
    const graded = day.cards.filter((c) => c.grades.summary).length;
    return {
      raceDayId: day.raceDay.raceDayId,
      track: day.raceDay.track,
      date: day.raceDay.date,
      races: day.races.length,
      entries,
      scratched,
      cards: day.cards.length,
      graded,
      payloadHash: day.payloadHash,
    };
  });
}
