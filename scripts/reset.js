// CLI factory reset: `npm run reset -- --yes`
// Wipes every stored record and every log file (see server/reset.js).
// Refuses without --yes. Works with the server stopped or running (rows go
// through the same SQLite file; the running server picks up the empty
// state on its next query).

import { openDb } from '../server/db.js';
import { resetApp } from '../server/reset.js';

if (!process.argv.includes('--yes')) {
  console.error('Factory reset deletes EVERY stored record and EVERY log file.');
  console.error('Run: npm run reset -- --yes');
  process.exit(1);
}

const db = openDb();
const result = resetApp(db);
db.close();

const rows = Object.entries(result.rowsRemoved).filter(([, n]) => n > 0);
console.log('Reset complete.');
console.log(rows.length
  ? `Rows removed: ${rows.map(([t, n]) => `${t}=${n}`).join(', ')}`
  : 'Rows removed: none (was already empty)');
console.log(`Log files removed: ${result.logFilesRemoved}`);
