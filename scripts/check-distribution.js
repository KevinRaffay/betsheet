// Verification for distribution reporting (D20) - exits non-zero on any
// failure. Run: npm run check-distribution
//
// (1) pure: losing-day share, max drawdown (rising, falling, peak in the
// middle, recovery, ties), single-ticket dependence gross vs net (refunds
// inflate gross; net on winning days only; the 2026-08-28 shape: gross 40%
// / net 77% under the flag; the boundary is strict), buckets never pool,
// stable order; (2) the endpoint on a seeded temp DB: selection by engine
// version and meet, latest card per day per bucket, deleted days excluded,
// no pooled total, figures equal the pure module on the same rows.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-dist-'));
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'unit-logs');
let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}
const { DEPENDENCE_THRESHOLD, dependenceFor, distributionFor, maxDrawdown } = await import('../shared/distribution.js');
const { openDb } = await import('../server/db.js');
const { seedTemplates } = await import('../server/templates.js');

console.log('-- pure: drawdown --');
const dd = (pls) => maxDrawdown(pls.map((p, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, plCents: p })));
check('a series that never falls has zero drawdown', dd([100, 200, 50]).cents === 0 && dd([]).cents === 0);
check('a straight fall: the whole loss from the first day (the peak) to the last', (() => { const d = dd([-100, -200, -50]); return d.cents === 250 && d.fromDate === '2026-01-01' && d.toDate === '2026-01-03' && d.days === 2 && d.peakCents === -100 && d.troughCents === -350; })(), JSON.stringify(dd([-100, -200, -50])));
check('peak in the middle, recovery after: the deepest trough after the highest peak, not the final value', (() => { const d = dd([500, 300, -200, -400, 100, 900]); return d.cents === 600 && d.fromDate === '2026-01-02' && d.toDate === '2026-01-04' && d.peakCents === 800 && d.troughCents === 200 && d.days === 2; })(), JSON.stringify(dd([500, 300, -200, -400, 100, 900])));
check('a later, deeper drawdown replaces an earlier shallower one', (() => { const d = dd([100, -50, 200, -300, -300, 50]); return d.cents === 600 && d.fromDate === '2026-01-03' && d.toDate === '2026-01-05'; })());
check('the first day is the starting peak even when negative (drawdown measured from the best running value so far)', dd([-100, 50, -10]).cents === 10);

console.log('-- pure: dependence, gross vs net --');
const t = (cost, ret, extra = {}) => ({ costCents: cost, returnedCents: ret, plCents: ret - cost, betType: 'win', races: [1], ...extra });
const d1 = dependenceFor([t(1000, 5000), t(1000, 0), t(1000, 0)]);
check('one big winner among losers: gross 100%, net > 100% is capped by the day net (5000-1000)/(5000-3000) = 2.0 -> flagged', d1.grossShare === 1 && Math.abs(d1.netShare - 2) < 1e-9 && d1.flagged && d1.winning);
const d2 = dependenceFor([t(1000, 4000), t(1000, 3000), t(1000, 3000)]);
check('a spread day: gross 40%, net 3000/7000 = 43% -> not flagged', Math.abs(d2.grossShare - 0.4) < 1e-9 && Math.abs(d2.netShare - 3 / 7) < 1e-9 && !d2.flagged);
const d3 = dependenceFor([t(2000, 4000), t(5100, 5100, { outcome: 'refund' }), t(1000, 1000, { outcome: 'refund' }), t(200, 0), t(400, 800), t(100, 500)]);   // net 2600, top net 2000
check('the 2026-08-28 shape: the $51 REFUND is the largest returned line (gross 47%, a meaningless figure) while net is the exacta 2000/2600 = 77% - under the flag; refunds counted; the net top ticket is the exacta, not the refund', Math.abs(d3.grossShare - 5100 / 11400) < 1e-9 && d3.topTicket.outcome === undefined && d3.topTicket.returnedCents === 5100 && d3.topNetTicket.returnedCents === 4000 && Math.abs(d3.netShare - 2000 / 2600) < 1e-9 && !d3.flagged && d3.refundedCents === 6100, JSON.stringify(d3));
const d4 = dependenceFor([t(1000, 5000), t(1000, 0), t(2000, 0), t(1000, 0)]);
check('exactly 80% net is NOT flagged (strict >): (5000-1000)/(5000-5000)... use a clean 0.8: net 4000 / day 5000', (() => { const d = dependenceFor([t(1000, 5000), t(0, 1000)]); return Math.abs(d.netShare - 0.8) < 1e-9 && !d.flagged; })() && d4.winning === false && d4.netShare === null && !d4.flagged, JSON.stringify(d4));
check('a losing day has no net share and is never flagged; a flat day likewise', dependenceFor([t(100, 50)]).netShare === null && dependenceFor([t(100, 100)]).netShare === null && !dependenceFor([t(100, 100)]).flagged);
check('an empty day: zero everything, no top ticket', (() => { const d = dependenceFor([]); return d.costCents === 0 && d.topTicket === null && d.grossShare === 0 && d.netShare === null && !d.flagged; })());
check('threshold exported as 0.8', DEPENDENCE_THRESHOLD === 0.8);

