// Verification for server/db.js + server/migrations - exits non-zero on any
// failure. Run: npm run check-schema
//
// Exercises behaviors: migration application and idempotence, the
// tamper guard, FK enforcement, CHECK and UNIQUE constraints, cascade
// deletes, and one smoke insert through the whole table graph - every table
// the schema declares gets at least one row written and read back.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-dbcheck-'));
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');
const dbPath = path.join(tmp, 'check.sqlite');

const { openDb } = await import('../server/db.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}
function throws(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

// --- migration application ---

const db = openDb(dbPath);

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
).all().map((r) => r.name).sort();

const expected = [
  'actual_stakes', 'allocations', 'cards', 'consensus_picks', 'entries',
  'exotic_payoffs', 'fetch_attempts', 'graded_tickets', 'publishes',
  'race_days', 'race_results', 'races', 'result_charts', 'result_scratches',
  'schema_migrations', 'simulation_results', 'simulation_runs', 'sources',
  'strategy_templates', 'tickets',
];
check('all expected tables exist',
  JSON.stringify(tables) === JSON.stringify(expected),
  `missing: ${expected.filter((t) => !tables.includes(t))}; extra: ${tables.filter((t) => !expected.includes(t))}`);

check('foreign keys are ON', db.pragma('foreign_keys', { simple: true }) === 1);
check('WAL mode', db.pragma('journal_mode', { simple: true }) === 'wal');

// --- idempotence: re-open applies nothing new ---
const count1 = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
db.close();
const db2 = openDb(dbPath);
const count2 = db2.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
check('re-open is idempotent', count1 === count2, `${count1} -> ${count2}`);

// --- tamper guard: a changed recorded digest must refuse to open ---
db2.prepare("UPDATE schema_migrations SET sha256 = 'tampered'").run();
db2.close();
const tamperErr = throws(() => openDb(dbPath));
check('tampered migration digest refuses to open',
  tamperErr && /append-only/.test(tamperErr.message), tamperErr?.message);

// --- line-ending churn must self-heal, not refuse (the Windows autocrlf
// false alarm: same content, CRLF instead of LF, hit in live use) ---
{
  const crypto = await import('node:crypto');
  const db3path = path.join(tmp, 'check3.sqlite');
  const db3 = openDb(db3path);
  const mig = fs.readdirSync(path.join(process.cwd(), 'server', 'migrations'))
    .filter((f) => f.endsWith('.sql')).sort()[0];
  const sql = fs.readFileSync(path.join(process.cwd(), 'server', 'migrations', mig), 'utf8');
  const lf = sql.replace(/\r\n/g, '\n');
  const crlfHash = crypto.createHash('sha256').update(lf.replace(/\n/g, '\r\n')).digest('hex');
  const canonicalHash = crypto.createHash('sha256').update(lf).digest('hex');
  db3.prepare('UPDATE schema_migrations SET sha256 = ? WHERE name = ?').run(crlfHash, mig);
  db3.close();
  const healErr = throws(() => { const h = openDb(db3path); h.close(); });
  check('line-ending variant of an applied migration self-heals', healErr === null,
    healErr?.message);
  const db3b = openDb(db3path);
  check('self-heal rewrites the record to the canonical hash',
    db3b.prepare('SELECT sha256 FROM schema_migrations WHERE name = ?').get(mig).sha256 === canonicalHash);
  db3b.close();
}

// Fresh db (separate file) for the rest.
const d = openDb(path.join(tmp, 'check2.sqlite'));

// --- constraints ---

check('FK: race with unknown race_day rejected',
  !!throws(() => d.prepare('INSERT INTO races (race_day_id, number) VALUES (999, 1)').run()));

const day = d.prepare(`INSERT INTO race_days (track, date, bankroll_cents, per_race_min_cents, correlation_id)
  VALUES ('Del Mar', '2026-08-30', 20000, 500, 'cid-check')`).run().lastInsertRowid;

check('CHECK: invalid classification rejected',
  !!throws(() => d.prepare(
    "INSERT INTO races (race_day_id, number, classification) VALUES (?, 1, 'SURE_THING')",
  ).run(day)));

const race = d.prepare(
  "INSERT INTO races (race_day_id, number, post_time, distance, surface, race_type, classification, classification_source_count) VALUES (?, 1, '14:00', '6f', 'dirt', 'maiden claiming', 'SPLIT', 1)",
).run(day).lastInsertRowid;

check('UNIQUE: duplicate race number in a day rejected',
  !!throws(() => d.prepare('INSERT INTO races (race_day_id, number) VALUES (?, 1)').run(day)));

// --- smoke insert through the whole graph ---

const e1 = d.prepare(`INSERT INTO entries (race_id, program_number, post_position, horse_name,
  morning_line, morning_line_decimal, jockey, trainer, weight, program_rank, best_bet)
  VALUES (?, '1A', 1, 'Fast Idea', '5/2', 2.5, 'U. Rispoli', 'P. Miller', 122, 1, 1)`).run(race).lastInsertRowid;

check('coupled entry program numbers are TEXT', typeof d.prepare(
  'SELECT program_number FROM entries WHERE id = ?').get(e1).program_number === 'string');

const src = d.prepare(
  "INSERT INTO sources (name, kind, url_template) VALUES ('dmtc picks', 'track_picks', 'https://example/{date}')",
).run().lastInsertRowid;

d.prepare(`INSERT INTO fetch_attempts (race_day_id, source_id, url, http_status, outcome, bytes, parse_ok, picks_extracted, correlation_id)
  VALUES (?, ?, 'https://example/2026-08-30', 200, 'ok', 5120, 1, 16, 'cid-check')`).run(day, src);

d.prepare(`INSERT INTO consensus_picks (race_id, source_id, entry_id, program_number, horse_name, pick_type)
  VALUES (?, ?, ?, '1A', 'Fast Idea', 'top')`).run(race, src, e1);

const tpl = d.prepare(
  `INSERT INTO strategy_templates (name, rules) VALUES ('lean', '{"placeMoneyRule":true}')`,
).run().lastInsertRowid;

const card = d.prepare(`INSERT INTO cards (race_day_id, card_number, variant, strategy_template_id, bankroll_cents, per_race_min_cents, status, correlation_id)
  VALUES (?, 1, 'default', ?, 20000, 500, 'final', 'cid-check')`).run(day, tpl).lastInsertRowid;

check('cards: per-day card_number is unique',
  !!throws(() => d.prepare(`INSERT INTO cards (race_day_id, card_number, variant, bankroll_cents, correlation_id)
    VALUES (?, 1, 'other', 20000, 'cid-dup')`).run(day)));

check('completeness: defaults to the honest floor (PROGRAM_ONLY)',
  d.prepare('SELECT consensus_completeness c FROM cards WHERE id = ?').get(card).c === 'PROGRAM_ONLY');
check('completeness: CHECK rejects an unknown level',
  !!throws(() => d.prepare(
    "UPDATE cards SET consensus_completeness = 'MOSTLY_VIBES' WHERE id = ?",
  ).run(card)));
d.prepare("UPDATE cards SET consensus_completeness = 'FULL' WHERE id = ?").run(card);
check('completeness: valid level accepted',
  d.prepare('SELECT consensus_completeness c FROM cards WHERE id = ?').get(card).c === 'FULL');

d.prepare(`INSERT INTO allocations (card_id, race_id, amount_cents, confidence, rule)
  VALUES (?, ?, 4000, 'SPLIT', 'mid_confidence_split')`).run(card, race);

const ticket = d.prepare(`INSERT INTO tickets (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents,
  est_payout_min_cents, est_payout_max_cents, est_is_range, teller_call, rule_tags)
  VALUES (?, ?, 1, 'win', '[["1A"]]', 1500, 1500, 5250, 5250, 0, 'Race 1, $15 win, 1A', '["place_money_rule"]')`).run(card, race).lastInsertRowid;

d.prepare(`INSERT INTO result_charts (race_day_id, source_kind, raw_digest, correlation_id)
  VALUES (?, 'paste', 'abc123', 'cid-check')`).run(day);

d.prepare(`INSERT INTO race_results (race_day_id, race_number, program_number, horse_name, finish_position, win_cents, place_cents, show_cents)
  VALUES (?, 1, '1A', 'Fast Idea', 1, 700, 340, 260)`).run(day);

d.prepare(`INSERT INTO exotic_payoffs (race_day_id, race_number, bet_type, base_cents, combination, payout_cents)
  VALUES (?, 1, 'exacta', 100, '1A-5', 4180)`).run(day);

d.prepare(`INSERT INTO result_scratches (race_day_id, race_number, program_number, horse_name)
  VALUES (?, 1, '6', 'Late Scratch')`).run(day);

d.prepare(`INSERT INTO graded_tickets (ticket_id, outcome, returned_cents, pl_cents, correlation_id)
  VALUES (?, 'win', 5250, 3750, 'cid-check')`).run(ticket);

const run = d.prepare(`INSERT INTO simulation_runs (strategy_template_id, params, summary)
  VALUES (?, '{"bankroll":20000}', '{"net":3750}')`).run(tpl).lastInsertRowid;

d.prepare(`INSERT INTO simulation_results (run_id, race_day_id, pl_cents)
  VALUES (?, ?, 3750)`).run(run, day);

d.prepare(`INSERT INTO publishes (card_id, slug, url, mode, outcome, expires_at)
  VALUES (?, 'delmar-0830', 'https://here.now/delmar-0830', 'anonymous', 'ok', '2026-08-31T18:00:00Z')`).run(card);

d.prepare(`INSERT INTO actual_stakes (ticket_id, planned_cents, actual_cents)
  VALUES (?, 1500, 1500)`).run(ticket);

const joined = d.prepare(`
  SELECT rd.track, r.number, t.teller_call, gt.pl_cents
  FROM graded_tickets gt
  JOIN tickets t ON t.id = gt.ticket_id
  JOIN cards c ON c.id = t.card_id
  JOIN race_days rd ON rd.id = c.race_day_id
  JOIN races r ON r.id = t.race_id
  WHERE c.correlation_id = 'cid-check'
`).get();
check('join across the graph returns the graded ticket',
  joined && joined.track === 'Del Mar' && joined.pl_cents === 3750 &&
  joined.teller_call === 'Race 1, $15 win, 1A');

// --- race-day ids are NEVER reused (the live tombstone-supersession bug:
// delete max row -> plain rowid allocation hands the next insert the same
// id, and the decision trace goes ambiguous) ---
{
  const a = d.prepare(`INSERT INTO race_days (track, date, correlation_id)
    VALUES ('Reuse Check', '2026-01-01', 'cid-a')`).run().lastInsertRowid;
  d.prepare('DELETE FROM race_days WHERE id = ?').run(a);
  const b = d.prepare(`INSERT INTO race_days (track, date, correlation_id)
    VALUES ('Reuse Check', '2026-01-01', 'cid-b')`).run().lastInsertRowid;
  check('race_day ids are monotonic - a hard-deleted id is never reissued',
    Number(b) > Number(a), `first=${a} second=${b}`);
  d.prepare('DELETE FROM race_days WHERE id = ?').run(b);
}

// --- cascade delete: removing the day removes its dependents ---
d.prepare('DELETE FROM race_days WHERE id = ?').run(day);
const leftovers = ['races', 'entries', 'fetch_attempts', 'consensus_picks', 'cards',
  'allocations', 'tickets', 'graded_tickets', 'race_results', 'exotic_payoffs',
  'result_scratches', 'result_charts', 'simulation_results', 'publishes', 'actual_stakes']
  .map((t) => [t, d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c])
  .filter(([, c]) => c > 0);
check('cascade: deleting the race day empties every dependent table',
  leftovers.length === 0, `leftovers: ${leftovers.map(([t, c]) => `${t}=${c}`).join(', ')}`);

d.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\ncheck-schema: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-schema: all checks passed');
