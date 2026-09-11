// Verification for pick-source scoring, PS-2 (D221): server/pick-scoring.js.
// Run: npm run check-pick-scoring-api
//
// Boots the REAL server on a throwaway temp database with the logger
// redirected there too (CLAUDE.md, Gotchas: pointing only BETSHEET_DB
// somewhere safe is not isolation), seeds one real day from a fixture, and
// writes results, cards, tickets, prompts and tip rows DIRECTLY - this check
// is about the query layer's dedupe and labelling, and routing the seed
// through the ingest/generation paths would only re-test those.
//
// The assertions that matter most: three OTR variant cards produce ONE row;
// the newest LLM card per model wins; a staked tip source is read from
// tip_picks and its three TIPSHEET cards are never scored; the inputs label
// is part of the group key; a soft-deleted day leaves every figure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-pickscore-'));
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const { llmInputsLabel } = await import('../server/pick-scoring.js');
const { insertTipPicks } = await import('../server/tip-picks.js');

console.log('-- pure: the inputs label read off a stored prompt --');
{
  const OTR = 'Equibase Off to the Races (the free at-track sheet, algorithmic): $2 W 6 | $2 S 4';
  const TIP = 'trackmaster: 1st #4 Letmein, 2nd #6 Here\'s Some More, 3rd #2 Cruisin for Cali';
  const wrap = (...lines) => `RACE 1\n#1 Howie's Law - ML 4/5\n\nBASELINE PICKS\n${lines.join('\n')}\n\n<analyst_notes scope="race">x</analyst_notes>\n`;
  check('no BASELINE PICKS block (pre-D179 prompt): none', llmInputsLabel('RACE 1\n#1 x - ML 4/5\n') === 'none');
  check('OTR line only: otr', llmInputsLabel(wrap(OTR)) === 'otr');
  check('a tip sheet line only: tipsheet', llmInputsLabel(wrap(TIP)) === 'tipsheet');
  check('both: both', llmInputsLabel(wrap(TIP, OTR)) === 'both');
  check('a block that ends at the blank line does not read the notes as a tip sheet',
    llmInputsLabel(wrap(OTR)) === 'otr');
  check('CRLF prompts read the same', llmInputsLabel(wrap(TIP, OTR).replace(/\n/g, '\r\n')) === 'both');
  check('junk never throws', llmInputsLabel(null) === 'none' && llmInputsLabel(42) === 'none');
}

