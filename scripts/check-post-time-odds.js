// Verification for PT-1 (D229): the chart's post-time odds, stored and used.
// Run: npm run check-post-time-odds
//
// Three things are being proved, in increasing order of how much they matter.
//
// 1. The columns exist and `saveResults` fills them from a REAL chart.
// 2. The numbers are RIGHT - cross-checked against a quantity the chart states
//    independently. A winner's $2 win payout and its odds are printed by
//    Equibase in different places from different fields, and they must agree:
//    `win_cents / 200 - 1` is the odds, up to breakage (tracks round payouts
//    down to the dime). Nothing else in this codebase can catch a column read
//    off by one, and the D116 trap - a 12-column claiming race shifting every
//    field by one - is exactly that bug in the parser next door.
// 3. The measurement it unlocks is arithmetically sound: implied probabilities
//    normalise to 1, and `closeEdge` is NULL rather than 0 when no board was
//    read.
//
// The re-save assertion is the one a person will actually depend on: filling
// these columns for a stored day means uploading its chart AGAIN, so a re-save
// must add the odds without disturbing the grades already on that day.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseChart } from '../shared/chart-parser.js';
import { aggregatePickScores, impliedProbabilities, marketBaseline, scorePickRace } from '../shared/pick-scoring.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-ptodds-'));
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};
const close = (a, b, eps) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
console.log('\npost-time odds - the real chart');

const chartText = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'charts', 'dmr-2026-08-30.txt'), 'utf8');
const chart = parseChart(chartText);
const finishersAll = chart.races.flatMap((r) => r.results ?? []);

check('every finisher carries a numeric price',
  finishersAll.length > 0 && finishersAll.every((f) => typeof f.odds === 'number' && Number.isFinite(f.odds)),
  `${finishersAll.filter((f) => typeof f.odds !== 'number').length} without`);
check('exactly one favorite per race - the chart asserts it, we never derive it',
  chart.races.every((r) => (r.results ?? []).filter((f) => f.favorite).length === 1));
check('the favorite is never a longer price than a non-favorite in its own race',
  chart.races.every((r) => {
    const fav = (r.results ?? []).find((f) => f.favorite);
    return fav && (r.results ?? []).every((f) => f.favorite || f.odds >= fav.odds);
  }));

// The cross-check: two independently printed chart fields must agree.
{
  const winners = chart.races.flatMap((r) => (r.results ?? [])
    .filter((f) => f.finishPosition === 1 && typeof f.winCents === 'number'));
  // Breakage: a $2 payout is rounded DOWN to the dime, so the derived odds can
  // sit up to $0.10/2 = 0.05 BELOW the printed odds, never meaningfully above.
  const bad = winners.filter((f) => !close(f.winCents / 200 - 1, f.odds, 0.06));
  check(`winner odds agree with the winner's own $2 payout on all ${winners.length} races (breakage only)`,
    winners.length === chart.races.length && bad.length === 0,
    JSON.stringify(bad.map((f) => ({ pgm: f.programNumber, odds: f.odds, win: f.winCents }))));
}

// ---------------------------------------------------------------------------
console.log('\npost-time odds - the market arithmetic');

{
  const race = chart.races[0].results.map((f) => ({ programNumber: f.programNumber, postTimeOdds: f.odds, favorite: f.favorite }));
  const implied = impliedProbabilities(race);
  check('implied probabilities normalise to exactly 1 - the takeout is removed',
    close([...implied.values()].reduce((a, b) => a + b, 0), 1, 1e-9));
  check('every implied probability is strictly between 0 and 1',
    [...implied.values()].every((p) => p > 0 && p < 1));
  const raw = race.reduce((a, f) => a + 1 / (1 + f.postTimeOdds), 0);
  check('the RAW book is overround (>1), which is why normalising is required, not cosmetic',
    raw > 1, String(raw.toFixed(3)));
  check('the shortest price carries the largest probability',
    [...implied.entries()].sort((a, b) => b[1] - a[1])[0][0]
    === race.slice().sort((a, b) => a.odds - b.odds)[0].programNumber);
}
check('no priced finisher -> NULL, never an empty map (a board never read is not a board of zeros)',
  impliedProbabilities([{ programNumber: '1', postTimeOdds: null }]) === null
  && impliedProbabilities([]) === null && impliedProbabilities(null) === null);
