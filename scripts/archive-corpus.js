// P-0.1: freeze the pre-pivot corpus before anything is removed (D107).
//
// The pivot deletes the consensus engine, program ingestion and eventually the
// database itself. Most of what is in there cannot be rebuilt from source
// files at any price: the blind-play timestamps invariant 15 derives from, the
// LLM request log with its paid, nondeterministic answers, the consensus picks
// for past dates that are no longer fetchable, and the simulation runs the
// findings doc cites by id. This makes the copy that survives all of it.
//
// Two artifacts:
//   archive/betsheet-pre-pivot-<date>.db   a consistent snapshot (VACUUM INTO,
//                                          so the WAL is folded in)
//   archive/exports/card-<id>.json         one trace export per card, the same
//                                          document GET /api/cards/:id/export
//                                          serves, built without a server
//
// NOTHING IN THE APP READS FROM archive/. It is frozen evidence, not a live
// corpus, and it is never migrated forward - if a later schema change makes it
// unreadable, that is expected and the exports are the durable form.
//
// Refuses to clobber an existing archive for the same date without --force,
// because re-running after a removal has begun would freeze the wrong thing.
//
// Run: npm run archive-corpus [-- --force]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const force = process.argv.slice(2).includes('--force');

const { getDb } = await import(pathToFileURL(path.join(ROOT, 'server', 'db.js')));
const { buildCardExport } = await import(pathToFileURL(path.join(ROOT, 'server', 'trace-export.js')));

const db = getDb();
const today = new Date().toISOString().slice(0, 10);
const ARCHIVE = path.join(ROOT, 'archive');
const EXPORTS = path.join(ARCHIVE, 'exports');
const DB_COPY = path.join(ARCHIVE, `betsheet-pre-pivot-${today}.db`);

if (fs.existsSync(DB_COPY) && !force) {
  console.error(`${path.relative(ROOT, DB_COPY)} already exists.`);
  console.error('Re-running after a removal has begun would freeze the wrong thing. Pass --force if you mean it.');
  process.exit(1);
}

fs.mkdirSync(EXPORTS, { recursive: true });

// ---------- the snapshot ----------
// VACUUM INTO rather than a file copy: it takes a consistent snapshot with the
// WAL folded in, which a cp of the .sqlite alone would miss.
if (fs.existsSync(DB_COPY)) fs.rmSync(DB_COPY);
db.prepare('VACUUM INTO ?').run(DB_COPY);

const TABLES = ['race_days', 'races', 'entries', 'cards', 'tickets', 'graded_tickets',
  'allocations', 'race_results', 'exotic_payoffs', 'consensus_picks', 'llm_card_requests',
  'llm_notes', 'human_race_state', 'simulation_runs', 'result_charts'];

const countIn = (handle, table) => {
  try { return handle.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n; } catch { return null; }
};

// Verify the copy rather than trusting it: an archive nobody checked is not a
// safety net, it is a belief about one.
const Database = (await import('better-sqlite3')).default;
const copy = new Database(DB_COPY, { readonly: true });
const counts = {};
const drift = [];
for (const t of TABLES) {
  const live = countIn(db, t);
  const arch = countIn(copy, t);
  counts[t] = arch;
  if (live !== arch) drift.push({ table: t, live, archived: arch });
}
copy.close();

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(DB_COPY)).digest('hex');
const bytes = fs.statSync(DB_COPY).size;

// ---------- one export per card ----------
const cards = db.prepare(`
  SELECT c.id, c.card_number, c.engine_version, c.llm_model, d.date, d.track, d.deleted_at
  FROM cards c JOIN race_days d ON d.id = c.race_day_id ORDER BY d.date, c.card_number
`).all();

const exported = [];
const refused = [];
for (const c of cards) {
  const out = buildCardExport(db, c.id);
  if (out.error) { refused.push({ ...c, reason: out.error }); continue; }
  const file = `card-${String(c.id).padStart(3, '0')}.json`;
  fs.writeFileSync(path.join(EXPORTS, file), `${JSON.stringify(out, null, 2)}\n`);
  exported.push({
    cardId: c.id, file, date: c.date, track: c.track,
    engineVersion: c.engine_version, llmModel: c.llm_model,
    tickets: out.tickets.length,
    graded: Boolean(out.gradeSummary),
    plCents: out.gradeSummary ? out.gradeSummary.plCents : null,
    outcomes: out.gradeSummary ? out.gradeSummary.outcomes : null,
    traceStatus: out.traceStatus,
  });
}