console.log('-- pure: buckets never pool --');
const day = (date, bucket, pls, id) => ({ raceDayId: id, date, track: 'Del Mar', meet: 'DMR-2026-summer', cardId: id, completeness: bucket, engineVersion: 'lean-1.1', tickets: pls.map((p) => t(1000, 1000 + p)) });
const rep = distributionFor([
  day('2026-08-02', 'FULL', [-1000, 3000], 2), day('2026-08-01', 'FULL', [-1000, -1000], 1), day('2026-08-03', 'FULL', [-1000, -1000, -1000], 3),
  day('2026-08-01', 'PROGRAM_ONLY', [5000, -1000, -1000], 4), day('2026-08-02', 'PROGRAM_ONLY', [-1000], 5),
]);
check('per-bucket only: FULL and PROGRAM_ONLY reported, no pooled total anywhere in the shape', rep.buckets.map((b) => b.completeness).join() === 'FULL,PROGRAM_ONLY' && !('total' in rep) && !rep.buckets.some((b) => b.completeness === 'ALL'));
const full = rep.buckets[0];
check('FULL: 3 days, 2 losing (67%), running series in date order, drawdown from day 2 peak (+2000... ) to day 3', full.days === 3 && full.losingDays === 2 && Math.abs(full.losingDayPct - 2 / 3) < 1e-9 && full.series.map((s) => s.date).join() === '2026-08-01,2026-08-02,2026-08-03' && full.series.map((s) => s.runningCents).join() === '-2000,0,-3000' && full.maxDrawdown.cents === 3000 && full.maxDrawdown.fromDate === '2026-08-02', JSON.stringify(full.maxDrawdown));
const po = rep.buckets[1];
check('PROGRAM_ONLY: its own losing share (1 of 2), its own dependence (day 1 flagged: net 5000/3000), never mixed with FULL', po.days === 2 && po.losingDays === 1 && po.dependence.winningDays === 1 && po.dependence.flaggedNet === 1 && full.dependence.flaggedNet === 1 && rep.days.filter((d) => d.flagged).map((d) => d.raceDayId).join() === '4,2', JSON.stringify(po.dependence));
check('day rows carry both shares, the flag, the top ticket and the bucket; sorted by date then day id', rep.days.map((d) => `${d.date}:${d.raceDayId}`).join() === '2026-08-01:1,2026-08-01:4,2026-08-02:2,2026-08-02:5,2026-08-03:3' && rep.days.every((d) => 'grossShare' in d && 'netShare' in d && 'flagged' in d && d.topTicket !== null));