console.log('-- the endpoint, on a real day --');
{
  const { spawn } = await import('node:child_process');
  const PORT = 8914;
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

    const db = new Database(srvDb);
    const raceId = (n) => db.prepare('SELECT id FROM races WHERE race_day_id = ? AND number = ?').get(dayId, n).id;

    // Results. Race 1: the 4/5 ML favorite (#1) runs 4th; 6 wins, 4 second, 2 third.
    // Race 2: the 5/2 favorite (#3) wins. Race 3: NO results.
    const put = db.prepare('INSERT INTO race_results (race_day_id, race_number, program_number, horse_name, finish_position) VALUES (?, ?, ?, ?, ?)');
    put.run(dayId, 1, '6', "Here's Some More", 1);
    put.run(dayId, 1, '4', 'Letmein', 2);
    put.run(dayId, 1, '2', 'Cruisin for Cali', 3);
    put.run(dayId, 1, '1', "Howie's Law", 4);
    put.run(dayId, 1, '3', 'Kid Charlemagne', 5);
    db.prepare('INSERT INTO result_scratches (race_day_id, race_number, program_number, horse_name) VALUES (?, ?, ?, ?)').run(dayId, 1, '5', "Fumano's Magic");
    put.run(dayId, 2, '3', 'Chiseled in Stone', 1);
    put.run(dayId, 2, '5', 'Lil Prince Cairo', 2);
    put.run(dayId, 2, '7', 'Bottled in Bond', 3);

    let cardNo = 0;
    const card = ({ bucket, variant = 'default', version, model = null, tipLabel = null }) => {
      cardNo += 1;
      return db.prepare(`INSERT INTO cards (race_day_id, card_number, variant, bankroll_cents, status, correlation_id,
          consensus_completeness, engine_version, llm_model, tip_source_label)
        VALUES (?, ?, ?, 20000, 'final', ?, ?, ?, ?, ?)`)
        .run(dayId, cardNo, variant, `corr-${cardNo}`, bucket, version, model, tipLabel).lastInsertRowid;
    };
    let seq = 0;
    const ticket = (cardId, raceNo, betType, legs, stakeCents) => {
      seq += 1;
      db.prepare(`INSERT INTO tickets (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents, teller_call)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cardId, raceId(raceNo), seq, betType, JSON.stringify({ races: [raceNo], legs }), stakeCents, stakeCents, 'x');
    };
    const prompt = (cardId, raceNo, text) => db.prepare(
      'INSERT INTO llm_card_requests (race_day_id, card_id, race_number, prompt_text, requested_at) VALUES (?, ?, ?, ?, ?)',
    ).run(dayId, cardId, raceNo, text, new Date().toISOString());

    // EQB_OTR: three variant cards, the same printed sheet. Show 4, win 6, box4, box3.
    for (const variant of ['some-reward', 'higher-reward', 'both']) {
      const id = card({ bucket: 'EQB_OTR', variant, version: 'equibase-otr' });
      if (variant !== 'higher-reward') { ticket(id, 1, 'show', [['4']], 200); ticket(id, 1, 'exacta_box', [['4', '6', '2', '1']], 100); }
      if (variant !== 'some-reward') { ticket(id, 1, 'win', [['6']], 200); ticket(id, 1, 'exacta_box', [['4', '6', '2']], 200); }
    }
    // LLM, Fable: an OLDER card backing #1, then a NEWER card backing 6 ($4) and 2 ($2) with an OTR-fed prompt.
    const fableOld = card({ bucket: 'LLM_GENERATED', version: 'llm', model: 'claude-fable-5-1' });
    ticket(fableOld, 1, 'win', [['1']], 1000);
    prompt(fableOld, 1, 'RACE 1\nno baseline block\n');
    const fableNew = card({ bucket: 'LLM_GENERATED', version: 'llm', model: 'claude-fable-5-1' });
    ticket(fableNew, 1, 'win', [['6']], 400);
    ticket(fableNew, 1, 'win', [['2']], 200);
    ticket(fableNew, 1, 'trifecta_box', [['6', '2', '4']], 100);
    prompt(fableNew, 1, 'RACE 1\n\nBASELINE PICKS\nEquibase Off to the Races (the free at-track sheet, algorithmic): $2 W 6\n\n');
    ticket(fableNew, 2, 'win', [['3']], 400);
    prompt(fableNew, 2, 'RACE 2\n\nBASELINE PICKS\ntrackmaster: 1st #3 Chiseled in Stone\n\n');
    // LLM, Sonnet: backs the favorite, no baseline block.
    const sonnet = card({ bucket: 'LLM_GENERATED', version: 'llm', model: 'claude-sonnet-5' });
    ticket(sonnet, 1, 'win', [['1']], 400);
    prompt(sonnet, 1, 'RACE 1\nno baseline block\n');
    // HUMAN: a place bet on 4 in race 1, and a win bet in race 3 (no results yet).
    const humanCard = card({ bucket: 'HUMAN', version: 'human' });
    ticket(humanCard, 1, 'place', [['4']], 200);
    ticket(humanCard, 3, 'win', [['1']], 200);
    // A tip sheet, STAKED into three TIPSHEET cards (which must never be scored).
    insertTipPicks(db, { raceDayId: dayId, raceNo: 1, sourceLabel: 'trackmaster',
      picks: [{ horse_no: '4', rank: 1 }, { horse_no: '6', rank: 2 }, { horse_no: '2', rank: 3 }] });
    for (const variant of ['win-only', 'across-the-board', 'exacta-box-top2']) {
      const id = card({ bucket: 'TIPSHEET', variant, version: 'tipsheet', tipLabel: 'trackmaster' });
      ticket(id, 1, 'win', [['4']], 200);
    }
    const mlFavorite = db.prepare(`SELECT e.program_number FROM entries e JOIN races r ON r.id = e.race_id
      WHERE r.race_day_id = ? AND r.number = 1 AND e.scratched = 0 ORDER BY e.morning_line_decimal ASC LIMIT 1`).get(dayId).program_number;
    db.close();

    const res = await jget('/api/pick-scoring');
    const by = (k) => res.bySource.find((s) => s.groupKey === k);
    const rowsFor = (k) => res.races.filter((r) => r.groupKey === k);

    check('every group is keyed by source (and inputs for LLM); no TIPSHEET CARD is ever read and there is no pooled total',
      same(res.bySource.map((s) => s.groupKey).sort(), ['EQB_OTR', 'HUMAN', 'claude-fable-5-1 [otr]', 'claude-fable-5-1 [tipsheet]', 'claude-sonnet-5 [none]', 'trackmaster'])
      && !res.races.some((r) => r.bucket === 'TIPSHEET' && r.cardIds.length > 0) && res.bySource.every((s) => s.groupKey !== 'all'), JSON.stringify(res.bySource.map((s) => s.groupKey)));

    const otr = by('EQB_OTR');
    check('three OTR variant cards -> ONE row for race 1, n=1', rowsFor('EQB_OTR').length === 1 && otr.n === 1);
    check('  its roles are the union of the variants: win 6, show 4, named 4/6/2/1, and all three card ids',
      same(rowsFor('EQB_OTR')[0].roles.winBacked, ['6']) && same(rowsFor('EQB_OTR')[0].roles.showBacked, ['4'])
      && same([...rowsFor('EQB_OTR')[0].roles.named].sort(), ['1', '2', '4', '6']) && rowsFor('EQB_OTR')[0].cardIds.length === 3);
    check('  primary 6 won, show pick 4 ran 2nd, no place ticket -> place n=0 rate NULL',
      otr.primaryWin.hits === 1 && otr.primaryWin.n === 1 && otr.show.hits === 1 && otr.place.n === 0 && otr.place.rate === null);
    check('  named all three of the real top three', otr.namedTop3.hits === 3 && otr.namedTop3.n === 3);

    const fable = by('claude-fable-5-1 [otr]');
    const fableRow = rowsFor('claude-fable-5-1 [otr]')[0];
    check('Fable race 1: the NEWEST card wins, and only it (the older #1 bet is gone)',
      rowsFor('claude-fable-5-1 [otr]').length === 1 && same(fableRow.cardIds, [fableNew])
      && same([...fableRow.roles.winBacked].sort(), ['2', '6']) && fableRow.roles.primary === '6');
    check('  inputs label read from the stored prompt: otr', fableRow.inputs === 'otr' && fable.inputs === 'otr' && fable.source === 'claude-fable-5-1');
    check('  primary won, two backed to win -> meanWinBacked 2', fable.primaryWin.hits === 1 && fable.meanWinBacked === 2);
    check('Fable race 2 is a DIFFERENT group because its prompt carried a tip sheet, not OTR',
      by('claude-fable-5-1 [tipsheet]').n === 1 && rowsFor('claude-fable-5-1 [tipsheet]')[0].raceNo === 2);
    check('Sonnet [none]: backed the favorite, which ran 4th: 0 for 1',
      by('claude-sonnet-5 [none]').primaryWin.hits === 0 && by('claude-sonnet-5 [none]').primaryWin.n === 1);

    const human = by('HUMAN');
    check('HUMAN: place bet on the runner-up hit; race 3 has no results and is UNSCORED, not a miss',
      human.place.hits === 1 && human.place.n === 1 && human.n === 1 && human.unscored === 1 && human.primaryWin.n === 0);

    const tm = by('trackmaster');
    check('trackmaster comes from tip_picks: n=1 despite three staked TIPSHEET cards, bucket TIPSHEET, no card ids',
      tm.n === 1 && tm.bucket === 'TIPSHEET' && rowsFor('trackmaster').length === 1 && rowsFor('trackmaster')[0].cardIds.length === 0);
    check('  rank 1 (#4) ran 2nd: primary win false, place true; all three ranks in the top three',
      tm.primaryWin.hits === 0 && tm.primaryPlace.hits === 1 && tm.namedTop3.hits === 3);

    check('the favorite baseline on race 1 is the 4/5 shot #1 (independently: lowest ML in entries), and it lost',
      mlFavorite === '1' && rowsFor('EQB_OTR')[0].favorite.horseNos[0] === '1' && rowsFor('EQB_OTR')[0].favorite.win === false
      && otr.baselines.favoriteWin.hits === 0 && otr.baselines.favoriteWin.n === 1);
    check('  and on race 2 the favorite (#3) won - Fable [tipsheet]\'s baseline says so',
      by('claude-fable-5-1 [tipsheet]').baselines.favoriteWin.hits === 1);
    check('  field size is the live field: 6 entries minus the scratched #5', rowsFor('EQB_OTR')[0].fieldSize === 5);
    check('the scratched #5 is not in anyone\'s result and the winner is named',
      rowsFor('EQB_OTR')[0].winnerProgramNumber === '6');

    check('unscoredDays names the day with the one unscored row (HUMAN race 3)',
      res.unscoredDays.length === 1 && res.unscoredDays[0].raceDayId === dayId && res.unscoredDays[0].rows === 1);

    check('?track=DMR keeps everything; ?track=XXX keeps nothing',
      (await jget('/api/pick-scoring?track=dmr')).bySource.length === 6
      && (await jget('/api/pick-scoring?track=XXX')).bySource.length === 0);

    // INVARIANT 12: a soft-deleted day leaves every aggregate, and comes back.
    await jpost(`/api/race-days/${dayId}`, {}, 'DELETE');
    const afterDelete = await jget('/api/pick-scoring');
    check('a soft-deleted day drops out entirely (invariant 12)',
      afterDelete.bySource.length === 0 && afterDelete.races.length === 0 && afterDelete.unscoredDays.length === 0);
    await jpost(`/api/race-days/${dayId}/restore`);
    check('  and restoring brings it back', (await jget('/api/pick-scoring')).bySource.length === 6);
  } finally {
    server.kill();
  }
}

console.log('');
console.log(failures ? `FAILED (${failures})` : 'All pick-scoring API checks passed.');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
process.exit(failures ? 1 : 0);
