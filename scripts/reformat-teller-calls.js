// D85: one-off retroactive fix. D84 rewrote shared/betmath.js's tellerCall to
// emit the grammar you actually say at the window ("$2 EX 4 WITH 1-7"), but
// every ticket saved before it carries the old string ("Race 3, $2 exacta, 4
// over 1,7") in tickets.teller_call. This re-derives that column from the
// ticket's own bet_type / selections / stake_cents so exactly ONE format
// exists in the database.
//
// A factory reset would also have produced uniform strings and was rejected
// on evidence (see the D85 row in DELIVERABLES.md): the corpus holds HUMAN,
// LLM_GENERATED and EQB_OTR cards, consensus picks and blind-play timestamps
// that no source file can rebuild. This script needs none of that - every
// input is already in the row, so it covers those cards too.
//
// teller_call is a DISPLAY column: no money, no grade, no allocation and no
// selection changes. Idempotent and safe to re-run - only UPDATEs rows whose
// re-derived string actually differs. Defaults to a dry run; --yes writes.
// Run: npm run reformat-teller-calls -- [--yes]

import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const write = process.argv.slice(2).includes('--yes');

const { getDb } = await import(pathToFileURL(path.join(ROOT, 'server', 'db.js')));
const { tellerCall } = await import(pathToFileURL(path.join(ROOT, 'shared', 'betmath.js')));
const { getLogger } = await import(pathToFileURL(path.join(ROOT, 'server', 'logging.js')));

const log = getLogger('app');
const db = getDb();

// Deleted days are excluded from every aggregate (invariant 12) but their rows
// stay readable and restorable, so reformat their tickets too - a restored day
// must not come back wearing the old grammar.
const rows = db.prepare(`
  SELECT t.id, t.bet_type, t.selections, t.stake_cents, t.teller_call,
         c.card_number, d.date, d.meet
  FROM tickets t
  JOIN cards c ON c.id = t.card_id
  JOIN race_days d ON d.id = c.race_day_id
  ORDER BY d.date, c.card_number, t.sequence
`).all();

const skipped = [];
const changed = [];
for (const r of rows) {
  let sel;
  try { sel = JSON.parse(r.selections); } catch { sel = null; }
  const races = Array.isArray(sel?.races) ? sel.races : null;
  const legs = Array.isArray(sel?.legs) ? sel.legs : null;
  // Never guess: a row whose selections can't be read keeps whatever string it
  // has, and is reported rather than silently passed over.
  if (!races?.length || !legs?.length || !Number.isFinite(r.stake_cents)) {
    skipped.push(r);
    continue;
  }
  const next = tellerCall(r.bet_type, races, r.stake_cents, legs);
  if (next !== r.teller_call) changed.push({ ...r, next });
}

console.log(`${rows.length} ticket(s); ${changed.length} to reformat, ${rows.length - changed.length - skipped.length} already current, ${skipped.length} unreadable.\n`);

// One example per bet type is the useful review artifact - 2000+ near-identical
// lines is not.
const seen = new Set();
for (const r of changed) {
  if (seen.has(r.bet_type)) continue;
  seen.add(r.bet_type);
  console.log(`  ${r.bet_type}`);
  console.log(`    from  ${r.teller_call}`);
  console.log(`    to    ${r.next}`);
}
if (skipped.length) {
  console.log('\nUnreadable selections (left untouched):');
  for (const r of skipped.slice(0, 20)) console.log(`  ticket ${r.id} (${r.date} card #${r.card_number}): ${r.selections}`);
  if (skipped.length > 20) console.log(`  ...and ${skipped.length - 20} more`);
}

const upd = db.prepare('UPDATE tickets SET teller_call = ? WHERE id = ?');
const apply = db.transaction(() => {
  for (const r of changed) upd.run(r.next, r.id);
});
if (write) apply();

console.log(`\n${write ? 'Reformatted' : 'Would reformat'} ${changed.length} ticket(s) across ${new Set(changed.map((r) => r.date)).size} day(s).`);
if (!write) console.log('\nDry run - nothing written. Re-run with --yes to apply.');
else log.info('teller_calls_reformatted', { tickets: changed.length, days: new Set(changed.map((r) => r.date)).size, skipped: skipped.length });
