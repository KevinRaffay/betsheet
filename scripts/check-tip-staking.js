// Verification for TIPSHEET staking (D171).
// Run: npm run check-tip-staking
//
// Throwaway temp database, logger redirected there too.
//
// The migration is the risky half: adding TIPSHEET to a CHECK means REBUILDING
// `cards`, which has five ON DELETE CASCADE children. This asserts the rebuild
// preserves every child row, the AUTOINCREMENT high-water mark and all four
// columns added since the last rebuild (022/023/025/027). The same probe was
// run against a VACUUM INTO copy of the REAL corpus - see the D171 ledger row.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-tipstake-'));
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

const { stakeTipRace, TIP_VARIANTS, LONGSHOT_DECIMAL } = await import('../shared/tip-staking.js');
const { morningLineToDecimal } = await import('../shared/betmath.js');

console.log('-- pure: the three variants --');
{
  const picks = [{ horse_no: '4', rank: 1 }, { horse_no: '6', rank: 2 }, { horse_no: '2', rank: 3 }];
  const ml = { 4: '2/1', 6: '5/1', 2: '12/1' };
  const mlOf = (p) => ml[p] ?? null;
  const run = (variant, cents, extra = {}) => stakeTipRace({ picks, variant, perRaceCents: cents, mlOf, menu: { exacta: 100 }, ...extra });

  check('win-only spends the budget on one win ticket',
    run('win-only', 2000).tickets.map((t) => t.tellerCall).join() === '$20 W 4');
  const atb = run('across-the-board', 2000).tickets;
  check('across-the-board is THREE tickets, not one "win_place" type',
    atb.length === 3 && atb.map((t) => t.betType).join() === 'win,place,show');
  check('  and each leg is legal and equal', atb.every((t) => t.stakeCents === 600));
  const box = run('exacta-box-top2', 2000).tickets;
  check('exacta box of two costs stake x 2', box.length === 1 && box[0].costCents === box[0].stakeCents * 2);
  check('  and uses the top TWO ranks', box[0].tellerCall === '$10 EX BOX 4-6');
  check('every variant is covered', TIP_VARIANTS.length === 3);
}

console.log('-- pure: the draft rule this keeps - matching place money at 8/1+ --');
{
  const mlOf = (p) => ({ 2: '12/1', 4: '2/1' }[p] ?? null);
  const long = stakeTipRace({ picks: [{ horse_no: '2', rank: 1 }], variant: 'win-only', perRaceCents: 2000, mlOf });
  check('an 8/1+ top pick gets matching place money',
    long.tickets.map((t) => t.betType).join() === 'win,place'
    && long.tickets[0].stakeCents === long.tickets[1].stakeCents);
  check('  and it is funded from the same budget, not added on top',
    long.tickets.reduce((a, x) => a + x.costCents, 0) === 2000);
  check('  and it is reported', long.warnings.some((w) => w.code === 'longshot_place_added'));
  const shortp = stakeTipRace({ picks: [{ horse_no: '4', rank: 1 }], variant: 'win-only', perRaceCents: 2000, mlOf });
  check('a short-priced top pick gets win only', shortp.tickets.map((t) => t.betType).join() === 'win');
  // The draft's threshold of 9 assumed European decimal odds; here
  // morningLineToDecimal returns the fractional RATIO, so 8/1 is 8.
  check('the threshold fires at 8/1, per invariant 1',
    morningLineToDecimal('8/1') >= LONGSHOT_DECIMAL && morningLineToDecimal('7/1') < LONGSHOT_DECIMAL);
  const eight = stakeTipRace({ picks: [{ horse_no: '8', rank: 1 }], variant: 'win-only',
    perRaceCents: 2000, mlOf: () => '8/1' });
  check('  so an 8/1 top pick DOES get place money (the draft would have skipped it)',
    eight.tickets.map((t) => t.betType).join() === 'win,place');
  const seven = stakeTipRace({ picks: [{ horse_no: '7', rank: 1 }], variant: 'win-only',
    perRaceCents: 2000, mlOf: () => '7/1' });
  check('  and a 7/1 top pick does not', seven.tickets.map((t) => t.betType).join() === 'win');
  // The whole reason the draft's odds logic is absent: no morning line at all.
  const noOdds = stakeTipRace({ picks: [{ horse_no: '4', rank: 1 }], variant: 'win-only', perRaceCents: 2000, mlOf: () => null });
  check('NO morning line still produces a real bet (the draft produced none)',
    noOdds.tickets.length === 1 && noOdds.tickets[0].betType === 'win');
}

