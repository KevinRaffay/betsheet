// Verification for the combined per-race model (D434):
// shared/race-consensus.js and its loader, server/race-consensus.js.
// Run: npm run check-race-consensus
//
// The pure half is hand-built races whose answers were worked out before the
// code ran. The loader half seeds a THROWAWAY temp database (logger redirected
// too - CLAUDE.md Gotchas: BETSHEET_DB alone is not isolation) and asserts the
// dedupe and the leakage rule directly.
//
// The assertions that matter most, because each is the one that fails if the
// model starts inventing something: zero weights return the market EXACTLY;
// every race sums to 1; a vote moves only its own horse against the rest (the
// others keep their ratios); the cap holds whatever the pile-up; a
// post-result LLM card never votes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-consensus-'));
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const {
  combineRace, marketProbabilities, harville, countVotes, DEFAULT_WEIGHTS, MARKET_ONLY_WEIGHTS,
} = await import('../shared/race-consensus.js');
const { rolesFromTickets, rolesFromTipPicks } = await import('../shared/pick-scoring.js');

// Six runners, a morning line that sums well over 1, #7 scratched.
const entries = [
  { programNumber: '1', morningLineDecimal: 2 },     // 1/3
  { programNumber: '2', morningLineDecimal: 3 },     // 1/4
  { programNumber: '3', morningLineDecimal: 4 },     // 1/5
  { programNumber: '4', morningLineDecimal: 6 },     // 1/7
  { programNumber: '5', morningLineDecimal: 9 },     // 1/10
  { programNumber: '6', morningLineDecimal: 19 },    // 1/20
  { programNumber: '7', morningLineDecimal: 1, scratched: true },
];
const pOf = (model, pgm, key = 'combinedP') => model.runners.find((r) => r.programNumber === pgm)[key];

console.log('-- the market base --');
{
  const m = marketProbabilities(entries);
  const raw = [1 / 3, 1 / 4, 1 / 5, 1 / 7, 1 / 10, 1 / 20];
  const total = sum(raw);
  check('morning-line basis with no board', m.basis === 'ml');
  check('the scratch is not in the field', !m.probs.has('7') && m.probs.size === 6);
  check('fair probabilities sum to 1', near(sum([...m.probs.values()]), 1));
  check('each is its raw share of the book', near(m.probs.get('1'), raw[0] / total) && near(m.probs.get('6'), raw[5] / total));

  const board = entries.map((e) => ({ ...e, liveOddsDecimal: e.programNumber === '6' ? 4 : e.morningLineDecimal }));
  const lb = marketProbabilities(board);
  check('a comparable board switches the basis to live', lb.basis === 'live');
  check('the steamed horse is shorter on the live basis', lb.probs.get('6') > m.probs.get('6'));
  check('live basis still sums to 1', near(sum([...lb.probs.values()]), 1));

  const partial = entries.map((e) => (e.programNumber === '5' ? { ...e, morningLineDecimal: null } : e));
  const pm = marketProbabilities(partial);
  const priced = [...pm.probs].filter(([k]) => k !== '5').map(([, v]) => v);
  check('an unpriced live runner gets the smallest priced share', near(pm.probs.get('5'), Math.min(...priced)));
  check('...and the race still sums to 1', near(sum([...pm.probs.values()]), 1));

  check('fewer than two priced runners: null, not a guess',
    marketProbabilities([{ programNumber: '1', morningLineDecimal: 2 }, { programNumber: '2' }]) === null
    && combineRace({ entries: [] }) === null);
}

console.log('-- Harville --');
{
  const two = harville(new Map([['A', 0.6], ['B', 0.4]]));
  check('two runners: both place with certainty', near(two.place.get('A'), 1) && near(two.place.get('B'), 1));
  const m = marketProbabilities(entries).probs;
  const h = harville(m);
  check('place probabilities sum to 2', near(sum([...h.place.values()]), 2, 1e-9));
  check('show probabilities sum to 3', near(sum([...h.show.values()]), 3, 1e-9));
  check('win <= place <= show for every runner', [...m].every(([k, p]) => p <= h.place.get(k) + 1e-12 && h.place.get(k) <= h.show.get(k) + 1e-12));
  // Hand-worked: A .5, B .3, C .2. P(A top 2) = .5 + .3*.5/.7 + .2*.5/.8.
  const abc = harville(new Map([['A', 0.5], ['B', 0.3], ['C', 0.2]]));
  check('hand-worked place value', near(abc.place.get('A'), 0.5 + 0.3 * 0.5 / 0.7 + 0.2 * 0.5 / 0.8));
  check('three runners: all show', ['A', 'B', 'C'].every((k) => near(abc.show.get(k), 1)));
}

