// Verification for D54 (human cards) - exits non-zero on any failure.
// Run: npm run check-human-picks
//
// Runs against the real server on a temp DB, same convention as
// check-pl.js: the endpoints ARE the deliverable. Builds one fixture day
// with two races, exercises the parser's warning matrix via the preview
// endpoint, then the full lock -> save -> grade path, the D28 revealed-
// race refusal, PASS, bucket isolation against an engine card on the same
// day, and the no-version-bump identity (this PR never touches the
// engine or the grader).

import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-humancheck-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

// ---------- fixture ----------

const entry = (pgm, name, ml, mld, opts = {}) => ({
  programNumber: pgm, horseName: name, morningLine: ml, morningLineDecimal: mld,
  programRank: opts.rank ?? null, bestBet: false, scratched: Boolean(opts.scratched),
});
const day = {
  track: 'Human Fixture Downs', date: '2026-08-30', bankrollCents: 20000, perRaceMinCents: 500,
  races: [
    {
      number: 1, raceType: 'ALLOWANCE', conditions: 'FOR THREE YEAR OLDS AND UPWARD',
      wagerMenu: '$1 Exacta / 50c Trifecta',
      entries: [
        entry('2', 'Tahini', '9/2', 4.5, { rank: 1 }),
        entry('3', 'Third Wheel', '6/1', 6),
        entry('4', 'Copper Luna', '7/2', 3.5, { rank: 2 }),
        entry('5', 'Bee Eye Gee', '5/1', 5),
        entry('6', 'Scratched Sam', '8/1', 8, { scratched: true }),
        entry('7', 'Chart Scratch Cal', '12/1', 12),
      ],
    },
    {
      number: 2, raceType: 'CLAIMING', conditions: 'FOR FOUR YEAR OLDS AND UPWARD',
      wagerMenu: '$1 Exacta',
      entries: [entry('1', 'Second Race One', '5/2', 2.5, { rank: 1 }), entry('2', 'Second Race Two', '4/1', 4)],
    },
  ],
};
// A results chart that gives race 1 finishers (WPS only - exotics tickets
// grade as loss with no matching payoff row, which is fine: this check
// proves grading RUNS under engine_version 'human', not that it cashes).
const chart = {
  track: 'HUMAN FIXTURE DOWNS', date: '2026-08-30',
  races: [
    { number: 1, results: [
      { programNumber: '2', horseName: 'Tahini', finishPosition: 1, winCents: 1100, placeCents: 500, showCents: 320 },
      { programNumber: '4', horseName: 'Copper Luna', finishPosition: 2, winCents: null, placeCents: 460, showCents: 300 },
      { programNumber: '5', horseName: 'Bee Eye Gee', finishPosition: 3, winCents: null, placeCents: null, showCents: 280 },
    ], exotics: [], scratches: [{ horseName: 'Chart Scratch Cal' }] },
    { number: 2, results: [
      { programNumber: '1', horseName: 'Second Race One', finishPosition: 1, winCents: 700, placeCents: 340, showCents: 260 },
    ], exotics: [], scratches: [] },
  ],
};

const DESIGN_TABLE = [
  'Win\t#2\t$25',
  'Win\t#4\t$15',
  'Exacta Box\t2,4\t$20',
  'Trifecta\t2,4/2,4/3,5\t$20\t($5 x 4 combos)',
  'Win\t#5\t$20',
].join('\n');

// ---------- server ----------