check('a 0.00 price (an entry so short it rounds to even money on the board) is still priced',
  impliedProbabilities([{ programNumber: '1', postTimeOdds: 0 }, { programNumber: '2', postTimeOdds: 3 }]).get('1') > 0.5);

{
  const finishOf = new Map([['1', 1], ['2', 2], ['3', 3]]);
  const fin = [
    { programNumber: '1', postTimeOdds: 1.5, favorite: true },
    { programNumber: '2', postTimeOdds: 4.0, favorite: false },
    { programNumber: '3', postTimeOdds: 9.0, favorite: false },
  ];
  const b = marketBaseline(fin, finishOf);
  check('market baseline: the flagged favorite wins/places/shows', b.programNumbers.join() === '1' && b.win && b.place && b.show && !b.tied);
  const derived = marketBaseline(fin.map((f) => ({ ...f, favorite: false })), finishOf);
  check('market baseline: with no asterisk it falls back to the shortest price',
    derived.programNumbers.join() === '1' && derived.win);
  const tie = marketBaseline([
    { programNumber: '1', postTimeOdds: 2.0, favorite: true },
    { programNumber: '2', postTimeOdds: 2.0, favorite: true },
  ], new Map([['1', 4], ['2', 1]]));
  check('market baseline: a flagged tie is reported as a tie and hits if EITHER got there',
    tie.tied && tie.programNumbers.length === 2 && tie.win === true);
  check('market baseline: an unpriced, unflagged race is NULL',
    marketBaseline([{ programNumber: '1', postTimeOdds: null, favorite: false }], finishOf) === null);
}

// ---------------------------------------------------------------------------
console.log('\npost-time odds - beat the close');

const roles = { winBacked: ['2'], placeBacked: [], showBacked: [], named: ['2'], primary: '2' };
const priced = [
  { programNumber: '1', finishPosition: 2, postTimeOdds: 1.0, favorite: true },
  { programNumber: '2', finishPosition: 1, postTimeOdds: 3.0, favorite: false },
  { programNumber: '3', finishPosition: 3, postTimeOdds: 7.0, favorite: false },
];
{
  const s = scorePickRace({ roles, finishers: priced });
  // book = 1/2 + 1/4 + 1/8 = 0.875 -> q(#2) = 0.25/0.875
  const q = (1 / 4) / (1 / 2 + 1 / 4 + 1 / 8);
  check('a winning pick scores 1 - q', s.market.priced && close(s.market.closeEdge, 1 - q, 1e-9),
    JSON.stringify(s.market));
  check('primaryImplied is that same q, so the figure is re-derivable by hand',
    close(s.market.primaryImplied, q, 1e-9));
}
{
  const loser = { ...roles, winBacked: ['3'], named: ['3'], primary: '3' };
  const s = scorePickRace({ roles: loser, finishers: priced });
  check('a losing pick scores -q, so backing a LONGSHOT and losing costs least',
    s.market.closeEdge < 0 && s.market.closeEdge > -0.2, String(s.market.closeEdge));
  const chalk = { ...roles, winBacked: ['1'], named: ['1'], primary: '1' };
  const sc = scorePickRace({ roles: chalk, finishers: priced });
  check('backing the FAVORITE and losing costs most - the asymmetry that makes this an edge test, not a hit-rate test',
    sc.market.closeEdge < s.market.closeEdge);
}
{
  const unpriced = priced.map((f) => ({ ...f, postTimeOdds: null, favorite: false }));
  const s = scorePickRace({ roles, finishers: unpriced });
  check('an UNPRICED race (every Apify-sourced day): priced false, closeEdge NULL not 0',
    s.market.priced === false && s.market.closeEdge === null && s.market.favorite === null);
  const agg = aggregatePickScores([s]);
  check('aggregate: an unpriced race contributes n=0 to closeEdge and a NULL mean',
    agg.closeEdge.n === 0 && agg.closeEdge.mean === null && agg.racesPriced === 0);
}
{
  const mixed = [scorePickRace({ roles, finishers: priced }),
    scorePickRace({ roles, finishers: priced.map((f) => ({ ...f, postTimeOdds: null, favorite: false })) })];
  const agg = aggregatePickScores(mixed);
  check('aggregate: closeEdge carries its OWN n (1 of 2 races), never the race count',
    agg.closeEdge.n === 1 && agg.racesPriced === 1 && agg.n === 2);
  check('aggregate: the market favorite baseline also carries its own smaller n',
    agg.baselines.marketFavoriteWin.n === 1);
}
{
  // A source that simply IS the market scores ~0, which is the null hypothesis.
  const races = [];
  for (let i = 0; i < 8; i++) {
    const fin = [
      { programNumber: '1', finishPosition: i < 4 ? 1 : 2, postTimeOdds: 1.0, favorite: true },
      { programNumber: '2', finishPosition: i < 4 ? 2 : 1, postTimeOdds: 1.0, favorite: false },
    ];
    races.push(scorePickRace({ roles: { winBacked: ['1'], placeBacked: [], showBacked: [], named: ['1'], primary: '1' }, finishers: fin }));
  }
  const agg = aggregatePickScores(races);
  check('a source that exactly matches the market scores 0 - zero is the null, not the floor',
    close(agg.closeEdge.mean, 0, 1e-9) && agg.closeEdge.n === 8, String(agg.closeEdge.mean));
}