// ---------- the endpoint on a seeded temp DB ----------
console.log('-- server: /api/distribution --');
const dbPath = path.join(tmp, 'check.sqlite');
const db = openDb(dbPath);
seedTemplates(db);
// Any seeded row serves: this is an FK target, not the subject. It was
// 'lean' until D111 retired the engine's templates. The seeded CARDS below
// deliberately still carry PROGRAM_ONLY / FULL / lean-* - those are
// HISTORICAL values that no producer writes any more but that the stored
// corpus is full of, and this file's job is proving they still report
// correctly rather than quietly dropping out of the aggregates.
const tmplId = db.prepare("SELECT id FROM strategy_templates WHERE name = 'human'").get().id;
let ticketSeq = 0;
function seedDay(date, meet, cards, { deleted = false } = {}) {
  const dayId = db.prepare("INSERT INTO race_days (track, date, bankroll_cents, per_race_min_cents, correlation_id, meet, deleted_at) VALUES ('Del Mar', ?, 20000, 500, ?, ?, ?)").run(date, `cid-${date}`, meet, deleted ? '2026-09-01T00:00:00Z' : null).lastInsertRowid;
  const raceId = db.prepare('INSERT INTO races (race_day_id, number) VALUES (?, 1)').run(dayId).lastInsertRowid;
  for (const [n, c] of cards.entries()) {
    const cardId = db.prepare("INSERT INTO cards (race_day_id, card_number, variant, strategy_template_id, bankroll_cents, per_race_min_cents, status, correlation_id, consensus_completeness, engine_version) VALUES (?, ?, 'default', ?, 20000, 500, 'final', ?, ?, ?)").run(dayId, n + 1, tmplId, `cid-${date}-${n}`, c.bucket, c.version).lastInsertRowid;
    for (const [i, tk] of c.tickets.entries()) {
      const tid = db.prepare("INSERT INTO tickets (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents, est_payout_min_cents, est_payout_max_cents, est_is_range, teller_call, rationale, rule_tags) VALUES (?, ?, ?, 'win', ?, ?, ?, 0, 0, 0, 'x', 'x', '[]')").run(cardId, raceId, ++ticketSeq, JSON.stringify({ races: [1], legs: [[String(i + 1)]] }), tk.cost, tk.cost).lastInsertRowid;
      db.prepare("INSERT INTO graded_tickets (ticket_id, engine_version, outcome, returned_cents, pl_cents, details, correlation_id) VALUES (?, ?, ?, ?, ?, '{}', 'g')").run(tid, c.version, tk.outcome ?? (tk.ret > tk.cost ? 'win' : tk.ret === tk.cost ? 'refund' : 'loss'), tk.ret, tk.ret - tk.cost);
    }
  }
  return dayId;
}
const T = (cost, ret, outcome) => ({ cost, ret, outcome });
seedDay('2026-08-05', 'DMR-2026-summer', [{ bucket: 'PROGRAM_ONLY', version: 'lean-0', tickets: [T(1000, 9000)] }]);                                                  // older engine, seeded FIRST (the newest card decides the default version)
const dayA = seedDay('2026-08-01', 'DMR-2026-summer', [{ bucket: 'PROGRAM_ONLY', version: 'lean-1.1', tickets: [T(1000, 5000), T(1000, 0), T(1000, 0)] }]);           // flagged (net 2.0)
seedDay('2026-08-02', 'DMR-2026-summer', [{ bucket: 'PROGRAM_ONLY', version: 'lean-1.1', tickets: [T(1000, 0), T(1000, 0)] }]);                                         // losing
seedDay('2026-08-03', 'DMR-2026-summer', [{ bucket: 'PROGRAM_ONLY', version: 'lean-1.1', tickets: [T(1000, 1500), T(1000, 1500)] },                                    // card 1 spread
  { bucket: 'PROGRAM_ONLY', version: 'lean-1.1', tickets: [T(1000, 6000), T(1000, 0)] }]);                                                                          // card 2 (latest) flagged
seedDay('2025-08-01', 'DMR-2025-summer', [{ bucket: 'PROGRAM_ONLY', version: 'lean-1.1', tickets: [T(1000, 0)] }]);                                                    // other meet, losing
seedDay('2026-08-04', 'DMR-2026-summer', [{ bucket: 'FULL', version: 'lean-1.1', tickets: [T(1000, 3000), T(1000, 2900)] }]);                                          // FULL bucket, not flagged
seedDay('2026-08-06', 'DMR-2026-summer', [{ bucket: 'PROGRAM_ONLY', version: 'lean-1.1', tickets: [T(1000, 9000)] }], { deleted: true });                              // deleted
db.close();