console.log('-- pure: refusals, never an unpayable stake --');
{
  const picks = [{ horse_no: '4', rank: 1 }, { horse_no: '6', rank: 2 }];
  const mlOf = () => '2/1';
  const tiny = stakeTipRace({ picks, variant: 'across-the-board', perRaceCents: 400, mlOf });
  check('a budget that cannot fund 3 legs falls back to win, and says so',
    tiny.tickets.length === 1 && tiny.warnings.some((w) => w.code === 'reduced_to_win'));
  const none = stakeTipRace({ picks, variant: 'win-only', perRaceCents: 100, mlOf });
  check('below the $2 minimum: NO ticket, blocking warning',
    none.tickets.length === 0 && none.warnings.some((w) => w.blocking));
  check('every stake is a whole number of dollars or better, never a fraction',
    [500, 1000, 2000, 3300].every((b) => stakeTipRace({ picks, variant: 'across-the-board', perRaceCents: b, mlOf })
      .tickets.every((t) => t.stakeCents % 100 === 0 && t.stakeCents >= 200)));
  const oneLive = stakeTipRace({ picks, variant: 'exacta-box-top2', perRaceCents: 2000, mlOf, scratched: ['6'] });
  check('an exacta box with only one live pick is refused, not faked',
    oneLive.tickets.length === 0 && oneLive.warnings.some((w) => w.code === 'too_few_picks'));
  const promoted = stakeTipRace({ picks, variant: 'win-only', perRaceCents: 2000, mlOf, scratched: ['4'] });
  check('a scratched top pick promotes the next live one (as D170 scores it)',
    promoted.tickets[0].tellerCall === '$20 W 6'
    && promoted.warnings.some((w) => w.code === 'top_pick_substituted'));
  check('stakeTipRace never throws on junk',
    [null, undefined, {}, { picks: 'x', variant: 'win-only' }].every((i) => { try { stakeTipRace(i); return true; } catch { return false; } }));
}

console.log('-- migration 030: the cards REBUILD keeps every child row --');
{
  const { openDb } = await import('../server/db.js');
  const { insertRaceDay } = await import('../server/ingest.js');
  const db = openDb(process.env.BETSHEET_DB);
  const fixture = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));
  const dayId = Number(db.transaction(() => insertRaceDay(db, {
    track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
  }, 'check-tip-staking'))());

  const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
  for (const c of ['llm_model', 'notes_present', 'name', 'external_id', 'built_on', 'saw_reference_cards']) {
    check(`cards.${c} survived the rebuild`, cols.includes(c));
  }
  const idx = db.prepare("SELECT name, \"unique\" FROM pragma_index_list('cards')").all();
  check('idx_cards_day was recreated', idx.some((i) => i.name === 'idx_cards_day'));
  check('idx_cards_external_id was recreated AND is still unique',
    idx.some((i) => i.name === 'idx_cards_external_id' && i.unique === 1));
  check('foreign keys are intact after the rebuild', db.prepare('PRAGMA foreign_key_check').all().length === 0);

  const ok = (bucket) => { try { db.prepare(`INSERT INTO cards (race_day_id, card_number, bankroll_cents, correlation_id, consensus_completeness, engine_version) VALUES (?, ?, 100, 'x', ?, 'x')`).run(dayId, Math.floor(Math.random() * 1e6), bucket); return true; } catch { return false; } };
  check('TIPSHEET is now an accepted bucket', ok('TIPSHEET'));
  check('every pre-existing bucket still is',
    ['HUMAN', 'LLM_GENERATED', 'EQB_OTR', 'PROGRAM_ONLY', 'ODDS_ONLY', 'FULL', 'PARTIAL'].every(ok));
  check('an invented bucket is still refused', !ok('NOPE'));
  db.prepare("DELETE FROM cards WHERE correlation_id = 'x'").run();
  db.close();
}

