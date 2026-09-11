// Static payload builder (D150, redesigned to v4 by D329).
//
//   npm run build-static-payload -- <raceDayId> [<raceDayId> ...] [--out <path>]
//   npm run build-static-payload -- --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--track "Del Mar"] [--out <path>]
//
// Emits ONE self-contained JSON file bundling one or more race days - their
// entries AND every card on them, including grades - for the GitHub Pages
// read-only viewer (D236) to load in a browser. Default destination is
// static/public/payload.json, the file the Pages deploy publishes.
//
// The payload carries PARSED DATA ONLY. No Equibase HTML, no chart text, no
// parser input of any kind reaches the browser: parsing is a home-side job
// and the browser receives structured rows it can render.
//
// It is also deliberately a READ. It opens the database, selects, and writes
// one file; it never inserts, updates or deletes. A payload build is not an
// event in a card's history and does not appear in any trace.
//
// STILL A MANUAL, DELIBERATE CLI COMMAND - no scheduling of any kind, ever
// (invariant 6/D197's rule, unaffected by this redesign). `--from`/`--to` is
// a convenience over raw ids (opaque autoincrement values with no meaning to
// the person running the command), not a standing job: someone still runs
// this once, on purpose, to publish a chosen set of days.
//
// EVERY CARD ON A REQUESTED DAY IS INCLUDED, unconditionally - HUMAN, LLM and
// EQUIBASE-OTR alike, with grades where they exist. There is no more
// "reference cards" concept: nothing is built in the browser any more (D236),
// so there is no "peeked at a reference card while building" contamination
// left to guard against, and the whole point of this app now is to show the
// cards that exist.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { openDb } from '../server/db.js';
import { getCardCore, getDayRaces, getDayFooter } from '../server/cards.js';
import { getCardGrades } from '../server/grading.js';
import { readNotes } from '../server/llm-notes.js';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { KNOWN_MODELS } from '../server/anthropic-client.js';
import { canonicalPayloadText, STATIC_PAYLOAD_SCHEMA, STATIC_PAYLOAD_SCHEMA_VERSION, validateStaticPayload } from '../shared/static-payload.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_OUT = path.join(ROOT, 'static', 'public', 'payload.json');

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
function resolveDayIds(db, { dayIds, from, to, track }) {
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

function parseArgs(argv) {
  const out = { dayIds: [], from: null, to: null, track: null, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') { out.from = argv[++i]; continue; }
    if (a === '--to') { out.to = argv[++i]; continue; }
    if (a === '--track') { out.track = argv[++i]; continue; }
    if (a === '--out') { out.out = argv[++i]; continue; }
    if (a.startsWith('--out=')) { out.out = a.slice('--out='.length); continue; }
    if (/^\d+$/.test(a)) { out.dayIds.push(Number(a)); continue; }
    return { error: `Unrecognized argument: ${a}` };
  }
  if (out.dayIds.length && (out.from || out.to || out.track)) {
    return { error: 'Pass either explicit race-day ids or --from/--to (with an optional --track), not both.' };
  }
  if (!out.dayIds.length) {
    if (!out.from || !out.to) return { error: 'Either one or more race-day ids, or both --from and --to, are required.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.from) || !/^\d{4}-\d{2}-\d{2}$/.test(out.to)) {
      return { error: '--from/--to must be YYYY-MM-DD.' };
    }
  }
  if (!out.out) return { error: '--out needs a path.' };
  return out;
}

const USAGE = [
  'Usage: npm run build-static-payload -- <raceDayId> [<raceDayId> ...] [--out <path>]',
  '       npm run build-static-payload -- --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--track "Del Mar"] [--out <path>]',
].join('\n');

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(1);
  }

  const db = openDb();
  const { payload, error } = buildStaticPayload(db, args);
  if (error) {
    console.error(error);
    process.exit(1);
  }

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`${payload.raceDays.length} race day(s):`);
  for (const day of payload.raceDays) {
    const entries = day.races.reduce((a, r) => a + r.entries.length, 0);
    const scratched = day.races.reduce((a, r) => a + r.entries.filter((e) => e.scratched).length, 0);
    const graded = day.cards.filter((c) => c.grades.summary).length;
    console.log(`  ${day.raceDay.track} ${day.raceDay.date} (race day ${day.raceDay.raceDayId})`);
    console.log(`    ${day.races.length} race(s), ${entries} entr${entries === 1 ? 'y' : 'ies'}${scratched ? `, ${scratched} scratched` : ''}`);
    console.log(`    ${day.cards.length} card(s)${day.cards.length ? `, ${graded} graded` : ''}`);
    console.log(`    ${day.payloadHash}`);
  }
  console.log(`\nWrote ${path.relative(ROOT, outPath) || outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-static-payload.js')) {
  main();
}
