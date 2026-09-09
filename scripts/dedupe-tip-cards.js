// One-off: fold D171's duplicate TIPSHEET card sets down to one per
// (race day, source, variant). Run: npm run dedupe-tip-cards [-- --yes]
//
// D171 staked append-only, so staking again after each race's picks arrived
// minted three MORE cards every time. D174 changed that - a re-stake now
// reuses the card - but it cannot retroactively merge the sets already
// written, and after migration 031 backfills `tip_source_label` the next
// stake simply reuses the newest of each group and leaves the older ones
// sitting there. This removes them.
//
// DRY RUN BY DEFAULT, the house convention (`reformat-teller-calls`,
// `backfill-payout-estimates`, `fix-grade-set-versions`). `--yes` writes.
//
// KEEPS THE NEWEST of each group, because that is the one a later stake will
// reuse - so keeping any other would leave the app writing to a card this
// script had decided was not the survivor.
//
// REFUSES to delete a GRADED card. A graded card is evidence: its P/L is in
// reports and its grades are joined into exports. If a group's older cards
// are graded they are REPORTED and left alone, for a person to decide about,
// rather than quietly destroyed to tidy a list.

import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const WRITE = args.includes('--yes');

process.env.BETSHEET_LOG_DIR ??= path.join(ROOT, 'server', 'logs');
const { openDb } = await import('../server/db.js');
const { getLogger } = await import('../server/logging.js');

const db = openDb();
const traceLog = getLogger('decision-trace');

const groups = db.prepare(`
  SELECT race_day_id, tip_source_label, variant, COUNT(*) n
    FROM cards
   WHERE consensus_completeness = 'TIPSHEET' AND tip_source_label IS NOT NULL
   GROUP BY race_day_id, tip_source_label, variant
  HAVING COUNT(*) > 1
   ORDER BY race_day_id, tip_source_label, variant
`).all();

const isGraded = db.prepare(`
  SELECT 1 FROM graded_tickets g JOIN tickets t ON t.id = g.ticket_id
   WHERE t.card_id = ? LIMIT 1
`);

if (groups.length === 0) {
  console.log('No duplicate TIPSHEET card groups. Nothing to do.');
  db.close();
  process.exit(0);
}

console.log(`${groups.length} duplicated (race day, source, variant) group(s):\n`);

let toDelete = 0;
let refused = 0;
const deletions = [];

for (const g of groups) {
  const cards = db.prepare(`
    SELECT c.id, c.card_number, c.created_at,
           (SELECT COUNT(*) FROM tickets t WHERE t.card_id = c.id) tickets
      FROM cards c
     WHERE c.race_day_id = ? AND c.consensus_completeness = 'TIPSHEET'
       AND c.tip_source_label = ? AND c.variant = ?
     ORDER BY c.card_number DESC
  `).all(g.race_day_id, g.tip_source_label, g.variant);

  const keep = cards[0];
  console.log(`  day ${g.race_day_id}  ${g.tip_source_label}  ${g.variant}`);
  console.log(`    KEEP    #${keep.card_number} (id ${keep.id}, ${keep.tickets} tickets) - the one a later stake reuses`);
  for (const c of cards.slice(1)) {
    if (isGraded.get(c.id)) {
      refused += 1;
      console.log(`    REFUSE  #${c.card_number} (id ${c.id}) - GRADED, left alone; delete it yourself if you mean to`);
    } else {
      toDelete += 1;
      deletions.push(c.id);
      console.log(`    delete  #${c.card_number} (id ${c.id}, ${c.tickets} tickets)`);
    }
  }
}

console.log('');
console.log(`${toDelete} card(s) to delete, ${refused} refused as graded.`);

if (!WRITE) {
  console.log('\nDRY RUN - nothing was changed. Re-run with `-- --yes` to apply.');
  db.close();
  process.exit(0);
}

const run = db.transaction(() => {
  for (const id of deletions) {
    const card = db.prepare('SELECT race_day_id, card_number, variant, tip_source_label FROM cards WHERE id = ?').get(id);
    db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    traceLog.info('tip_card_deduped', {
      cardId: id, raceDayId: card.race_day_id, cardNumber: card.card_number,
      variant: card.variant, sourceLabel: card.tip_source_label, reason: 'duplicate_tipsheet_card_set',
    });
  }
});
run();

console.log(`\nDeleted ${deletions.length} duplicate card(s); ${refused} graded card(s) left alone.`);
db.close();
