// Import cards built on the static Pages target (D153).
//
//   npm run import-static-cards -- <path> [--yes] [--dry-run]
//
// `<path>` is one export file or a DIRECTORY of them - a phone's downloads
// folder is the expected input, and D152's rolling backup means that folder
// holds ten files describing the same afternoon. Files are read oldest-first
// by their own exportedAt so the newest superset lands last.
//
// DRY RUN BY DEFAULT, `--yes` to write. That is this repo's convention for
// every mutating script (backfill-payout-estimates, reformat-teller-calls,
// reset), and it matters more here than usual: this is the one path by which
// data from outside this machine reaches the graded corpus. `--dry-run` is
// accepted as an explicit no-op alias for anyone reading only D153's spec.
//
// IDEMPOTENCY IS THE LOAD-BEARING REQUIREMENT, not a nicety. Import keys on
// `cards.external_id` (migration 027) and skips anything already present,
// reporting `3 cards, 3 already present`. Everything else about the D152/D153
// pair rests on it: the rolling backup is only free because re-importing is
// free, and manual file transfer is only safe because sloppy manual file
// transfer is safe.
//
// FOUR REFUSALS, each naming the check that failed:
//   * schema/version/HUMAN-ness      - shared/static-export.js
//   * the race day exists here       - and is not soft-deleted (invariant 12)
//   * payloadHash still reproduces   - the entries the ticket was built
//                                      against are still the entries on file
//   * the ticket text re-parses      - invariant 9, below
//
// INVARIANT 9 IS NOT WAIVED BY THE FILE. The export carries the device's own
// parse of each race, and this script ignores it as a source of truth: it
// re-parses the TEXT through server/human-cards.js's persistHumanRace, the
// same writer the desktop uses, which refuses on any blocking warning. The
// device's tickets are compared against the server's and a disagreement is
// REPORTED - never silently resolved in either direction.
//
// LOCK TIMESTAMPS ARE PRESERVED, and this is deliberate. Invariant 15 derives
// a card's blindness from `human_race_state.picks_locked_at` and forbids
// setting blindness by hand. persistHumanRace stamps the lock at write time,
// which is correct when the lock IS the write - and wrong here, where the lock
// happened hours earlier at a racetrack. Re-stamping the device's real lock
// time is not overriding the derivation; it is giving the derivation the fact
// it is supposed to read. Stamping import time instead would make a genuinely
// pre-committed day compute as though it were played after the results were
// already in the building.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { validateStaticExport } from '../shared/static-export.js';
import { parseHumanPicksText } from '../shared/parsers/human-picks.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const USAGE = 'Usage: npm run import-static-cards -- <path> [--yes] [--dry-run]';

export function parseArgs(argv) {
  const out = { target: null, write: false };
  for (const a of argv) {
    if (a === '--yes') { out.write = true; continue; }
    if (a === '--dry-run') { continue; } // the default; accepted so the flag is not an error
    if (a.startsWith('-')) return { error: `Unrecognized argument: ${a}` };
    if (out.target) return { error: `Only one path at a time (already have ${out.target}).` };
    out.target = a;
  }
  if (!out.target) return { error: 'A path to an export file or a directory of them is required.' };
  return out;
}

/** Every export file under `target`, oldest export first. Never throws for an unreadable file - it is reported. */
export function collectFiles(target) {
  const stat = fs.statSync(target);
  const paths = stat.isDirectory()
    ? fs.readdirSync(target).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => path.join(target, f))
    : [target];

  const files = [];
  const unreadable = [];
  for (const p of paths) {
    try {
      files.push({ path: p, doc: JSON.parse(fs.readFileSync(p, 'utf8')) });
    } catch (err) {
      unreadable.push({ path: p, reason: `not readable JSON (${err.message})` });
    }
  }
  files.sort((a, b) => String(a.doc?.exportedAt ?? '').localeCompare(String(b.doc?.exportedAt ?? '')));
  return { files, unreadable };
}

/**
 * Everything that can be decided about one export document WITHOUT writing.
 * Returns `{refusals, cards}` where each card carries its own verdict.
 */