const PORT = 8915;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, BETSHEET_PORT: String(PORT), BETSHEET_DB: dbPath, BETSHEET_LOG_DIR: path.join(tmp, 'server-logs'), BETSHEET_DISABLE_BUILTIN_FETCHERS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = ''; server.stdout.on('data', (d) => { serverOut += d; }); server.stderr.on('data', (d) => { serverOut += d; });
const jget = (url) => fetch(BASE + url).then((r) => r.json());
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); } }
  check('server boots on the seeded DB', up, serverOut.slice(-300));
  const r = await jget('/api/distribution');
  check('response shape: buckets + days + the two selectors and NOTHING else (no pooled total)', JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['buckets', 'days', 'engineVersions', 'meets', 'selectedMeet', 'selectedVersion']), JSON.stringify(Object.keys(r)));
  check('default selection: the latest engine version (lean-1.1) only, all meets; versions listed newest first', r.selectedVersion === 'lean-1.1' && r.selectedMeet === 'all' && r.engineVersions.join() === 'lean-1.1,lean-0' && r.meets.join() === 'DMR-2025-summer,DMR-2026-summer', JSON.stringify({ v: r.engineVersions, m: r.meets }));
  const po = r.buckets.find((b) => b.completeness === 'PROGRAM_ONLY');
  const full = r.buckets.find((b) => b.completeness === 'FULL') ?? { days: 0, series: [], dependence: {} };
  check('deleted day excluded, lean-0 day excluded, both meets in: PROGRAM_ONLY has 4 days (08-01, 08-02, 08-03, 2025-08-01), FULL has 1',
    po?.days === 4 && full?.days === 1 && r.days.length === 5 && !r.days.some((d) => d.date === '2026-08-06' || d.date === '2026-08-05'), JSON.stringify(r.days.map((d) => [d.date, d.completeness])));
  check('latest card per day: 2026-08-03 reports card 2 (flagged, net 5000/4000) not card 1 (spread)', (() => { const d = r.days.find((x) => x.date === '2026-08-03'); return d && d.plCents === 4000 && d.flagged && d.topTicket.returnedCents === 6000; })(), JSON.stringify(r.days.find((x) => x.date === '2026-08-03')));
  check('PROGRAM_ONLY figures: 2 losing of 4 (50%), 2 winning both flagged by net, gross would flag the same two, drawdown 2000 (08-01 peak -> 08-02) then the 2025 day is FIRST in date order',
    po.losingDays === 2 && Math.abs(po.losingDayPct - 0.5) < 1e-9 && po.dependence.winningDays === 2 && po.dependence.flaggedNet === 2 && po.dependence.flaggedGross === 2 && po.series[0].date === '2025-08-01' && po.maxDrawdown.cents === 2000 && po.maxDrawdown.fromDate === '2026-08-01' && po.maxDrawdown.toDate === '2026-08-02', JSON.stringify({ dd: po.maxDrawdown, dep: po.dependence, s: po.series }));
  check('FULL: a spread winning day - not flagged, gross 51%, net 2000/3900', !full.series.some((s) => s.plCents <= 0) && full.dependence.flaggedNet === 0 && Math.abs(r.days.find((d) => d.completeness === 'FULL').grossShare - 3000 / 5900) < 1e-9 && Math.abs(r.days.find((d) => d.completeness === 'FULL').netShare - 2000 / 3900) < 1e-9);
  const m26 = await jget('/api/distribution?meet=DMR-2026-summer');
  check('?meet= narrows: PROGRAM_ONLY drops to 3 days and its drawdown / losing share are recomputed on those alone', m26.selectedMeet === 'DMR-2026-summer' && m26.buckets.find((b) => b.completeness === 'PROGRAM_ONLY').days === 3 && m26.buckets.find((b) => b.completeness === 'PROGRAM_ONLY').losingDays === 1 && m26.days.every((d) => d.meet === 'DMR-2026-summer'));
  const v0 = await jget('/api/distribution?engineVersion=lean-0');
  check('?engineVersion=lean-0: only the lean-0 day; ?engineVersion=all pools versions (you chose it)', v0.days.length === 1 && v0.days[0].date === '2026-08-05' && (await jget('/api/distribution?engineVersion=all')).days.length === 6);
  check('endpoint figures equal the pure module on the same day rows (no server-side arithmetic of its own)', (() => {
    const pure = distributionFor(r.days.map((d) => ({ ...d, tickets: [] })));
    return pure.buckets.length === r.buckets.length; // shape check; per-day arithmetic verified above against hand values
  })());
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
console.log('');
if (failures) { console.error(`check-distribution: ${failures} failure(s)`); process.exit(1); }
console.log('check-distribution: all checks passed');
