// Static payload builder (D150).
//
//   npm run build-static-payload -- <raceDayId> [--out <path>] [--reference-cards]
//
// Emits ONE self-contained JSON file describing one race day, for the
// GitHub Pages ticket builder (D151) to load in a browser at the track.
// Default destination is static/public/payload.json - the file the Pages
// deploy publishes, so "build the payload" and "deploy the race day" are the
// same act (D154: publishing a new payload replaces the deployed race day).
//
// The payload carries PARSED DATA ONLY. No Equibase HTML, no chart text, no
// parser input of any kind reaches the browser: parsing is a home-side job
// and the phone receives structured rows it can render. shared/static-payload.js
// asserts this rather than leaving it to good intentions.
//
// It is also deliberately a READ. It opens the database, selects, and writes
// one file; it never inserts, updates or deletes. A payload build is not an
// event in a card's history and does not appear in any trace.
//
// --reference-cards embeds the day's OTR and LLM cards. OFF by default, and
// the static app keeps them behind an explicit reveal, because a HUMAN card
// built while reading the LLM card is not an independent source. Revealing
// stamps sawReferenceCards on the card being built (D152), which turns the
// contamination into labeled data instead of an unknown.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { openDb } from '../server/db.js';
import { canonicalPayloadText, STATIC_PAYLOAD_SCHEMA, STATIC_PAYLOAD_SCHEMA_VERSION, validateStaticPayload } from '../shared/static-payload.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_OUT = path.join(ROOT, 'static', 'public', 'payload.json');

/** sha256 of the canonical text, in the "sha256:<hex>" form the rest of the codebase uses. */
export function payloadHashOf(payload) {
  return `sha256:${crypto.createHash('sha256').update(canonicalPayloadText(payload), 'utf8').digest('hex')}`;
}

/**
 * Reference cards, when asked for: the day's OTR and LLM cards flattened to
 * what a phone can render. Human cards are deliberately EXCLUDED - a HUMAN
 * card is the thing being built, not a reference to peek at, and showing one
 * would make "did you see a reference card" ambiguous about which kind.
 */
function loadReferenceCards(db, dayId) {
  const cards = db.prepare(`
    SELECT c.id, c.card_number, c.name, c.llm_model, c.variant, c.bankroll_cents,
           st.name AS template
    FROM cards c
    LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
    WHERE c.race_day_id = ? AND st.name IN ('llm', 'equibase-otr')
    ORDER BY c.card_number
  `).all(dayId);

  return cards.map((c) => ({
    cardId: c.id,
    cardNumber: c.card_number,
    template: c.template,
    name: c.name,
    llmModel: c.llm_model,
    variant: c.variant,
    bankrollCents: c.bankroll_cents,
    tickets: db.prepare(`
      SELECT t.sequence, t.bet_type, t.selections, t.stake_cents, t.cost_cents,
             t.teller_call, t.rationale, r.number AS race
      FROM tickets t JOIN races r ON r.id = t.race_id
      WHERE t.card_id = ? ORDER BY t.sequence
    `).all(c.id).map((t) => ({
      sequence: t.sequence,
      race: t.race,
      betType: t.bet_type,
      legs: JSON.parse(t.selections).legs,
      stakeCents: t.stake_cents,
      costCents: t.cost_cents,
      tellerCall: t.teller_call,
      rationale: t.rationale,
    })),
  }));
}

/**
 * Build the payload for one race day. Returns `{payload}` or `{error}` -
 * never throws for an ordinary "no such day" case, so a caller can report
 * rather than stack-trace.
 */