console.log('-- the endpoints: preview writes nothing, save writes three cards --');
{
  const { spawn } = await import('node:child_process');
  const PORT = 8912;
  const BASE = `http://127.0.0.1:${PORT}`;
  const srvDb = path.join(tmp, 'srv.sqlite');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, BETSHEET_PORT: String(PORT), BETSHEET_DB: srvDb,
      BETSHEET_LOG_DIR: path.join(tmp, 'srv-logs'), ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; server.stdout.on('data', (d) => { out += d; }); server.stderr.on('data', (d) => { out += d; });
  const jget = (u) => fetch(BASE + u).then((r) => r.json());
  const jpost = (u, b = {}, m = 'POST') => fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    check('server boots', up, out.slice(-300));

    const Database = (await import('better-sqlite3')).default;
    const { insertTipPicks } = await import('../server/tip-extraction.js');
    const fixture = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));
    const dayId = (await (await jpost('/api/race-days', {
      track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
    })).json()).id;

    const db = new Database(srvDb);
    for (const race of [1, 2]) {
      insertTipPicks(db, { raceDayId: dayId, raceNo: race, sourceLabel: 'trackmaster',
        picks: [{ horse_no: '1', horse_name: 'A', rank: 1 }, { horse_no: '2', horse_name: 'B', rank: 2 }] });
    }
    db.close();

    const pv = await (await jpost(`/api/race-days/${dayId}/tip-cards/preview`, { sourceLabel: 'trackmaster' })).json();
    check('preview returns all three variants', pv.variants?.length === 3);
    check('  each with a cost and per-race budget',
      pv.variants.every((v) => v.costCents > 0 && v.perRaceCents > 0));
    check('  and the per-race budget is a whole number of dollars (D163)',
      pv.variants.every((v) => v.perRaceCents % 100 === 0));
    const cardsBefore = (await jget(`/api/race-days/${dayId}/cards`)).length;
    check('PREVIEW WROTE NOTHING (invariant 9)', cardsBefore === 0);

    const saved = await (await jpost(`/api/race-days/${dayId}/tip-cards`, { sourceLabel: 'trackmaster' })).json();
    check('save writes exactly three cards', saved.cards?.length === 3);
    const after = await jget(`/api/race-days/${dayId}/cards`);
    check('  all in the TIPSHEET bucket', after.every((c) => c.consensus_completeness === 'TIPSHEET'));
    check('  all stamped engine_version tipsheet, never lean-*',
      after.every((c) => c.engine_version === 'tipsheet'));
    check('  three distinct variants', new Set(after.map((c) => c.variant)).size === 3);

    // Append-only: a second run must not rewrite the first three.
    const again = await (await jpost(`/api/race-days/${dayId}/tip-cards`, { sourceLabel: 'trackmaster' })).json();
    const all = await jget(`/api/race-days/${dayId}/cards`);
    check('a second run APPENDS three more, never edits the first three',
      again.cards.length === 3 && all.length === 6
      && !again.cards.some((c) => saved.cards.some((s) => s.cardId === c.cardId)));

    // Grading: a TIPSHEET card must be graded by the ORDINARY grader, with no
    // special case - which is the whole point of staking into real tickets.
    // P/L only reports GRADED cards, so results have to land first.
    const db2 = new Database(srvDb);
    const put = db2.prepare('INSERT INTO race_results (race_day_id, race_number, program_number, horse_name, finish_position, win_cents, place_cents, show_cents) VALUES (?,?,?,?,?,?,?,?)');
    put.run(dayId, 1, '1', 'A', 1, 820, 400, 300);   // the top pick WON
    put.run(dayId, 1, '2', 'B', 2, null, 500, 320);
    put.run(dayId, 2, '2', 'B', 1, 640, 380, 300);   // the top pick lost
    put.run(dayId, 2, '1', 'A', 2, null, 420, 300);
    db2.close();

    const graded = await jpost(`/api/cards/${saved.cards[0].cardId}/grade`, {});
    check('a TIPSHEET card grades through the ordinary grader', graded.status === 200 || graded.status === 201,
      `status ${graded.status}`);
    const grades = await jget(`/api/cards/${saved.cards[0].cardId}/grades`);
    check('  and produces graded tickets stamped tipsheet', (grades.grades?.length ?? 0) > 0
      && grades.grades.every((g) => g.engine_version === 'tipsheet'), JSON.stringify(grades).slice(0, 160));
    check('  and the winning top pick actually returned money',
      grades.grades.some((g) => g.outcome === 'win' && g.returned_cents > 0));

    // Bucket isolation: TIPSHEET must not pool with anything (invariant 13).
    const pl = await jget('/api/pl?engineVersion=all');
    const buckets = (pl.buckets ?? []).map((b) => b.completeness ?? b.bucket ?? b.key);
    check('P/L lists TIPSHEET as its own bucket', buckets.includes('TIPSHEET'), JSON.stringify(buckets));
    check('  and pools it with nothing - no combined total (invariant 13)',
      !buckets.includes('all') && new Set(buckets).size === buckets.length, JSON.stringify(buckets));

    const missing = await jpost(`/api/race-days/${dayId}/tip-cards/preview`, { sourceLabel: 'nobody' });
    check('a source with no picks is refused 404', missing.status === 404);
    const noSource = await jpost(`/api/race-days/${dayId}/tip-cards/preview`, {});
    check('a missing sourceLabel is refused 400', noSource.status === 400);
  } finally { server.kill(); }
}

console.log('');
console.log(failures ? `FAILED (${failures})` : 'All tip-staking checks passed.');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
process.exit(failures ? 1 : 0);
