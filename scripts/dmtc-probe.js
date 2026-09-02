// Meet-window probe CLI (index source 2, user decision 2026-09-02).
// Run: npm run dmtc-probe -- --meet DMR-2025-summer --from 2025-07-18 --to 2025-09-07
//        --source "where the published window comes from" [--dry-run]
//
// dmtc.com renders past seasons' calendars dark (no race days), so a past
// meet is indexed by ONE bounded probe of its publicly published window:
// one results-page request per date, polite rate, every request in the
// fetch audit. The evidence lands in data/meets/<meet>.json (commit it);
// race days' results pages are archived on the spot. Blind enumeration
// outside a published window stays prohibited - the window and its source
// are inputs you justify here.

import 'dotenv/config';
import { probeMeetWindow } from '../server/dmtc-crawler.js';
import { getDb } from '../server/db.js';
import { newCorrelationId } from '../server/logging.js';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? true) : fallback; };
const flag = (name) => args.includes(`--${name}`);
const usage = () => { console.error('usage: npm run dmtc-probe -- --meet DMR-YYYY-summer|fall --from YYYY-MM-DD --to YYYY-MM-DD --source "published window source" [--dry-run]'); process.exit(2); };
const meet = opt('meet'); const from = opt('from'); const to = opt('to'); const source = opt('source');
if (!meet || meet === true || !from || !to || !source || source === true) usage();

let report;
try {
  report = await probeMeetWindow({
    meet, from, to, source, dryRun: flag('dry-run'), db: getDb(), correlationId: newCorrelationId(),
    onEvent: (e) => console.log(`  ${String(e.outcome).padEnd(10)} ${e.date ?? ''} ${e.httpStatus ?? '   '} ${e.url ?? ''}${e.detail ? ` - ${e.detail}` : ''}`),
  });
} catch (err) { console.error(String(err.message)); process.exit(2); }

console.log('');
console.log(`${report.dryRun ? 'DRY RUN - ' : ''}${meet} window ${from}..${to} (${report.dates} dates): source "${source}"`);
if (!report.dryRun) console.log(`requests: ${report.performed}; race days: ${report.raceDays}; dark days: ${report.darkDays}; results archived: ${report.archived}; blocked: ${report.blocked}; errors: ${report.errors}`);
if (report.haltedReason) { console.error(`HALTED: ${report.haltedReason} - no table written`); process.exit(1); }
if (!report.dryRun) console.log(`wrote ${report.tablePath} - commit it with the evidence it carries`);
