// Batch backfill CLI (D43).
// Run: npm run backfill -- --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]
//        [--regenerate] [--meet DMR-2026-summer] [--bankroll 200] [--min 5]
//        [--raw-dir d] [--golden-dir d] [--docs-dir d]   (overrides for checks and smoke runs)
//
// Reads the D41 archive only (never the network). Prints one line per race
// day, the end summary and the regression line, and writes
// docs/backfill/<meet>.md (+ .json sidecar) unless --dry-run. Exit 1 when
// the run halted (golden checkpoint, golden drift, or a missing golden).

import 'dotenv/config';
import { BLOCKING_TYPES, runBackfill, usd, writeReports } from '../server/backfill.js';
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
  console.error('usage: npm run backfill -- --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run] [--regenerate] [--meet DMR-2026-summer] [--bankroll 200] [--min 5]');
  process.exit(2);
}
const meet = opt('meet');
const bankrollCents = Math.round(Number(opt('bankroll', '200')) * 100);
const perRaceMinCents = Math.round(Number(opt('min', '5')) * 100);
if (!(bankrollCents > 0) || !(perRaceMinCents > 0)) { console.error('--bankroll and --min must be positive dollars'); process.exit(2); }

const fig = (l) => (l.figures ? `${usd(l.figures.wageredCents)} -> ${usd(l.figures.returnedCents)} P/L ${usd(l.figures.plCents)} (eff. wagered ${usd(l.figures.effectiveWageredCents)})` : '');
const cross = (l) => (l.crossSource ? ` cross ${l.crossSource.agree}/${l.crossSource.tickets}${l.crossSource.disagreements?.length ? ' DISAGREE' : ''}` : '');

const report = await runBackfill({
  from, to, meet: meet && meet !== true ? meet : null, dryRun: flag('dry-run'), regenerate: flag('regenerate'),
  bankrollCents, perRaceMinCents, db: getDb(), correlationId: newCorrelationId(),
  ...(opt('raw-dir') ? { rawDir: opt('raw-dir') } : {}), ...(opt('golden-dir') ? { goldenDir: opt('golden-dir') } : {}), ...(opt('docs-dir') ? { docsDir: opt('docs-dir') } : {}),
  onLine: (l) => {
    console.log(`  ${l.date}  ${(l.meet ?? '-').padEnd(16)} ${l.status.padEnd(16)} races ${l.calendarRaces ?? '-'}/${l.parsedRaces ?? '-'}/${l.resultsRaces ?? '-'}` +
      `  block ${(l.blocking ?? []).length} non ${(l.nonBlocking ?? []).length}  ${(l.completeness ?? '-').padEnd(12)} ${(l.resultsSource ?? '-').padEnd(9)} ${l.engineVersion ?? '-'}${cross(l)}  ${fig(l)}`);
    if (l.note) console.log(`             ${l.note}`);
    for (const w of l.blocking ?? []) console.log(`             BLOCKING ${w.type} (${BLOCKING_TYPES[w.type]}): ${w.message}`);
  },
});

const s = report.summary;
console.log('');
console.log(`${report.dryRun ? 'DRY RUN - ' : ''}${s.days} race day(s) ${from}..${to}${meet && meet !== true ? ` (${meet})` : ''}, engine ${report.engineVersion}: ` +
  Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(', '));
if (Object.keys(s.warningsByType).length) console.log(`warnings by type: ${Object.entries(s.warningsByType).sort().map(([k, v]) => `${k} ${v}`).join('; ')}`);
for (const [k, b] of Object.entries(s.plByBucket)) console.log(`P/L ${k}: ${b.days} day(s), wagered ${usd(b.wageredCents)} (effective ${usd(b.effectiveWageredCents)}), returned ${usd(b.returnedCents)}, P/L ${usd(b.plCents)}`);
console.log(`cross-source: ${s.crossSource.days} day(s) checked, ${s.crossSource.disagreements} disagreement(s)`);
const reg = report.lines.filter((l) => l.regression);
if (reg.length) {
  console.log('regression line (previously hand-graded days):');
  for (const l of reg) console.log(`  ${l.date}  hand ${usd(l.regression.baseline?.plCents)}  runner ${usd(l.regression.runner?.plCents)}  ${l.regression.deltaCents == null ? '' : `diff ${usd(l.regression.deltaCents)}  `}${l.regression.label}`);
}
if (report.missingCalendars.length) console.log(`calendars NOT archived: ${report.missingCalendars.join(', ')} (npm run dmtc-fetch -- --from ${from} --to ${to} --what calendar)`);
if (!report.dryRun) for (const f of writeReports(report, opt('docs-dir') ? { docsDir: opt('docs-dir') } : {})) console.log(`wrote ${f}`);
if (report.halted) { console.error(`HALTED: ${report.halted}`); process.exit(1); }