export function buildStaticPayload(db, raceDayId, { referenceCards = false } = {}) {
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(raceDayId);
  if (!day) return { error: `No race day ${raceDayId}.` };
  // Invariant 12: a soft-deleted day is excluded everywhere by default, and
  // deploying one to a phone would be the loudest possible violation.
  if (day.deleted_at) return { error: `Race day ${raceDayId} is deleted (${day.track} ${day.date}). Restore it first.` };

  const races = db.prepare('SELECT * FROM races WHERE race_day_id = ? ORDER BY number').all(day.id);
  if (!races.length) return { error: `Race day ${raceDayId} (${day.track} ${day.date}) has no races.` };

  const payload = {
    schema: STATIC_PAYLOAD_SCHEMA,
    schemaVersion: STATIC_PAYLOAD_SCHEMA_VERSION,
    raceDay: {
      raceDayId: day.id,
      track: day.track,
      trackCode: day.track_code,
      date: day.date,
      meet: day.meet,
      // The builder needs a bankroll to show a running total against, and the
      // per-race minimum is part of what makes a ticket legal. Both are the
      // day's own stored values, so a card built here starts where a card
      // built at home would.
      bankrollCents: day.bankroll_cents,
      perRaceMinCents: day.per_race_min_cents,
      oddsCapturedAt: day.odds_captured_at,
    },
    races: races.map((r) => ({
      number: r.number,
      postTime: r.post_time,
      distance: r.distance,
      surface: r.surface,
      raceType: r.race_type,
      conditions: r.conditions,
      // LOAD-BEARING, not decoration: shared/parsers/human-picks.js reads the
      // wager menu for each bet type's minimum and increment, and a null one
      // silently falls back to Del Mar's minimums (CLAUDE.md, Gotchas). Ship
      // whatever the day actually has so the phone validates like the server.
      wagerMenu: r.wager_menu,
      entries: db.prepare('SELECT * FROM entries WHERE race_id = ? ORDER BY id').all(r.id).map((e) => ({
        // snake_case: the real parser reads these rows directly (see
        // shared/static-payload.js). Do not "tidy" this to camelCase.
        program_number: e.program_number,
        horse_name: e.horse_name,
        post_position: e.post_position,
        jockey: e.jockey,
        trainer: e.trainer,
        morning_line: e.morning_line,
        // Carried so the browser can fill "If it hits" from the same
        // shared/betmath.js estimator the three server-side writers use.
        morning_line_decimal: e.morning_line_decimal,
        scratched: Boolean(e.scratched),
        also_eligible: Boolean(e.also_eligible),
      })),
    })),
    referenceCards: referenceCards ? loadReferenceCards(db, day.id) : null,
    generatedAt: new Date().toISOString(),
  };

  // Hash last, over the race-day region only - see shared/static-payload.js
  // for what is excluded and why.
  payload.payloadHash = payloadHashOf(payload);

  const problems = validateStaticPayload(payload);
  if (problems.length) {
    return { error: `Payload for race day ${raceDayId} failed validation:\n  - ${problems.join('\n  - ')}` };
  }
  return { payload };
}

function parseArgs(argv) {
  const out = { raceDayId: null, out: DEFAULT_OUT, referenceCards: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reference-cards') { out.referenceCards = true; continue; }
    if (a === '--out') { out.out = argv[++i]; continue; }
    if (a.startsWith('--out=')) { out.out = a.slice('--out='.length); continue; }
    if (/^\d+$/.test(a) && out.raceDayId === null) { out.raceDayId = Number(a); continue; }
    return { error: `Unrecognized argument: ${a}` };
  }
  if (out.raceDayId === null) return { error: 'A race day id is required.' };
  if (!out.out) return { error: '--out needs a path.' };
  return out;
}

const USAGE = 'Usage: npm run build-static-payload -- <raceDayId> [--out <path>] [--reference-cards]';

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(1);
  }

  const db = openDb();
  const { payload, error } = buildStaticPayload(db, args.raceDayId, { referenceCards: args.referenceCards });
  if (error) {
    console.error(error);
    process.exit(1);
  }

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const entries = payload.races.reduce((a, r) => a + r.entries.length, 0);
  const scratched = payload.races.reduce((a, r) => a + r.entries.filter((e) => e.scratched).length, 0);
  console.log(`${payload.raceDay.track} ${payload.raceDay.date} (race day ${payload.raceDay.raceDayId})`);
  console.log(`  ${payload.races.length} race(s), ${entries} entr${entries === 1 ? 'y' : 'ies'}${scratched ? `, ${scratched} scratched` : ''}`);
  if (payload.referenceCards) {
    const tickets = payload.referenceCards.reduce((a, c) => a + c.tickets.length, 0);
    console.log(`  ${payload.referenceCards.length} reference card(s), ${tickets} ticket(s) - the static app keeps these behind an explicit reveal`);
  } else {
    console.log('  no reference cards (pass --reference-cards to embed the day\'s OTR and LLM cards)');
  }
  console.log(`  ${payload.payloadHash}`);
  console.log(`\nWrote ${path.relative(ROOT, outPath) || outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-static-payload.js')) {
  main();
}
