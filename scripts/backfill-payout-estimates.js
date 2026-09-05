// D96: one-off retroactive fill. D91 made shared/betmath.js's
// estimateTicketPayouts the ONE "If it hits" dispatcher and wired it into the
// three writers that had been missing it, but only for tickets saved from
// then on. Every ticket already in the database kept a NULL estimate, which is
// how D95's Replay final card came to render a dash down its whole "If it
// hits" column - correct by D54's original rule ("a human already knows their
// own bet"), wrong once the sheet became the after-the-fact review surface.
//
// Scope is the three buckets whose writers call that dispatcher:
// engine_version 'human' / 'llm' / 'equibase-otr'. **Engine cards are
// deliberately excluded.** shared/card-engine.js computes its own estimates
// mid-construction with context the dispatcher does not have (place-rule ML,
// straight exactas priced off the LONGEST-priced under, the rebalancer
// rewriting est after a stake moves), so re-deriving one would CHANGE a stored
// lean number - an engine change requiring an ENGINE_VERSION bump
// (invariant 14). None of them is NULL anyway; the WHERE clause is the
// guarantee, not the observation.
//
// Only ever fills a NULL. It cannot overwrite an existing estimate, so it
// cannot move a number anyone has already read. A ticket whose bet type has no
// validated formula in this codebase (show, straight trifecta, superfecta,
// superfecta box - the engine never produces them either) or whose selection
// has no morning line comes back from the dispatcher UNCHANGED BY IDENTITY:
// it stays NULL and is reported as declined, never guessed. On today's corpus
// that is most of the set, and it is correct rather than a miss.
//
// est_payout_* is a DISPLAY estimate: no money moves, no grade, no allocation,
// no selection changes. Idempotent - a second run finds nothing to fill.
// Defaults to a dry run; --yes writes.
// Run: npm run backfill-payout-estimates -- [--yes]

import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const write = process.argv.slice(2).includes('--yes');

const { getDb } = await import(pathToFileURL(path.join(ROOT, 'server', 'db.js')));
const { estimateTicketPayouts } = await import(pathToFileURL(path.join(ROOT, 'shared', 'betmath.js')));
const { getLogger } = await import(pathToFileURL(path.join(ROOT, 'server', 'logging.js')));

const log = getLogger('app');
const db = getDb();

// Deleted days included, the same reason D85 and D77-B include them: their
// rows stay readable and restorable, and a restored day must not come back
// with a column its live neighbours all carry.
const rows = db.prepare(`
  SELECT t.id, t.race_id, t.bet_type, t.selections, t.stake_cents,
         c.card_number, c.engine_version, c.consensus_completeness AS bucket,
         d.date, d.deleted_at
  FROM tickets t
  JOIN cards c ON c.id = t.card_id
  JOIN race_days d ON d.id = c.race_day_id
  WHERE t.est_payout_min_cents IS NULL
    AND c.engine_version IN ('human', 'llm', 'equibase-otr')
  ORDER BY d.date, c.card_number, t.sequence
`).all();

// One mlOf per race, built exactly as server/human-cards.js, server/llm-cards.js
// and server/equibase-otr.js each build it - same lookup, same null fallback.
const entriesFor = db.prepare('SELECT program_number, morning_line_decimal FROM entries WHERE race_id = ?');
const mlCache = new Map();
const mlOfRace = (raceId) => {
  if (!mlCache.has(raceId)) {
    const entries = entriesFor.all(raceId);
    mlCache.set(raceId, (pgm) => entries.find((e) => e.program_number === pgm)?.morning_line_decimal ?? null);
  }
  return mlCache.get(raceId);
};

const filled = [];
const declined = [];
const skipped = [];
for (const r of rows) {
  let sel;
  try { sel = JSON.parse(r.selections); } catch { sel = null; }
  const legs = Array.isArray(sel?.legs) ? sel.legs : null;
  // Never guess. An unreadable selection, or a multi-race ticket (race_id NULL
  // - there is no single race whose entries would price it, and the dispatcher
  // has no multi-race case either), keeps its NULL and is reported.
  if (!legs?.length || !Number.isFinite(r.stake_cents) || r.race_id == null) {
    skipped.push(r);
    continue;
  }
  const [out] = estimateTicketPayouts(
    [{ betType: r.bet_type, legs, stakeCents: r.stake_cents }],
    mlOfRace(r.race_id),
  );
  if (out.estMinCents == null) declined.push(r);
  else filled.push({ ...r, ...out });
}

const tally = (list) => {
  const by = new Map();
  for (const r of list) {
    const k = `${r.bucket} ${r.bet_type}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1]);
};

console.log(`${rows.length} ticket(s) with no estimate on a human / llm / equibase-otr card.`);
console.log(`  ${filled.length} to fill, ${declined.length} declined by the estimator, ${skipped.length} unreadable or multi-race.\n`);

if (filled.length) {
  console.log('To fill:');
  for (const [k, n] of tally(filled)) console.log(`  ${n.toString().padStart(4)}  ${k}`);
  console.log('\n  Sample:');
  for (const r of filled.slice(0, 8)) {
    const range = r.estIsRange ? `${(r.estMinCents / 100).toFixed(2)}-${(r.estMaxCents / 100).toFixed(2)} (est.)` : (r.estMinCents / 100).toFixed(2);
    console.log(`    ${r.date} card #${r.card_number} ticket ${r.id}: ${r.bet_type} $${(r.stake_cents / 100).toFixed(2)} -> $${range}`);
  }
}
if (declined.length) {
  console.log('\nDeclined - no validated formula for the bet type, or a selection with no morning line.');
  console.log('These stay NULL on purpose; a later validated formula would pick them up on a re-run:');
  for (const [k, n] of tally(declined)) console.log(`  ${n.toString().padStart(4)}  ${k}`);
}
if (skipped.length) {
  console.log('\nUnreadable or multi-race (left untouched):');
  for (const r of skipped.slice(0, 20)) console.log(`  ticket ${r.id} (${r.date} card #${r.card_number}): race_id=${r.race_id} ${r.selections}`);
  if (skipped.length > 20) console.log(`  ...and ${skipped.length - 20} more`);
}

const upd = db.prepare(`
  UPDATE tickets SET est_payout_min_cents = ?, est_payout_max_cents = ?, est_is_range = ?
  WHERE id = ? AND est_payout_min_cents IS NULL
`);
const apply = db.transaction(() => {
  for (const r of filled) upd.run(r.estMinCents, r.estMaxCents, r.estIsRange ? 1 : 0, r.id);
});
if (write) apply();

const days = new Set(filled.map((r) => r.date)).size;
console.log(`\n${write ? 'Filled' : 'Would fill'} ${filled.length} ticket(s) across ${days} day(s).`);
if (!write) console.log('\nDry run - nothing written. Re-run with --yes to apply.');
else log.info('payout_estimates_backfilled', { tickets: filled.length, days, declined: declined.length, skipped: skipped.length });
