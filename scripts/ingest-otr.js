// Batch ingest CLI for the Equibase Off to the Races archive (D71 follow-up).
// Run: npm run ingest-otr -- [dir]   (default data/archive/equibase-otr/DMR)
//
// Walks the folder, matches each file to an existing race day by its own
// printed track/date header, and runs the SAME archive -> parse -> confirm
// path the upload endpoint does. Policy A (D43): zero blocking warnings ->
// auto-confirmed; any blocking warning -> left unconfirmed ("queued") for
// review through the upload panel. Idempotent by sha256 - a file already
// confirmed for its date is skipped, never re-appended.

import 'dotenv/config';
import path from 'node:path';
import { batchIngestEquibaseOtr } from '../server/equibase-otr.js';
import { getDb } from '../server/db.js';
import { newCorrelationId } from '../server/logging.js';

const dirArg = process.argv[2];
const dir = dirArg ? path.resolve(dirArg) : undefined;

const report = batchIngestEquibaseOtr(getDb(), {
  dir, correlationId: newCorrelationId(),
  log: (r) => {
    if (r.status === 'ingested') {
      console.log(`  INGESTED  ${r.file}  raceDayId=${r.raceDayId}  ${r.cards.length} cards`);
    } else if (r.status === 'queued') {
      console.log(`  QUEUED    ${r.file}  raceDayId=${r.raceDayId}  ${r.reason}`);
      for (const w of r.blocking) console.log(`              ${w.type}: ${w.message}`);
    } else {
      console.log(`  SKIPPED   ${r.file}  ${r.reason}`);
    }
  },
});

console.log('');
console.log(`${report.seen} file(s) seen: ${report.ingested} ingested, ${report.queued} queued, ${report.skipped} skipped, ${report.cardsWritten} card(s) written`);