export function planImport(db, doc, { buildStaticPayload }) {
  const refusals = [];
  const schemaProblems = validateStaticExport(doc);
  if (schemaProblems.length) {
    return { refusals: schemaProblems.map((p) => ({ check: 'schema', reason: p })), cards: [] };
  }

  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(doc.raceDayId);
  if (!day) {
    refusals.push({ check: 'race day exists', reason: `No race day ${doc.raceDayId} in this database.` });
    return { refusals, cards: [] };
  }
  if (day.deleted_at) {
    refusals.push({ check: 'race day exists', reason: `Race day ${doc.raceDayId} (${day.track} ${day.date}) is deleted. Restore it first.` });
    return { refusals, cards: [] };
  }

  // Recomputed, never looked up: the point is that the entries THIS database
  // holds today still hash to what the phone was building against.
  const rebuilt = buildStaticPayload(db, doc.raceDayId);
  if (rebuilt.error) {
    refusals.push({ check: 'payloadHash matches', reason: rebuilt.error });
    return { refusals, cards: [] };
  }
  if (rebuilt.payload.payloadHash !== doc.payloadHash) {
    refusals.push({
      check: 'payloadHash matches',
      reason: `The file was built against ${doc.payloadHash}, but race day ${doc.raceDayId} `
        + `now hashes to ${rebuilt.payload.payloadHash}. The entries have changed since this `
        + 'payload was deployed, so a ticket in this file may not mean what it says.',
    });
    return { refusals, cards: [] };
  }

  const cards = doc.cards.map((c) => {
    const existing = db.prepare('SELECT id, card_number FROM cards WHERE external_id = ?').get(c.cardId);
    if (existing) {
      return { card: c, verdict: 'already present', localCardId: existing.id, races: [] };
    }

    // Re-parse every race here too, so a dry run reports the same refusals a
    // real run would hit rather than discovering them halfway through a write.
    const races = c.races.map((r) => {
      if (r.passed) return { number: r.number, passed: true, blocking: [], tickets: [], deviceTickets: 0 };
      const race = db.prepare('SELECT * FROM races WHERE race_day_id = ? AND number = ?').get(doc.raceDayId, r.number);
      if (!race) {
        return { number: r.number, passed: false, tickets: [], deviceTickets: (r.tickets ?? []).length,
          blocking: [{ type: 'no_such_race', message: `No race ${r.number} on race day ${doc.raceDayId}.` }] };
      }
      const entries = db.prepare('SELECT * FROM entries WHERE race_id = ?').all(race.id);
      const parsed = parseHumanPicksText({
        text: r.text, race: r.number, entries, wagerMenu: race.wager_menu,
        scratchedProgramNumbers: entries.filter((e) => e.scratched).map((e) => e.program_number),
      });
      return {
        number: r.number,
        passed: false,
        blocking: parsed.warnings.filter((w) => w.blocking),
        tickets: parsed.tickets,
        deviceTickets: (r.tickets ?? []).length,
        // Reported, never resolved: the two parses disagreeing means the
        // shared parser behaved differently in two places, which is a fact
        // worth surfacing loudly rather than picking a winner for.
        deviceDisagrees: (r.tickets ?? []).length !== parsed.tickets.length,
      };
    });

    const blocked = races.filter((r) => r.blocking.length > 0);
    return {
      card: c,
      verdict: blocked.length ? 'refused' : 'to import',
      localCardId: null,
      races,
      reason: blocked.length
        ? `${blocked.length} race(s) carry blocking parse warnings: ${blocked.map((r) => `race ${r.number} (${r.blocking.map((w) => w.type).join(', ')})`).join('; ')}`
        : null,
    };
  });

  return { refusals, cards, day };
}

