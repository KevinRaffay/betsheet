// dmtc.com crawler CLI (D41).
// Run: npm run dmtc-fetch -- --from YYYY-MM-DD --to YYYY-MM-DD
//        [--what program,ml,results,calendar] [--refresh] [--dry-run]
//
// --dry-run prints the calendar-derived plan and the request count without
// touching the network: it reads ARCHIVED calendar pages, and lists any
// month whose calendar is not archived yet (fetch those with
// --what calendar first). Everything else goes through server/dmtc-crawler.js.

import 'dotenv/config';
import { crawl, KINDS } from '../server/dmtc-crawler.js';
import { getDb } from '../server/db.js';
import { newCorrelationId } from '../server/logging.js';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const from = opt('from');
const to = opt('to', from);
if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
  console.error('usage: npm run dmtc-fetch -- --from YYYY-MM-DD --to YYYY-MM-DD [--what program,ml,results,calendar] [--refresh] [--dry-run]');
  process.exit(2);
}
const what = String(opt('what', 'program,ml,results')).split(',').map((s) => s.trim()).filter(Boolean);
const bad = what.filter((k) => !KINDS.includes(k) && k !== 'calendar');
if (bad.length) { console.error(`unknown --what kind(s): ${bad.join(', ')}`); process.exit(2); }

const report = await crawl({
  from, to, what, refresh: flag('refresh'), dryRun: flag('dry-run'),
  db: getDb(), correlationId: newCorrelationId(),
  onEvent: (e) => console.log(`  ${e.outcome.padEnd(12)} ${e.date ?? ''} ${e.kind.padEnd(8)} ${e.url ?? ''}${e.detail ? ` - ${e.detail}` : ''}`),
});

console.log('');
console.log(`${report.dryRun ? 'DRY RUN - ' : ''}${report.days.length} race day(s) ${from}..${to} from ${report.calendars.length} calendar month(s)` +
  (report.missingCalendars.length ? `; calendars NOT archived: ${report.missingCalendars.join(', ')} (fetch with --what calendar)` : ''));
console.log(`planned requests: ${report.planned.length}; performed: ${report.performed}; archived: ${report.archived}; skipped (already archived): ${report.skipped}; blocked by robots: ${report.blocked}; errors: ${report.errors}`);
if (report.haltedReason) { console.error(`HALTED: ${report.haltedReason}`); process.exit(1); }
