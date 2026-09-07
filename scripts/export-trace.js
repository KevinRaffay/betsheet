// CLI trace export: the same document GET /api/cards/:id/export serves,
// written to a file or stdout - for feeding a card's full story (inputs,
// decisions, grades) to an LLM without the server running.
//
//   npm run export-trace -- --card 3                 # stdout
//   npm run export-trace -- --card 3 --out card3.json
//   npm run export-trace -- --card 3 --omit-llm-inputs   # shareable form (D149)
//
// Respects BETSHEET_DB / BETSHEET_LOG_DIR like the server does.

import fs from 'node:fs';
import { getDb } from '../server/db.js';
import { buildCardExport } from '../server/trace-export.js';

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const cardId = Number(argOf('--card'));
if (!Number.isInteger(cardId)) {
  console.error('usage: npm run export-trace -- --card <id> [--out <file>]');
  process.exit(1);
}

const out = buildCardExport(getDb(), cardId, { omitLlmInputs: args.includes('--omit-llm-inputs') });
if (out.error) {
  console.error(out.error);
  process.exit(1);
}

const json = JSON.stringify(out, null, 2);
const dest = argOf('--out');
if (dest) {
  fs.writeFileSync(dest, json + '\n');
  console.error(`exported card ${cardId}: ${out.trace.length} trace events, ` +
    `${out.tickets.length} tickets${out.gradeSummary ? ' (graded)' : ' (not graded yet)'} -> ${dest}`);
} else {
  process.stdout.write(json + '\n');
}