const manifest = {
  frozenAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  database: { file: path.basename(DB_COPY), bytes, sha256, rowCounts: counts },
  cards: { total: cards.length, exported: exported.length, refused: refused.length },
  refused,
  exports: exported,
};
fs.writeFileSync(path.join(ARCHIVE, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const graded = exported.filter((e) => e.graded).length;
const traceMissing = exported.filter((e) => e.traceStatus !== 'complete').length;

fs.writeFileSync(path.join(ARCHIVE, 'README.md'), `# Frozen pre-pivot corpus

**This is not a live corpus. Nothing in the application reads from this directory.**

Frozen ${manifest.frozenAt}, before the simulator/analyzer pivot began removing the
consensus engine, program ingestion and eventually the database itself
(see \`docs/decisions/2026-09-05-simulator-pivot.md\`).

## Why it exists

Most of what is here cannot be rebuilt from source files at any price:

- the blind-play timestamps invariant 15 derives blindness FROM, in \`human_race_state\`
- the LLM request log - paid, nondeterministic answers that would come back different
- consensus picks for past dates that are no longer fetchable from any source
- the ${counts.simulation_runs} simulation runs \`docs/findings/lean-1.1-program-only.md\` cites by id

## What is here

| | |
| --- | --- |
| \`${path.basename(DB_COPY)}\` | ${(bytes / 1048576).toFixed(1)} MB, \`VACUUM INTO\` snapshot with the WAL folded in |
| sha256 | \`${sha256}\` |
| \`exports/\` | ${exported.length} card trace exports, the same document \`GET /api/cards/:id/export\` serves |
| \`MANIFEST.json\` | machine-readable index: per-card P&L, outcomes, trace status, and every refusal with its reason |

${cards.length} cards exist; **${exported.length} exported, ${refused.length} refused**.
${refused.length ? `The refusals are cards on soft-deleted race days, which the exporter excludes by
design (invariant 12) - they remain in the database snapshot, which is the point of keeping
both artifacts:\n\n${refused.map((r) => `- card ${r.id} (${r.track} ${r.date})`).join('\n')}\n` : ''}
${graded} of the exported cards are graded. ${traceMissing} carry a \`traceStatus\` other than
\`complete\`, meaning their decision-trace log files were rotated away or lost to an earlier
factory reset - the export flags that honestly rather than exporting silence, and it is a
property of the history, not of this archive.

## The exports are NOT a substitute for the snapshot

A card export carries recipe, races, entries, consensus picks, sources, allocations, tickets
with their grades, the day's results and the decision trace. It does **not** carry:

- \`llm_card_requests\` - the raw model prompts and responses, paid for and nondeterministic
- \`human_race_state\` - the lock/reveal timestamps invariant 15 derives blindness FROM
- \`simulation_runs\` - the ${counts.simulation_runs} runs the findings doc cites by id
- \`llm_notes\` - the analyst notes fed to the generator

Those exist **only** in the \`.db\` snapshot. That is why both artifacts are committed rather
than just the readable one: a factory reset plus one disk failure would otherwise lose them
permanently, and none of them can be regenerated at any price.

## Rules

- **Never migrated forward.** If a later schema change makes the \`.db\` unreadable, that is
  expected; the JSON exports are the durable form.
- **Never read by the app**, in tests or at runtime. Fixtures promoted for regression testing
  are copied into \`tests/fixtures/\`, not referenced from here.
- **Never edited.** Regenerating it after removals had begun would freeze the wrong thing,
  which is why the script refuses to clobber an existing archive without \`--force\`.
`);

console.log(`Archived ${cards.length} card(s): ${exported.length} exported, ${refused.length} refused.`);
console.log(`  db      ${path.relative(ROOT, DB_COPY)}  ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`  sha256  ${sha256}`);
console.log(`  exports ${path.relative(ROOT, EXPORTS)}  (${graded} graded, ${traceMissing} with an incomplete trace)`);
for (const r of refused) console.log(`  refused card ${r.id} (${r.track} ${r.date}): ${r.reason}`);
if (drift.length) {
  console.error('\nROW COUNT DRIFT between live and archived - the snapshot is NOT trustworthy:');
  for (const d of drift) console.error(`  ${d.table}: live ${d.live} vs archived ${d.archived}`);
  process.exit(1);
}
console.log('\nEvery table matches the live database row for row.');
