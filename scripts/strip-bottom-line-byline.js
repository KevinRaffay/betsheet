// D77: one-off retroactive fix. server/program-parser.js's parseAnalysis
// used to hand back the handicapper column's byline block - "<Track> Bottom
// Line By <Author>", the author bio, the page numbers and the repeated
// masthead - glued onto whichever race paragraph ran last on the section's
// final page, so every day already saved carries it inside that race's
// races.bottom_line as if the handicapper had written it about that race.
// The parser drops it now (stripBylineBlock); this applies the SAME function
// to what is already stored, so the DB and a fresh parse can never diverge.
//
// Idempotent and safe to re-run: only UPDATEs races.bottom_line, and only
// for rows the strip actually changes. Defaults to a dry run (reports what
// it WOULD change); --yes writes it.
// Run: npm run strip-bottom-line-byline -- [--yes]

import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const write = process.argv.slice(2).includes('--yes');

const { getDb } = await import(pathToFileURL(path.join(ROOT, 'server', 'db.js')));
const { stripBylineBlock } = await import(pathToFileURL(path.join(ROOT, 'server', 'program-parser.js')));
const { getLogger } = await import(pathToFileURL(path.join(ROOT, 'server', 'logging.js')));

const log = getLogger('app');
const db = getDb();

// Deleted days are excluded from every aggregate (invariant 12) but their
// rows are still readable and restorable, so clean their text too.
const rows = db.prepare(`
  SELECT r.id, r.number, r.bottom_line, d.date, d.meet
  FROM races r JOIN race_days d ON d.id = r.race_day_id
  WHERE r.bottom_line IS NOT NULL
  ORDER BY d.date, r.number
`).all();

const changed = rows
  .map((r) => ({ ...r, stripped: stripBylineBlock(r.bottom_line) }))
  .filter((r) => r.stripped !== r.bottom_line);

console.log(`${rows.length} race(s) with bottom_line text; ${changed.length} carry the byline block.\n`);

const upd = db.prepare('UPDATE races SET bottom_line = ? WHERE id = ?');
const apply = db.transaction(() => {
  for (const r of changed) upd.run(r.stripped, r.id);
});
if (write) apply();

for (const r of changed) {
  const removed = r.bottom_line.length - r.stripped.length;
  console.log(`  ${r.date} (${r.meet ?? 'no meet'}) race ${r.number}: ${write ? 'stripped' : 'would strip'} ${removed} chars`);
}

console.log(`\n${write ? 'Stripped' : 'Would strip'} the byline block from ${changed.length} race(s).`);
if (!write) console.log('\nDry run - nothing written. Re-run with --yes to apply.');
else log.info('bottom_line_byline_stripped', { races: changed.length, days: new Set(changed.map((r) => r.date)).size });