// ---------------------------------------------------------------------------
console.log('\npost-time odds - the real server, end to end');
{
  const { spawn } = await import('node:child_process');
  const PORT = 8899;
  const BASE = `http://127.0.0.1:${PORT}`;
  const srvDb = path.join(tmp, 'srv.sqlite');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env, BETSHEET_PORT: String(PORT), BETSHEET_DB: srvDb,
      BETSHEET_LOG_DIR: path.join(tmp, 'srv-logs'), ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  const jpost = (u, b = {}) => fetch(BASE + u, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  });

  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    check('server boots', up, out.slice(-400));

    const Database = (await import('better-sqlite3')).default;
    const fixture = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));
    const dayId = (await (await jpost('/api/race-days', {
      track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
    })).json()).id;

    // The route takes the PARSED preview (invariant 9: the client confirms what
    // it was shown), not raw text, and spreads its counts at the top level.
    const saveBody = { track: chart.track, date: chart.date, sourceKind: 'paste', races: chart.races };
    const saveRes = await (await jpost(`/api/race-days/${dayId}/results`, saveBody)).json();
    const db = new Database(srvDb);
    const rows = db.prepare('SELECT race_number, program_number, finish_position, win_cents, post_time_odds, favorite FROM race_results WHERE race_day_id = ?').all(dayId);
    check('results saved with a price on every row', rows.length > 0 && rows.every((r) => typeof r.post_time_odds === 'number'),
      `${rows.filter((r) => r.post_time_odds === null).length} null of ${rows.length}`);
    check('the save reports how many rows it priced', rows.length > 0 && saveRes.priced === rows.length,
      JSON.stringify({ priced: saveRes.priced, rows: rows.length }));
    // `.every` over an empty set is TRUE, so each of these asserts its own
    // denominator first. Both passed vacuously on the first run of this file,
    // against zero saved rows, which is exactly the failure mode a check is
    // supposed to catch rather than exhibit.
    const raceNumbers = [...new Set(rows.map((r) => r.race_number))];
    check('one favorite per race in the DB',
      raceNumbers.length === chart.races.length && raceNumbers.every((n) =>
        rows.filter((r) => r.race_number === n && r.favorite === 1).length === 1),
      `${raceNumbers.length} races`);
    const storedWinners = rows.filter((r) => r.finish_position === 1 && r.win_cents !== null);
    check('stored winner odds still agree with the stored win payout',
      storedWinners.length === chart.races.length
      && storedWinners.every((r) => close(r.win_cents / 200 - 1, r.post_time_odds, 0.06)),
      `${storedWinners.length} winners checked`);

    // --- the re-save a backfill actually is ---------------------------------
    const before = db.prepare('SELECT COUNT(*) c FROM graded_tickets').get().c;
    db.prepare('UPDATE race_results SET post_time_odds = NULL, favorite = 0 WHERE race_day_id = ?').run(dayId);
    check('simulating a pre-D229 day: prices cleared',
      db.prepare('SELECT COUNT(*) c FROM race_results WHERE race_day_id = ? AND post_time_odds IS NOT NULL').get(dayId).c === 0);
    await jpost(`/api/race-days/${dayId}/results`, saveBody);
    const after = db.prepare('SELECT COUNT(*) c FROM race_results WHERE race_day_id = ? AND post_time_odds IS NOT NULL').get(dayId).c;
    check('re-saving the same chart BACKFILLS the prices',
      rows.length > 0 && after === rows.length, `${after} of ${rows.length}`);
    check('...and leaves the grades alone - this is what a backfill must not break',
      db.prepare('SELECT COUNT(*) c FROM graded_tickets').get().c === before, `${before} -> ${db.prepare('SELECT COUNT(*) c FROM graded_tickets').get().c}`);

    // --- a source with no board stores NULL, not 0 --------------------------
    db.prepare(`INSERT INTO race_results (race_day_id, race_number, program_number, horse_name, finish_position)
                VALUES (?, 99, '1', 'No Board', 1)`).run(dayId);
    check('a row inserted without a price defaults to NULL odds and favorite 0 - never a guessed zero',
      db.prepare("SELECT post_time_odds o, favorite f FROM race_results WHERE race_day_id = ? AND race_number = 99").get(dayId).o === null);

    // --- the whole chain: chart odds -> /api/pick-scoring's closeEdge --------
    // Seeded straight into the tables, the way check-pick-scoring-api.js does:
    // this assertion is about the closing price reaching the endpoint, and
    // routing it through a producer would only re-test the producer.
    {
      const r1 = db.prepare('SELECT id FROM races WHERE race_day_id = ? AND number = 1').get(dayId).id;
      const winnerRow = db.prepare(`SELECT program_number, post_time_odds FROM race_results
        WHERE race_day_id = ? AND race_number = 1 AND finish_position = 1`).get(dayId);
      const cardId = db.prepare(`INSERT INTO cards (race_day_id, card_number, variant, bankroll_cents, status,
          correlation_id, consensus_completeness, engine_version)
        VALUES (?, 1, 'default', 20000, 'final', 'corr-ptodds', 'HUMAN', 'human')`).run(dayId).lastInsertRowid;
      db.prepare(`INSERT INTO tickets (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents, teller_call)
        VALUES (?, ?, 1, 'win', ?, 2000, 2000, 'win')`)
        .run(cardId, r1, JSON.stringify({ races: [1], legs: [[winnerRow.program_number]] }));

      const scoring = await (await fetch(`${BASE}/api/pick-scoring`)).json();
      const human = scoring.bySource.find((b) => b.source.startsWith('HUMAN'));
      check('the endpoint reports a closeEdge with its own n', !!human && human.closeEdge.n === 1,
        JSON.stringify(human?.closeEdge));
      check('the endpoint reports the post-time favorite baseline too',
        !!human && human.baselines.marketFavoriteWin.n === 1);

      // Re-derive the figure by hand from the stored board: the pick WON, so
      // its edge is 1 - q, and q is its own normalised implied probability.
      const board = db.prepare(`SELECT program_number p, post_time_odds o FROM race_results
        WHERE race_day_id = ? AND race_number = 1 AND post_time_odds IS NOT NULL`).all(dayId);
      const total = board.reduce((a, b) => a + 1 / (1 + b.o), 0);
      const q = (1 / (1 + winnerRow.post_time_odds)) / total;
      check('...and it equals a by-hand re-derivation from the stored odds',
        close(human.closeEdge.mean, 1 - q, 1e-9), `${human?.closeEdge.mean} vs ${1 - q}`);

      const race = scoring.races.find((x) => x.raceNo === 1 && x.groupKey.startsWith('HUMAN'));
      check('the per-race row carries the same market block, so the aggregate is auditable',
        race?.market?.priced === true && close(race.market.closeEdge, 1 - q, 1e-9));

      // And the honest negative: strip the board, and the figure goes NULL
      // rather than to zero.
      db.prepare('UPDATE race_results SET post_time_odds = NULL, favorite = 0 WHERE race_day_id = ?').run(dayId);
      const blind = await (await fetch(`${BASE}/api/pick-scoring`)).json();
      const blindHuman = blind.bySource.find((b) => b.source.startsWith('HUMAN'));
      check('with no board stored the endpoint reports closeEdge n=0 and a NULL mean - never 0',
        blindHuman.closeEdge.n === 0 && blindHuman.closeEdge.mean === null && blindHuman.racesPriced === 0);
      check('...while the MORNING-LINE favorite baseline is unaffected, because it never needed a board',
        blindHuman.baselines.favoriteWin.n === 1);
    }

    db.close();
  } finally {
    server.kill();
  }
}

console.log(failures === 0 ? '\nAll post-time-odds checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