console.log('-- the combination --');
{
  const market = combineRace({ entries, weights: MARKET_ONLY_WEIGHTS });
  const mk = marketProbabilities(entries).probs;
  check('zero weights reproduce the market exactly', market.runners.every((r) => near(r.combinedP, mk.get(r.programNumber), 1e-15) && near(r.marketP, r.combinedP, 1e-15)));
  const noVotes = combineRace({ entries });
  check('no sources: default weights also reproduce the market', noVotes.runners.every((r) => near(r.combinedP, r.marketP, 1e-15)));

  const tip = rolesFromTipPicks([{ horse_no: '4', rank: 1 }, { horse_no: '2', rank: 2 }, { horse_no: '1', rank: 3 }]);
  const one = combineRace({ entries, tipRoles: [tip] });
  check('combined sums to 1', near(sum(one.runners.map((r) => r.combinedP)), 1));
  check('a tip-sheet top pick rises', pOf(one, '4') > mk.get('4'));
  // #3, #5, #6 got no vote: their ratios to each other must be untouched.
  check('unvoted horses keep their ratios to each other',
    near(pOf(one, '3') / pOf(one, '5'), mk.get('3') / mk.get('5'), 1e-12)
    && near(pOf(one, '5') / pOf(one, '6'), mk.get('5') / mk.get('6'), 1e-12));
  check('the bump is exactly the stated weight', near(one.runners.find((r) => r.programNumber === '4').bump, DEFAULT_WEIGHTS.tipTop)
    && near(one.runners.find((r) => r.programNumber === '2').bump, DEFAULT_WEIGHTS.tipNamed));
  check('runners come back sorted by combinedP', one.runners.every((r, i, a) => i === 0 || a[i - 1].combinedP >= r.combinedP));

  const pile = Array.from({ length: 10 }, () => tip);
  const capped = combineRace({ entries, tipRoles: pile });
  check('ten agreeing sheets are capped at maxBump', near(capped.runners.find((r) => r.programNumber === '4').bump, DEFAULT_WEIGHTS.maxBump));

  const scratchVote = rolesFromTipPicks([{ horse_no: '7', rank: 1 }]);
  const sv = combineRace({ entries, tipRoles: [scratchVote] });
  check('a vote for a scratched horse is dropped, market unchanged', sv.runners.every((r) => near(r.combinedP, r.marketP, 1e-15)));

  const llm = rolesFromTickets([
    { betType: 'win', legs: [['5']], stakeCents: 400, sequence: 1 },
    { betType: 'win', legs: [['3']], stakeCents: 200, sequence: 2 },
    { betType: 'trifecta_box', legs: [['5', '3', '6']], stakeCents: 100, sequence: 3 },
  ]);
  const otr = rolesFromTickets([
    { betType: 'win', legs: [['5']], stakeCents: 200, sequence: 1 },
    { betType: 'show', legs: [['2']], stakeCents: 200, sequence: 2 },
  ]);
  const v = countVotes({ llmRoles: [llm], otrRoles: otr });
  check('LLM: largest win ticket is the primary vote', v.get('5').llmPrimary === 1 && v.get('5').llmBacked === 0);
  check('LLM: another win ticket is a backed vote', v.get('3').llmBacked === 1);
  check('LLM: a box-only horse gets no vote', !v.has('6'));
  check('OTR: win pick and show pick counted apart', v.get('5').otrWin === 1 && v.get('2').otrShow === 1);
  check('case and whitespace in program numbers do not split a vote',
    countVotes({ tipRoles: [rolesFromTipPicks([{ horse_no: ' 1a ', rank: 1 }])] }).get('1A').tipTop === 1);
}

