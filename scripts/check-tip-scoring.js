// Verification for TIPSHEET scoring (D170).
// Run: npm run check-tip-scoring
//
// Throwaway temp database with the logger redirected there too (CLAUDE.md,
// Gotchas: pointing only BETSHEET_DB somewhere safe is not isolation).
//
// The assertions that matter most are the ones about what this refuses to
// claim: a rate is NULL at n=0 rather than 0, `n` rides on every aggregate,
// sources are never pooled, and a soft-deleted day leaves every figure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-tipscore-'));
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

const { openDb } = await import('../server/db.js');
const { insertRaceDay } = await import('../server/ingest.js');
const { insertTipPicks } = await import('../server/tip-picks.js');
const { scoreTipRace, aggregateTipScores, byTipSource } = await import('../shared/tip-scoring.js');

console.log('-- pure: what a single race scores to --');
{
  const finishers = [
    { programNumber: '6', finishPosition: 1 }, { programNumber: '4', finishPosition: 2 },
    { programNumber: '2', finishPosition: 3 }, { programNumber: '7', finishPosition: null },
  ];
  const picks = [{ horse_no: '4', rank: 1 }, { horse_no: '6', rank: 2 }, { horse_no: '2', rank: 3 }];

  const s = scoreTipRace({ picks, finishers });
  check('top pick 2nd: place and show, but not win', s.win === false && s.place && s.show);
  check('another pick won, and that is reported separately', s.anyPickWon === true);
  check('all three picks were in the real top three', s.top3Overlap === 3 && s.top3Possible === 3);
  check('the actual winner is named', s.winnerProgramNumber === '6');

  // A scratch is not a miss. The sheet's top LIVE pick is what a bettor backs.
  const scr = scoreTipRace({ picks, finishers, scratched: ['4'] });
  check('a scratched top pick promotes the next live one', scr.topPick.horseNo === '6' && scr.topPickSubstituted);
  check('  and that promoted pick won', scr.win === true);
  check('  and the scratch is counted, not hidden', scr.scratchedCount === 1);
  check('top3 is scored out of what SURVIVED, not always 3',
    scoreTipRace({ picks: picks.slice(0, 2), finishers, scratched: ['4'] }).top3Possible === 1);

  // A finisher the chart never placed RAN and lost - different from not running.
  const ran = scoreTipRace({ picks: [{ horse_no: '7', rank: 1 }], finishers });
  check('an unplaced also-ran is a loss, not an unknown', ran.win === false && ran.unknownPicks.length === 0);
  // A program number the result has never heard of is an extraction error.
  const ghost = scoreTipRace({ picks: [{ horse_no: '99', rank: 1 }], finishers });
  check('a pick missing from the result is SURFACED, not scored a loss silently',
    ghost.unknownPicks.length === 1 && ghost.unknownPicks[0] === '99');

  check('no result on file scores NULL, never zero', scoreTipRace({ picks, finishers: [] }) === null);
  check('no picks scores NULL', scoreTipRace({ picks: [], finishers }) === null);
  check('every pick scratched scores NULL', scoreTipRace({ picks, finishers, scratched: ['4', '6', '2'] }) === null);
  check('scoreTipRace never throws on junk',
    [null, undefined, {}, { picks: 'x' }].every((i) => { try { scoreTipRace(i); return true; } catch { return false; } }));
}

console.log('-- pure: an aggregate never hides its denominator --');
{
  const s = (win, ov) => ({ win, place: win, show: win, anyPickWon: win, top3Overlap: ov, top3Possible: 3, topPickSubstituted: false, unknownPicks: [] });
  const empty = aggregateTipScores([]);
  check('n = 0 yields NULL rates, never 0 (the "no figure without its n" rule)',
    empty.n === 0 && empty.winRate === null && empty.placeRate === null && empty.top3OverlapRate === null);
  const two = aggregateTipScores([s(true, 3), s(false, 1)]);
  check('n rides on the aggregate', two.n === 2 && two.winRate === 0.5);
  check('unscored races are reported, never folded into the rate',
    aggregateTipScores([s(true, 3), null, null]).unscored === 2
    && aggregateTipScores([s(true, 3), null, null]).n === 1);
  const grouped = byTipSource([
    { sourceLabel: 'trackmaster', score: s(true, 3) },
    { sourceLabel: 'numberfire', score: s(false, 0) },
  ]);
  check('sources are grouped, never pooled', grouped.length === 2
    && !JSON.stringify(grouped).includes('"all"'));
  check('  and each carries its own n', grouped.every((g) => g.n === 1));
}

