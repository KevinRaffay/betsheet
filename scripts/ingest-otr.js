// Batch ingest CLI for the Equibase Off to the Races archive (D71 follow-up;
// --consensus-only added D74).
// Run: npm run ingest-otr -- [dir]                    (default data/archive/equibase-otr/DMR)
//      npm run ingest-otr -- --consensus-only [dir]
//
// Walks the folder, matches each file to an existing race day by its own
// printed track/date header, and runs the SAME archive -> parse -> confirm
// path the upload endpoint does. Policy A (D43): zero blocking warnings ->
// auto-confirmed; any blocking warning -> left unconfirmed ("queued") for
// review through the upload panel. Idempotent by sha256 - a file already
// confirmed for its date is skipped, never re-appended.
//
// --consensus-only (D74): skips card creation and writes ONLY the OTR
// consensus rows for a day that already has EQB_OTR cards from an earlier
// run - the way the archived days (D45/D46/D71/D72's corpus) gain the
// third source without a duplicate pile of picker cards. A file not yet
// confirmed is left alone in this mode - run the plain batch first.

import 'dotenv/config';
import path from 'node:path';
import { batchIngestEquibaseOtr } from '../server/equibase-otr.js';
import { getDb } from '../server/db.js';
import { newCorrelationId } from '../server/logging.js';

const args = process.argv.slice(2);
const consensusOnly = args.includes('--consensus-only');
const dirArg = args.find((a) => a !== '--consensus-only');
const dir = dirArg ? path.resolve(dirArg) : undefined;

const report = batchIngestEquibaseOtr(getDb(), {
  dir, consensusOnly, correlationId: newCorrelationId(),
  log: (r) => {
    if (r.status === 'ingested') {
      console.log(`  INGESTED  ${r.file}  raceDayId=${r.raceDayId}  ${r.cards.length} cards`);
    } else if (r.status === 'consensus_written') {
      console.log(`  CONSENSUS ${r.file}  raceDayId=${r.raceDayId}  ${r.picksStored} pick(s) stored`);
    } else if (r.status === 'queued') {
      console.log(`  QUEUED    ${r.file}  raceDayId=${r.raceDayId}  ${r.reason}`);
      for (const w of r.blocking) console.log(`              ${w.type}: ${w.message}`);
    } else {
      console.log(`  SKIPPED   ${r.file}  ${r.reason}`);
    }
  },
});

console.log('');
console.log(consensusOnly
  ? `${report.seen} file(s) seen: ${report.consensusWritten} consensus-written, ${report.skipped} skipped`
  : `${report.seen} file(s) seen: ${report.ingested} ingested, ${report.queued} queued, ${report.skipped} skipped, ${report.cardsWritten} card(s) written`);
