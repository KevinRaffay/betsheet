// D99: one-off repair for grade sets stamped with the wrong version.
//
// server/grading.js's gradeAndPersist defaulted its engineVersion to
// ENGINE_VERSION, so the two call sites that relied on the default - the
// results-save hook (gradeAllCards) and the manual "Grade vs results" button -
// stamped `lean-1.1` onto HUMAN / LLM_GENERATED / EQB_OTR cards that no engine
// produced. Invariant 14 says a grade set records the version it was produced
// under; those rows record a false one. The code fix ships in the same PR.
//
// This repairs the rows already in the database. Per affected card it
// REGRADES under the card's own version first, then deletes the lean-* set -
// that order matters, because 3 of the EQB_OTR cards have NO correct set at
// all, and deleting first would leave them ungraded and move P/L.
//
// Grading is deterministic from stored tickets + stored results, so the fresh
// set must reproduce the stale one cent for cent. The script CHECKS that per
// card and refuses to delete anything on a card where it does not - a
// difference would mean the grader's behaviour changed since those rows were
// written, which is a finding, not something to quietly overwrite.
//
// Idempotent (a second run finds no lean-* sets on non-engine cards).
// Dry run by default; --yes writes.
// Run: npm run fix-grade-set-versions -- [--yes]

import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const write = process.argv.slice(2).includes('--yes');

const { getDb } = await import(pathToFileURL(path.join(ROOT, 'server', 'db.js')));
const { gradeAndPersist, gradeVersionFor, loadDayResultsFor } = await import(pathToFileURL(path.join(ROOT, 'server', 'grading.js')));
const { gradeCard } = await import(pathToFileURL(path.join(ROOT, 'shared', 'grading.js')));
const { getLogger } = await import(pathToFileURL(path.join(ROOT, 'server', 'logging.js')));

const log = getLogger('app');
const db = getDb();

// Deleted days included: their rows stay readable and restorable, and a
// restored day must not come back carrying a false provenance claim.
const cards = db.prepare(`
  SELECT DISTINCT c.id, c.card_number, c.engine_version, c.consensus_completeness, d.date
  FROM graded_tickets gt
  JOIN tickets t ON t.id = gt.ticket_id
  JOIN cards c ON c.id = t.card_id
  JOIN race_days d ON d.id = c.race_day_id
  WHERE c.engine_version NOT LIKE 'lean-%' AND gt.engine_version LIKE 'lean-%'
  ORDER BY d.date, c.card_number
`).all();

const totalsFor = (cardId, version) => db.prepare(`
  SELECT COUNT(*) AS rows, COALESCE(SUM(gt.returned_cents), 0) AS returned, COALESCE(SUM(gt.pl_cents), 0) AS pl
  FROM graded_tickets gt JOIN tickets t ON t.id = gt.ticket_id
  WHERE t.card_id = ? AND gt.engine_version = ?
`).get(cardId, version);

const staleVersions = (cardId) => db.prepare(`
  SELECT DISTINCT gt.engine_version AS v
  FROM graded_tickets gt JOIN tickets t ON t.id = gt.ticket_id
  WHERE t.card_id = ? AND gt.engine_version LIKE 'lean-%'
`).all(cardId).map((r) => r.v);

const cardRow = (id) => db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
const money = (c) => `$${(c / 100).toFixed(2)}`;
const plan = [];
const mismatches = [];

console.log(`${cards.length} non-engine card(s) carrying a lean-* grade set.\n`);

for (const c of cards) {
  const correct = gradeVersionFor(c);
  const stale = staleVersions(c.id);
  const before = stale.map((v) => ({ v, ...totalsFor(c.id, v) }));

  // Grade IN MEMORY, never through gradeAndPersist, so a dry run writes
  // nothing - the promise every other one-off in this repo makes. The
  // persisting regrade happens later, only under --yes.
  const dayResults = loadDayResultsFor(db, cardRow(c.id).race_day_id);
  if (!dayResults) {
    mismatches.push({ card: c, why: 'no results on file for this day' });
    continue;
  }
  const tickets = db.prepare('SELECT * FROM tickets WHERE card_id = ? ORDER BY sequence').all(c.id)
    .map((t) => {
      const sel = JSON.parse(t.selections);
      return { id: t.id, betType: t.bet_type, races: sel.races, legs: sel.legs, stakeCents: t.stake_cents, costCents: t.cost_cents };
    });
  const fresh = gradeCard(tickets, dayResults);
  const after = {
    rows: fresh.grades.length,
    returned: fresh.grades.reduce((a, g) => a + g.returnedCents, 0),
    pl: fresh.grades.reduce((a, g) => a + g.plCents, 0),
  };
  const differs = before.filter((b) => b.returned !== after.returned || b.pl !== after.pl);
  if (differs.length) {
    mismatches.push({ card: c, why: 'fresh grades differ from the stale set', before, after });
    continue;
  }
  plan.push({ card: c, correct, stale, rows: before.reduce((a, b) => a + b.rows, 0), totals: after });
}

for (const p of plan) {
  console.log(`  ${p.card.date} card #${p.card.card_number} (${p.card.consensus_completeness})`);
  console.log(`    ${p.stale.join(', ')} -> ${p.correct} · ${p.rows} stale row(s) to drop`);
  console.log(`    returned ${money(p.totals.returned)}, P/L ${money(p.totals.pl)} - identical either way`);
}
if (mismatches.length) {
  console.log('\nREFUSED - fresh grades do not reproduce the stale set (left untouched):');
  for (const m of mismatches) console.log(`  card #${m.card.card_number} ${m.card.date}: ${m.why}`);
}

const del = db.prepare(`
  DELETE FROM graded_tickets WHERE engine_version = ? AND ticket_id IN (SELECT id FROM tickets WHERE card_id = ?)
`);
// Regrade FIRST, then drop the stale set, both in ONE transaction. The order
// is load-bearing: 3 of the EQB_OTR cards have no correct set at all, so
// deleting first would leave them ungraded and move P/L for as long as the
// transaction were open - and if it failed midway, permanently.
const apply = db.transaction(() => {
  for (const p of plan) {
    const res = gradeAndPersist(db, p.card.id, 'd99-repair', { engineVersion: p.correct });
    if (res.error) throw new Error(`regrade failed for card ${p.card.id}: ${res.error}`);
    for (const v of p.stale) del.run(v, p.card.id);
  }
});

if (write) {
  apply();
  console.log(`\nRepaired ${plan.length} card(s); dropped ${plan.reduce((a, p) => a + p.rows, 0)} stale grade row(s).`);
  log.info('grade_set_versions_repaired', {
    cards: plan.length, rows: plan.reduce((a, p) => a + p.rows, 0), refused: mismatches.length,
  });
} else {
  console.log(`\nWould repair ${plan.length} card(s), dropping ${plan.reduce((a, p) => a + p.rows, 0)} stale row(s).`);
  console.log('Dry run - re-run with --yes to apply.');
}
process.exit(mismatches.length ? 1 : 0);