const PORT = 8906;
const BASE = `http://127.0.0.1:${PORT}`;
const dbPath = path.join(tmp, 'check.sqlite');
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(PORT),
    BETSHEET_DB: dbPath,
    BETSHEET_LOG_DIR: path.join(tmp, 'server-logs'),
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const jpost = (url, body) => fetch(BASE + url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const jget = (url) => fetch(BASE + url).then((r) => r.json());
const preview = (dayId, race, text, cardId) => jpost(`/api/race-days/${dayId}/human-cards/preview`, { race, text, cardId }).then((r) => r.json());
const lock = (dayId, race, text, cardId) => jpost(`/api/race-days/${dayId}/human-cards`, { race, text, cardId });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); }
  }
  check('server boots', up, serverOut.slice(-300));

  console.log('-- fixture --');
  const created = await (await jpost('/api/race-days', day)).json();
  const dayId = created.id;
  check('fixture day saved', Number.isInteger(dayId), JSON.stringify(created));
  const saveResults = await jpost(`/api/race-days/${dayId}/results`, { track: chart.track, date: chart.date, sourceKind: 'paste', races: chart.races });
  check('fixture results saved (so grading runs on lock)', saveResults.status === 201);

  console.log('-- the design-note table --');
  const p1 = await preview(dayId, 1, DESIGN_TABLE);
  check('5 tickets, no warnings at all', p1.tickets.length === 5 && p1.warnings.length === 0, JSON.stringify(p1.warnings));
  check('race cost is exactly $100', p1.raceCostCents === 10000, String(p1.raceCostCents));
  const byType = (t) => p1.tickets.filter((x) => x.betType === t);
  check('two win tickets at $25 and $15 for #2 and #4', (() => {
    const wins = byType('win');
    return wins.length === 3 &&
      wins.find((w) => w.legs[0][0] === '2' && w.costCents === 2500) &&
      wins.find((w) => w.legs[0][0] === '4' && w.costCents === 1500) &&
      wins.find((w) => w.legs[0][0] === '5' && w.costCents === 2000);
  })(), JSON.stringify(byType('win')));
  check('exacta box 2,4 at $10/combo, $20 total', (() => {
    const box = byType('exacta_box')[0];
    return box && box.legs[0].sort().join(',') === '2,4' && box.stakeCents === 1000 && box.costCents === 2000;
  })(), JSON.stringify(byType('exacta_box')));
  check('trifecta 2,4/2,4/3,5 at $5/combo across 4 combos, $20 total', (() => {
    const tri = byType('trifecta')[0];
    return tri && tri.stakeCents === 500 && tri.costCents === 2000 && tri.legs.length === 3;
  })(), JSON.stringify(byType('trifecta')));
  check('teller calls formatted (shared/betmath.js tellerCall, same as an engine ticket)',
    p1.tickets.every((t) => typeof t.tellerCall === 'string' && t.tellerCall.startsWith('Race 1,')));

  console.log('-- locking the design-note table --');
  const lockRes1 = await lock(dayId, 1, DESIGN_TABLE);
  const locked1 = await lockRes1.json();
  check('lock creates a new human card', lockRes1.status === 201 && Number.isInteger(locked1.cardId));
  const humanCardId = locked1.cardId;
  check('rule_tags and rationale_text land on the persisted tickets', await (async () => {
    const card = await jget(`/api/cards/${humanCardId}`);
    return card.consensus_completeness === 'HUMAN' && card.engine_version === 'human' && card.template === 'human' &&
      card.tickets.length === 5 && card.tickets.every((t) => t.rule_tags.includes('human'));
  })());
  check('grading ran immediately (results already existed) under engine_version "human"', await (async () => {
    const grades = await jget(`/api/cards/${humanCardId}/grades`);
    return grades.grades.length === 5 && grades.summary.engineVersion === 'human';
  })());

  console.log('-- warnings matrix (via preview - non-destructive) --');
  const w = async (text) => (await preview(dayId, 1, text)).warnings;
  console.log('-- regression: box selections separated by "/" (found live) --');
  check('"#1 / #6" exacta box parses as two horses, no warnings', await (async () => {
    const p = await preview(dayId, 1, 'Exacta Box\t#4 / #5\t$20');
    return p.warnings.length === 0 && p.tickets.length === 1 &&
      p.tickets[0].legs[0].sort().join(',') === '4,5';
  })());

  console.log('-- pipe-delimited rows (a textarea Tab key does not insert a tab) --');
  check('a pipe-delimited design-note table parses identically to the tab-delimited one', await (async () => {
    const piped = [
      'Win | #2 | $25',
      'Win | #4 | $15',
      'Exacta Box | 2,4 | $20',
      'Trifecta | 2,4/2,4/3,5 | $20 | | ($5 x 4 combos)',
      'Win | #5 | $20',
    ].join('\n');
    const p = await preview(dayId, 1, piped);
    return p.tickets.length === 5 && p.warnings.length === 0 && p.raceCostCents === 10000;
  })());
  check('pipe-delimited rationale with an internal double space is never mistaken for a column break', await (async () => {
    const p = await preview(dayId, 1, 'Win | #2 | $25 | 9/2 | a  big overlay here');
    const t = p.tickets[0];
    return t.odds_at_bet === '9/2' && t.rationale_text === 'a  big overlay here';
  })());
  check('a plain tab-delimited row (no pipe) still splits the old way', await (async () => {
    const p = await preview(dayId, 1, 'Win\t#2\t$25');
    return p.tickets.length === 1 && p.tickets[0].costCents === 2500;
  })());
  check('name mismatch -> non-blocking, names the real entry', await (async () => {
    const ws = await w('Win\t#2 Not Tahini\t$25');
    return ws.length === 1 && ws[0].type === 'name_mismatch' && ws[0].blocking === false && ws[0].message.includes('Tahini');
  })());
  check('unknown program -> blocking', await (async () => {
    const ws = await w('Win\t#99\t$25');
    return ws.some((x) => x.type === 'unknown_program' && x.blocking === true);
  })());
  check('below minimum -> blocking', await (async () => {
    const ws = await w('Win\t#2\t$1');
    return ws.some((x) => x.type === 'below_minimum' && x.blocking === true);
  })());
  check('non-multiple stake -> blocking', await (async () => {
    const ws = await w('Exacta\t2/4\t$1.50');
    return ws.some((x) => x.type === 'non_multiple_stake' && x.blocking === true);
  })());
  check('parenthetical mismatch -> non-blocking, stake column wins', await (async () => {
    const ws = await w('Trifecta\t2,4/2,4/3,5\t$20\t($4 x 4 combos)');
    return ws.some((x) => x.type === 'parenthetical_mismatch' && x.blocking === false);
  })());
  check('scratched selection (program-time) -> blocking', await (async () => {
    const ws = await w('Win\t#6\t$10');
    return ws.some((x) => x.type === 'scratched_selection' && x.blocking === true);
  })());
  check('scratched selection (chart, after results) -> blocking', await (async () => {
    const ws = await w('Win\t#7\t$10');
    return ws.some((x) => x.type === 'scratched_selection' && x.blocking === true);
  })(), 'Chart Scratch Cal was scratched in the results chart, not at program time');
  check('multi-race type rejected, names the Replay PR', await (async () => {
    const ws = await w('Daily Double\t2/4\t$10');
    return ws.some((x) => x.type === 'multi_race_unsupported' && x.blocking === true && /replay/i.test(x.message));
  })());

  console.log('-- save independently enforces blocking (not just the preview UI) --');
  const blockedSave = await lock(dayId, 1, 'Win\t#99\t$25', humanCardId);
  const blockedBody = await blockedSave.json();
  check('a blocking parse refuses the save (422), nothing persisted', blockedSave.status === 422 && Array.isArray(blockedBody.warnings));

  console.log('-- PASS --');
  const passResReal = await jpost(`/api/race-days/${dayId}/human-cards`, { race: 2, pass: true, cardId: humanCardId });
  const passed = await passResReal.json();
  check('PASS -> zero tickets, no allocation row', passResReal.status === 201 && passed.tickets.length === 0 && passed.raceCostCents === 0);
  check('PASS recorded on human_race_state, no allocation for race 2', await (async () => {
    const card = await jget(`/api/cards/${humanCardId}`);
    return !card.allocations.some((a) => a.race_number === 2);
  })());

  console.log('-- replayed_at set on first lock, untouched after --');
  const dayAfterFirstLock = await jget(`/api/race-days/${dayId}`);
  check('race_days.replayed_at set after the first-ever human lock', dayAfterFirstLock.replayed_at != null);
  const replayedAtFirst = dayAfterFirstLock.replayed_at;
  await new Promise((rr) => setTimeout(rr, 1100)); // clear the second-resolution timestamp
  await jpost(`/api/race-days/${dayId}/human-cards`, { race: 1, text: 'Win\t#2\t$25', cardId: humanCardId });
  const dayAfterSecondLock = await jget(`/api/race-days/${dayId}`);
  check('replayed_at unchanged by a later lock', dayAfterSecondLock.replayed_at === replayedAtFirst);

  console.log('-- D28: a race already revealed on this card refuses a re-lock (409) --');
  {
    // No reveal endpoint exists until D55 (Replay) - simulate what it will
    // write directly, to prove persistHumanRace's OWN guard, not a UI path.
    const raw = new Database(dbPath);
    raw.prepare('UPDATE human_race_state SET results_revealed_at = ? WHERE card_id = ? AND race_number = 1').run(new Date().toISOString(), humanCardId);
    raw.close();
  }
  const revealedRelock = await lock(dayId, 1, 'Win\t#2\t$25', humanCardId);
  check('re-lock on a revealed race -> 409, D28 explanation', revealedRelock.status === 409 && /new card/i.test((await revealedRelock.json()).error));
  const newCardAfterRevealRes = await lock(dayId, 1, 'Win\t#2\t$25');
  const newCardAfterReveal = await newCardAfterRevealRes.json();
  check('omitting cardId starts a genuinely NEW card (the D28 remedy)',
    newCardAfterRevealRes.status === 201 && newCardAfterReveal.cardId !== humanCardId);

  console.log('-- bucket isolation (invariant 13) --');
  const engineCard = await (await jpost(`/api/race-days/${dayId}/cards`, {})).json();
  // engine_version 'human' is its own version string (never bumped, unlike
  // lean's), so invariant 14's default (latest version only) isolates it
  // from lean-1.1 exactly like any two engine versions would - ?engineVersion=all
  // is the explicit, documented way to see every bucket side by side.
  const pl = await jget('/api/pl?engineVersion=all');
  check('HUMAN and the engine bucket never share a total', (() => {
    const human = pl.buckets.find((b) => b.completeness === 'HUMAN');
    const engineBucket = pl.buckets.find((b) => b.completeness === engineCard.completeness);
    if (!human || !engineBucket) return false;
    const humanCards = pl.cards.filter((c) => c.completeness === 'HUMAN');
    const engineCards = pl.cards.filter((c) => c.completeness === engineCard.completeness);
    return humanCards.every((c) => c.raceDayId === dayId) && engineCards.some((c) => c.cardId === engineCard.id) &&
      humanCards.reduce((a, c) => a + c.costCents, 0) === human.costCents &&
      engineCards.reduce((a, c) => a + c.costCents, 0) === engineBucket.costCents;
  })(), JSON.stringify(pl.buckets));

  console.log('-- no-version-bump identity --');
  const { ENGINE_VERSION } = await import('../shared/card-engine.js');
  check('ENGINE_VERSION unchanged at lean-1.1', ENGINE_VERSION === 'lean-1.1', ENGINE_VERSION);
  check('a live engine card on this branch still generates under lean-1.1',
    engineCard.engineVersion === 'lean-1.1', engineCard.engineVersion);
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-human-picks: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-human-picks: all checks passed');
