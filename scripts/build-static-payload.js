// Static payload builder CLI (D150, redesigned to v4 by D329).
//
//   npm run build-static-payload -- <raceDayId> [<raceDayId> ...] [--out <path>]
//   npm run build-static-payload -- --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--track "Del Mar"] [--out <path>]
//
// Emits ONE self-contained JSON file bundling one or more race days - their
// entries AND every card on them, including grades - for the GitHub Pages
// read-only viewer (D236) to load in a browser. Default destination is
// static/public/payload.json, the file the Pages deploy publishes.
//
// The payload carries PARSED DATA ONLY. No Equibase HTML, no chart text, no
// parser input of any kind reaches the browser: parsing is a home-side job
// and the browser receives structured rows it can render.
//
// It is also deliberately a READ. It opens the database, selects, and writes
// one file; it never inserts, updates or deletes. A payload build is not an
// event in a card's history and does not appear in any trace.
//
// STILL MANUAL AND DELIBERATE - no scheduling of any kind, ever (invariant
// 6/D197's rule, unaffected by this redesign or by D336 below). `--from`/
// `--to` is a convenience over raw ids (opaque autoincrement values with no
// meaning to the person running the command), not a standing job: someone
// still triggers this once, on purpose, to publish a chosen set of days.
// **D336 added a second way to trigger it - a "Publish snapshot" button on
// the race day list, `POST /api/static-payload/publish`** - but it is the
// same one-shot, no-scheduling action a person chooses to run right now; the
// CLI and the route share the exact build logic below, in
// `server/static-payload-builder.js`, so this file itself is now just the
// argument parsing, console reporting and file-writing around it.
//
// EVERY CARD ON A REQUESTED DAY IS INCLUDED, unconditionally - HUMAN, LLM and
// EQUIBASE-OTR alike, with grades where they exist. There is no more
// "reference cards" concept: nothing is built in the browser any more (D236),
// so there is no "peeked at a reference card while building" contamination
// left to guard against, and the whole point of this app now is to show the
// cards that exist.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { openDb } from '../server/db.js';
import { buildStaticPayload, DEFAULT_OUT, summarizePayload } from '../server/static-payload-builder.js';

export { DEFAULT_OUT, buildStaticDay, buildStaticPayload, payloadHashOf, resolveDayIds } from '../server/static-payload-builder.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function parseArgs(argv) {
  const out = { dayIds: [], from: null, to: null, track: null, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') { out.from = argv[++i]; continue; }
    if (a === '--to') { out.to = argv[++i]; continue; }
    if (a === '--track') { out.track = argv[++i]; continue; }
    if (a === '--out') { out.out = argv[++i]; continue; }
    if (a.startsWith('--out=')) { out.out = a.slice('--out='.length); continue; }
    if (/^\d+$/.test(a)) { out.dayIds.push(Number(a)); continue; }
    return { error: `Unrecognized argument: ${a}` };
  }
  if (out.dayIds.length && (out.from || out.to || out.track)) {
    return { error: 'Pass either explicit race-day ids or --from/--to (with an optional --track), not both.' };
  }
  if (!out.dayIds.length) {
    if (!out.from || !out.to) return { error: 'Either one or more race-day ids, or both --from and --to, are required.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.from) || !/^\d{4}-\d{2}-\d{2}$/.test(out.to)) {
      return { error: '--from/--to must be YYYY-MM-DD.' };
    }
  }
  if (!out.out) return { error: '--out needs a path.' };
  return out;
}

const USAGE = [
  'Usage: npm run build-static-payload -- <raceDayId> [<raceDayId> ...] [--out <path>]',
  '       npm run build-static-payload -- --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--track "Del Mar"] [--out <path>]',
].join('\n');

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(1);
  }

  const db = openDb();
  const { payload, error } = buildStaticPayload(db, args);
  if (error) {
    console.error(error);
    process.exit(1);
  }

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`${payload.raceDays.length} race day(s):`);
  for (const day of summarizePayload(payload)) {
    console.log(`  ${day.track} ${day.date} (race day ${day.raceDayId})`);
    console.log(`    ${day.races} race(s), ${day.entries} entr${day.entries === 1 ? 'y' : 'ies'}${day.scratched ? `, ${day.scratched} scratched` : ''}`);
    console.log(`    ${day.cards} card(s)${day.cards ? `, ${day.graded} graded` : ''}`);
    console.log(`    ${day.payloadHash}`);
  }
  console.log(`\nWrote ${path.relative(ROOT, outPath) || outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-static-payload.js')) {
  main();
}