/** Write one planned card. Called only under --yes, inside the caller's transaction-free loop. */
function importCard(db, doc, plan, deps) {
  const { persistHumanRace, newCorrelationId, traceLog } = deps;
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(doc.raceDayId);
  // Invariant 8: one correlation id per card session. Every event this card's
  // import writes - creation, each ticket, each lock, and any grading the
  // results trigger - files under this one id.
  const correlationId = newCorrelationId();

  const replayedBefore = day.replayed_at;
  let localCardId = null;

  for (const r of plan.card.races) {
    const result = persistHumanRace(db, day, {
      race: r.number,
      text: r.passed ? '' : r.text,
      pass: r.passed,
      bankrollCents: plan.card.bankrollCents ?? undefined,
      cardId: localCardId ?? undefined,
      name: plan.card.name ?? undefined,
      correlationId,
    });
    localCardId = result.cardId;
    // The device's real lock time, put back where invariant 15 reads it.
    db.prepare('UPDATE human_race_state SET picks_locked_at = ? WHERE card_id = ? AND race_number = ?')
      .run(r.lockedAt, localCardId, r.number);
  }

  // persistHumanRace stamped replayed_at with the import clock if this was the
  // day's first-ever lock. Correct it to the earliest real lock, for the same
  // reason the per-race timestamps are corrected.
  if (!replayedBefore && plan.card.races.length) {
    const earliest = plan.card.races.map((r) => r.lockedAt).sort()[0];
    db.prepare('UPDATE race_days SET replayed_at = ? WHERE id = ?').run(earliest, doc.raceDayId);
  }

  db.prepare('UPDATE cards SET external_id = ?, built_on = ?, saw_reference_cards = ? WHERE id = ?')
    .run(plan.card.cardId, plan.card.builtOn, plan.card.sawReferenceCards ? 1 : 0, localCardId);

  traceLog.info('static_card_imported', {
    correlationId,
    cardId: localCardId,
    raceDayId: doc.raceDayId,
    externalId: plan.card.cardId,
    deviceId: plan.card.deviceId ?? doc.deviceId ?? null,
    builtOn: plan.card.builtOn,
    payloadHash: doc.payloadHash,
    sawReferenceCards: Boolean(plan.card.sawReferenceCards),
    races: plan.card.races.map((r) => r.number),
    exportedAt: doc.exportedAt,
  });

  return { localCardId, correlationId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(`${args.error}\n${USAGE}`); process.exit(1); }
  if (!fs.existsSync(args.target)) { console.error(`No such path: ${args.target}`); process.exit(1); }

  const { openDb } = await import('../server/db.js');
  const { seedTemplates } = await import('../server/templates.js');
  const { persistHumanRace } = await import('../server/human-cards.js');
  const { getLogger, newCorrelationId } = await import('../server/logging.js');
  const { buildStaticPayload } = await import('./build-static-payload.js');
  const traceLog = getLogger('decision-trace');

  const db = openDb();
  // persistHumanRace resolves the 'human' strategy template by name and stores
  // its FK; without the seed the card is written with a null template and the
  // very next race on the same card fails its own 404 lookup. The server seeds
  // on boot, and this script never boots the server.
  seedTemplates(db);
  const { files, unreadable } = collectFiles(args.target);

  for (const u of unreadable) console.error(`SKIP  ${path.relative(ROOT, u.path) || u.path} - ${u.reason}`);
  if (!files.length) {
    console.error(`No export files found under ${args.target}.`);
    process.exit(1);
  }

  let imported = 0;
  let already = 0;
  let refused = 0;
  const seenThisRun = new Map();

  for (const { path: filePath, doc } of files) {
    const rel = path.relative(ROOT, filePath) || filePath;
    console.log(`\n${rel}`);
    const plan = planImport(db, doc, { buildStaticPayload });

    if (plan.refusals.length) {
      for (const r of plan.refusals) console.log(`  REFUSED [${r.check}] ${r.reason}`);
      refused += 1;
      continue;
    }
    console.log(`  race day ${doc.raceDayId} (${plan.day.track} ${plan.day.date}), ${plan.cards.length} card(s)`);

    for (const c of plan.cards) {
      const label = `${c.card.cardId}${c.card.name ? ` "${c.card.name}"` : ''}`;
      // A card can be "already present" because an EARLIER FILE IN THIS RUN
      // imported it - the rolling backup guarantees that - so the in-run set
      // is consulted alongside the database.
      if (c.verdict === 'already present' || seenThisRun.has(c.card.cardId)) {
        already += 1;
        console.log(`  already present  ${label} -> card ${c.localCardId ?? seenThisRun.get(c.card.cardId)}`);
        continue;
      }
      if (c.verdict === 'refused') {
        refused += 1;
        console.log(`  REFUSED [ticket text re-parses] ${label}: ${c.reason}`);
        continue;
      }

      const races = c.races.length;
      const tickets = c.races.reduce((a, r) => a + r.tickets.length, 0);
      const disagreed = c.races.filter((r) => r.deviceDisagrees);
      for (const r of disagreed) {
        console.log(`  NOTE  ${label} race ${r.number}: the device recorded ${r.deviceTickets} ticket(s), `
          + `this parse found ${r.tickets.length}. The server's parse is what gets stored.`);
      }

      if (!args.write) {
        console.log(`  would import      ${label}: ${races} race(s), ${tickets} ticket(s)`
          + `${c.card.sawReferenceCards ? ', saw reference cards' : ''}`);
        imported += 1;
        continue;
      }

      const { localCardId } = importCard(db, doc, c, { persistHumanRace, newCorrelationId, traceLog });
      seenThisRun.set(c.card.cardId, localCardId);
      imported += 1;
      console.log(`  imported          ${label} -> card ${localCardId}: ${races} race(s), ${tickets} ticket(s)`
        + `${c.card.sawReferenceCards ? ', saw reference cards' : ''}`);
    }
  }

  const verb = args.write ? 'imported' : 'would import';
  console.log(`\n${files.length} file(s): ${imported} card(s) ${verb}, ${already} already present, ${refused} refused.`);
  if (!args.write) console.log('\nDry run - nothing written. Re-run with --yes to apply.');
  db.close();
  process.exit(refused > 0 ? 1 : 0);
}

if (process.argv[1]?.endsWith('import-static-cards.js')) await main();