console.log('-- the endpoints, on a real day with real results --');
{
  const { spawn } = await import('node:child_process');
  const PORT = 8911;
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
  const jget = (u) => fetch(BASE + u).then((r) => r.json());
  const jpost = (u, b = {}, m = 'POST') => fetch(BASE + u, {
    method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  });

  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    check('server boots', up, out.slice(-300));

    const Database = (await import('better-sqlite3')).default;
    const fixture = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));
    const dayId = (await (await jpost('/api/race-days', {
      track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
    })).json()).id;

    // Results and tip rows written directly - this check is about SCORING, and
    // routing them through the ingest/extraction paths would only re-test those.
    const db = new Database(srvDb);
    const put = db.prepare('INSERT INTO race_results (race_day_id, race_number, program_number, horse_name, finish_position) VALUES (?, ?, ?, ?, ?)');
    put.run(dayId, 1, '6', 'Union Roar', 1);
    put.run(dayId, 1, '4', 'Karazest', 2);
    put.run(dayId, 1, '2', 'Fancy Feet', 3);
    put.run(dayId, 2, '3', 'Someone Else', 1);
    put.run(dayId, 2, '5', 'Another', 2);
    insertTipPicks(db, { raceDayId: dayId, raceNo: 1, sourceLabel: 'trackmaster',
      picks: [{ horse_no: '4', horse_name: 'Karazest', rank: 1 }, { horse_no: '6', horse_name: 'Union Roar', rank: 2 }] });
    insertTipPicks(db, { raceDayId: dayId, raceNo: 1, sourceLabel: 'numberfire',
      picks: [{ horse_no: '6', horse_name: 'Union Roar', rank: 1 }, { horse_no: '4', horse_name: 'Karazest', rank: 2 }] });
    // Race 3 has NO results - it must count as unscored, never as a miss.
    insertTipPicks(db, { raceDayId: dayId, raceNo: 3, sourceLabel: 'trackmaster',
      picks: [{ horse_no: '1', horse_name: 'Nothing Yet', rank: 1 }] });
    db.close();

    const day = await jget(`/api/race-days/${dayId}/tip-scoring`);
    const tm = day.bySource.find((s) => s.sourceLabel === 'trackmaster');
    const nf = day.bySource.find((s) => s.sourceLabel === 'numberfire');
    check('each source is reported separately', day.bySource.length === 2);
    check('trackmaster: top pick ran 2nd, so 0 for 1 on wins', tm.n === 1 && tm.winRate === 0 && tm.placeRate === 1);
    check('numberfire: top pick won, 1 for 1', nf.n === 1 && nf.winRate === 1);
    check('the race with no results is UNSCORED, not a loss', tm.unscored === 1);
    check('there is NO pooled all-source total (invariant 13)',
      day.bySource.every((s) => s.sourceLabel !== 'all') && !('overall' in day));

    const corpus = await jget('/api/tip-scoring');
    check('the corpus route reports the same two sources', corpus.bySource.length === 2);
    check('  and lists the per-race rows a rate can be checked against by hand',
      corpus.races.length === 3 && corpus.races.filter((r) => r.scored).length === 2);
    check('  and names the actual winner per race',
      corpus.races.find((r) => r.raceNo === 1 && r.sourceLabel === 'numberfire').winnerProgramNumber === '6');
    const filtered = await jget('/api/tip-scoring?source=numberfire');
    check('filtering by source narrows to one', filtered.bySource.length === 1 && filtered.bySource[0].sourceLabel === 'numberfire');

    // INVARIANT 12: a soft-deleted day leaves every aggregate, and comes back.
    await jpost(`/api/race-days/${dayId}`, {}, 'DELETE');
    const afterDelete = await jget('/api/tip-scoring');
    check('a soft-deleted day drops out of scoring entirely (invariant 12)',
      afterDelete.bySource.length === 0 && afterDelete.races.length === 0);
    check('  and the day route answers 410, not stale figures',
      (await fetch(`${BASE}/api/race-days/${dayId}/tip-scoring`)).status === 410);
    await jpost(`/api/race-days/${dayId}/restore`);
    check('  and restoring brings it back', (await jget('/api/tip-scoring')).bySource.length === 2);
  } finally {
    server.kill();
  }
}

console.log('');
console.log(failures ? `FAILED (${failures})` : 'All tip-scoring checks passed.');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
process.exit(failures ? 1 : 0);