console.log('-- the loader: dedupe and the leakage rule --');
{
  const { openDb } = await import('../server/db.js');
  const { loadDaySignals, gradedDayIds } = await import('../server/race-consensus.js');
  const db = openDb(process.env.BETSHEET_DB);
  const dayId = db.prepare("INSERT INTO race_days (track, date, correlation_id) VALUES ('Del Mar', '2026-08-30', 'corr-day')").run().lastInsertRowid;
  const deletedDay = db.prepare("INSERT INTO race_days (track, date, correlation_id, deleted_at) VALUES ('Del Mar', '2026-08-31', 'corr-del', '2026-09-01')").run().lastInsertRowid;
  const raceId = db.prepare('INSERT INTO races (race_day_id, number) VALUES (?, 1)').run(dayId).lastInsertRowid;
  db.prepare('INSERT INTO races (race_day_id, number) VALUES (?, 1)').run(deletedDay);
  for (const e of entries) {
    db.prepare('INSERT INTO entries (race_id, program_number, horse_name, morning_line_decimal, scratched) VALUES (?, ?, ?, ?, ?)')
      .run(raceId, e.programNumber, `Horse ${e.programNumber}`, e.morningLineDecimal, e.scratched ? 1 : 0);
  }
  db.prepare('INSERT INTO race_results (race_day_id, race_number, program_number, finish_position) VALUES (?, 1, ?, 1)').run(dayId, '4');
  db.prepare('INSERT INTO race_results (race_day_id, race_number, program_number, finish_position) VALUES (?, 1, ?, 1)').run(deletedDay, '4');

  let cardNo = 0;
  const card = (bucket, version, model = null) => {
    cardNo += 1;
    return db.prepare(`INSERT INTO cards (race_day_id, card_number, bankroll_cents, status, correlation_id, consensus_completeness, engine_version, llm_model)
      VALUES (?, ?, 20000, 'final', ?, ?, ?, ?)`).run(dayId, cardNo, `corr-${cardNo}`, bucket, version, model).lastInsertRowid;
  };
  let seq = 0;
  const ticket = (cardId, betType, legs, stake) => {
    seq += 1;
    db.prepare(`INSERT INTO tickets (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents, teller_call)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'x')`).run(cardId, raceId, seq, betType, JSON.stringify({ races: [1], legs }), stake, stake);
  };
  const request = (cardId, postResult) => db.prepare(`INSERT INTO llm_card_requests (race_day_id, card_id, race_number, prompt_text, requested_at, notes_post_result)
    VALUES (?, ?, 1, 'p', '2026-08-30T12:00:00Z', ?)`).run(dayId, cardId, postResult ? 1 : 0);

  // Fable: an old clean card on #1, a newer clean card on #2 (the one that
  // counts), then a newest card on #4 - the eventual winner - whose notes
  // were entered after results. It must never vote.
  const fOld = card('LLM_GENERATED', 'llm', 'claude-fable-5-1'); ticket(fOld, 'win', [['1']], 400); request(fOld, false);
  const fMid = card('LLM_GENERATED', 'llm', 'claude-fable-5-1'); ticket(fMid, 'win', [['2']], 400); request(fMid, false);
  const fNew = card('LLM_GENERATED', 'llm', 'claude-fable-5-1'); ticket(fNew, 'win', [['4']], 400); request(fNew, true);
  // Sonnet: one card whose ONLY generation is post-result - no vote at all.
  const sOnly = card('LLM_GENERATED', 'llm', 'claude-sonnet-5'); ticket(sOnly, 'win', [['4']], 400); request(sOnly, true);
  // OTR: two variant cards, one sheet - the union is read once.
  const o1 = card('EQB_OTR', 'equibase-otr'); ticket(o1, 'win', [['3']], 200);
  const o2 = card('EQB_OTR', 'equibase-otr'); ticket(o2, 'show', [['5']], 200); ticket(o2, 'win', [['3']], 200);
  // A HUMAN card is never a signal.
  const h = card('HUMAN', 'human'); ticket(h, 'win', [['6']], 200);
  db.prepare("INSERT INTO tip_picks (race_day_id, race_no, source_label, picks, created_at) VALUES (?, 1, 'trackmaster', ?, '2026-08-30T12:00:00Z')")
    .run(dayId, JSON.stringify([{ horse_no: '1', horse_name: 'x', rank: 1 }, { horse_no: '3', horse_name: 'y', rank: 2 }]));

  const sig = loadDaySignals(db, dayId);
  const r1 = sig.races.get(1);
  check('entries loaded with the scratch flag', r1.entries.length === 7 && r1.entries.find((e) => e.programNumber === '7').scratched === true);
  check('one LLM vote per model: only Fable survives', r1.llmModels.length === 1 && r1.llmModels[0] === 'claude-fable-5-1');
  check('the newest CLEAN Fable card is the one read', r1.llmRoles[0].primary === '2');
  check('both post-result cards are counted as excluded', sig.excluded.llmPostResult === 2);
  check('the post-result winner pick never reaches the model',
    combineRace({ entries: r1.entries, llmRoles: r1.llmRoles }).runners.find((r) => r.programNumber === '4').votes.llmPrimary === 0);
  check('OTR is the union of its variant cards', r1.otrRoles.primary === '3' && r1.otrRoles.showBacked.includes('5'));
  check('the tip sheet is read from tip_picks', r1.tipRoles.length === 1 && r1.tipRoles[0].primary === '1' && r1.tipSources[0] === 'trackmaster');
  const votes = countVotes({ tipRoles: r1.tipRoles, llmRoles: r1.llmRoles, otrRoles: r1.otrRoles });
  check('the HUMAN card never votes', !votes.has('6'));
  check('a soft-deleted day loads as null', loadDaySignals(db, deletedDay) === null);
  check('the backtest corpus skips the soft-deleted day', gradedDayIds(db).length === 1 && gradedDayIds(db)[0] === dayId);
  db.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nall race-consensus checks passed');
}
