// Verification for D55 (Replay) - exits non-zero on any failure.
// Run: npm run check-replay
//
// Phase 1: shared/replay.js's pure functions in isolation - computeBlindness
// (including the exact bug this PR fixes: a race locked AFTER another
// race's reveal makes the whole card sequential even if that race is
// never itself revealed), isCardClosed, and pickerAgreement's exclusion
// rule. Phase 2: the real server on a temp DB - the blind view's key-set
// discipline before/after reveal, the classification toggle, close(),
// standing's meet pooling and never-pooled dimensions, a day with no lean
// card, bucket isolation and the no-version-bump identity.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-replaycheck-'));
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'unit-logs');

const { computeBlindness, isCardClosed, pickerAgreement } = await import('../shared/replay.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

console.log('-- pure: computeBlindness --');
check('every lock before the first reveal -> PRE_COMMIT', computeBlindness({
  locks: ['2026-07-20T10:00:00Z', '2026-07-20T10:01:00Z', '2026-07-20T10:02:00Z'],
  reveals: ['2026-07-20T18:00:00Z'],
}) === 'PRE_COMMIT');
check('THE FIX: lock 1-8, reveal race 1, then lock race 5 -> SEQUENTIAL even though race 5 is never revealed', computeBlindness({
  locks: ['2026-07-20T10:00:00Z', '2026-07-20T10:01:00Z', '2026-07-20T10:02:00Z', '2026-07-20T10:03:00Z',
    '2026-07-20T18:05:00Z', // race 5's lock, AFTER the reveal below
    '2026-07-20T10:04:00Z', '2026-07-20T10:05:00Z', '2026-07-20T10:06:00Z'],
  reveals: ['2026-07-20T18:00:00Z'], // race 1's reveal
}) === 'SEQUENTIAL');
check('no reveal yet -> undetermined (null)', computeBlindness({ locks: ['2026-07-20T10:00:00Z'], reveals: [] }) === null);
check('a second human card on an already-replayed day -> NON_BLIND regardless of its own timestamps', computeBlindness({
  locks: ['2026-07-20T10:00:00Z'], reveals: ['2026-07-20T10:00:00Z'], isFirstHumanCardOfDay: false,
}) === 'NON_BLIND');

console.log('-- pure: isCardClosed --');
check('every race passed or revealed -> closed', isCardClosed({
  raceNumbers: [1, 2, 3],
  raceStates: [{ raceNumber: 1, passed: 1, resultsRevealedAt: null }, { raceNumber: 2, passed: 0, resultsRevealedAt: '2026-07-20T18:00:00Z' }, { raceNumber: 3, passed: 1, resultsRevealedAt: null }],
}));
check('one race with neither -> not closed', !isCardClosed({
  raceNumbers: [1, 2],
  raceStates: [{ raceNumber: 1, passed: 1, resultsRevealedAt: null }],
}));

console.log('-- pure: pickerAgreement --');
{
  const win = (pgm, outcome, returnedCents) => (pgm ? { outcome, returnedCents } : null);
  const rows = [
    { race: 1, humanWinTickets: [{ programNumber: '2', stakeCents: 2500 }], programRank1Pgm: '2', externalTopPgm: '2', humanTopGraded: win('2', 'win', 1100), programTopGraded: win('2', 'win', 1100) },
    { race: 2, humanWinTickets: [{ programNumber: '4', stakeCents: 1500 }], programRank1Pgm: '1', externalTopPgm: '4', humanTopGraded: win('4', 'loss', 0), programTopGraded: win('1', 'win', 600) },
    { race: 3, humanWinTickets: [], programRank1Pgm: '1', externalTopPgm: null, humanTopGraded: null, programTopGraded: null }, // excluded: no win ticket
    { race: 4, humanWinTickets: [{ programNumber: '2', stakeCents: 1000 }, { programNumber: '3', stakeCents: 1000 }], programRank1Pgm: '2', externalTopPgm: null, humanTopGraded: null, programTopGraded: null }, // excluded: tied stakes
  ];
  const pa = pickerAgreement(rows);
  check('two races considered, two excluded (one no-win-ticket, one tied)',
    pa.racesConsidered === 2 && pa.excludedRaces === 2 && pa.excludedReasons.no_win_ticket === 1 && pa.excludedReasons.tied_stakes === 1, JSON.stringify(pa));
  check('matches program rank 1 on race 1 only; matches the top external pick on races 1 and 2',
    pa.matchesProgramRank1 === 1 && pa.matchesExternalTop === 2, JSON.stringify(pa));
  check('human win% and flat ROI computed over the 2 considered races ($2 flat)',
    pa.humanWinPct === 0.5 && pa.humanFlatRoi === (1100 - 400) / 400, JSON.stringify(pa));
}

// ---------- server round-trip ----------

const PORT = 8907;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(PORT),
    BETSHEET_DB: path.join(tmp, 'check.sqlite'),
    BETSHEET_LOG_DIR: path.join(tmp, 'server-logs'),
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const jpost = (url, body = {}) => fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const jget = (url) => fetch(BASE + url).then((r) => r.json());

const entry = (pgm, name, ml, mld, opts = {}) => ({ programNumber: pgm, horseName: name, morningLine: ml, morningLineDecimal: mld, programRank: opts.rank ?? null, bestBet: false, scratched: Boolean(opts.scratched) });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); }
  }
  check('server boots', up, serverOut.slice(-300));

  console.log('-- fixture: a day with results but NO lean card yet --');
  const day = {
    track: 'Replay Fixture Downs', date: '2026-07-20', bankrollCents: 20000, perRaceMinCents: 500,
    races: [
      { number: 1, wagerMenu: '$1 Exacta', entries: [entry('1', 'One Runner', '5/2', 2.5, { rank: 1 }), entry('2', 'Two Runner', '4/1', 4)] },
      { number: 2, wagerMenu: '$1 Exacta', entries: [entry('1', 'Race Two One', '3/1', 3, { rank: 1 }), entry('2', 'Race Two Two', '5/1', 5)] },
    ],
  };
  const created = await (await jpost('/api/race-days', day)).json();
  const dayId = created.id;
  await jpost(`/api/race-days/${dayId}/results`, {
    track: 'REPLAY FIXTURE DOWNS', date: '2026-07-20', sourceKind: 'paste',
    races: [
      { number: 1, results: [{ programNumber: '1', horseName: 'One Runner', finishPosition: 1, winCents: 700, placeCents: 340, showCents: 260 }], exotics: [], scratches: [] },
      { number: 2, results: [{ programNumber: '2', horseName: 'Race Two Two', finishPosition: 1, winCents: 1200, placeCents: 600, showCents: 440 }], exotics: [], scratches: [] },
    ],
  });

  console.log('-- blind view: key-set discipline pre-reveal --');
  const humanCardCreate = await (await jpost(`/api/race-days/${dayId}/human-cards`, { race: 1, text: 'Win\t#1\t$25', bankrollCents: 20000 })).json();
  const humanCardId = humanCardCreate.cardId;
  const blind1 = await jget(`/api/replay/days/${dayId}/races/1?cardId=${humanCardId}`);
  // D112 removed the `consensus` block from the blind view entirely, so it
  // joins the forbidden list rather than being inspected for what it hides:
  // the strongest form of "the engine's read stays hidden" is that there is
  // no engine and no read.
  const forbidden = ['results', 'finishOrder', 'payoffs', 'leanTickets', 'leanGraded',
    'classification', 'topVotes', 'contrarianFlags', 'consensus'];
  check('no results/lean/consensus keys before reveal', forbidden.every((k) => !(k in blind1)), JSON.stringify(Object.keys(blind1)));
  check('locked true, tickets present, humanCardId echoed', blind1.locked === true && blind1.tickets.length === 1 && blind1.humanCardId === humanCardId);
  // D86: the builder's edit affordance keys on anyRevealed - editing a locked
  // race after any reveal would re-stamp picks_locked_at and silently flip the
  // card PRE_COMMIT -> SEQUENTIAL, so the UI must be able to ask.
  const summaryPreReveal = await jget(`/api/replay/cards/${humanCardId}/summary`);
  check('summary.anyRevealed is false before the first reveal', summaryPreReveal.anyRevealed === false, JSON.stringify(summaryPreReveal));
  check('summary carries no outcome fields beyond the totals it already had',
    !('finishOrder' in summaryPreReveal) && !('payoffs' in summaryPreReveal) && !('classification' in summaryPreReveal),
    JSON.stringify(Object.keys(summaryPreReveal)));

  console.log('-- reveal on a day with NO lean card -> leanGraded null, not a throw --');
  const revealNoLean = await jpost(`/api/replay/cards/${humanCardId}/races/1/reveal`);
  const revealNoLeanBody = await revealNoLean.json();
  check('reveal succeeds with leanGraded/leanRacePl null', revealNoLean.status === 200 && revealNoLeanBody.leanGraded === null && revealNoLeanBody.leanRacePl === null, JSON.stringify(revealNoLeanBody));
  check('reveal a second time -> 409', (await jpost(`/api/replay/cards/${humanCardId}/races/1/reveal`)).status === 409);

  console.log('-- blind view after reveal: fields now present (re-navigating does not hide them) --');
  const blind1After = await jget(`/api/replay/days/${dayId}/races/1?cardId=${humanCardId}`);
  check('finishOrder/payoffs/humanGraded present now', Array.isArray(blind1After.finishOrder) && Array.isArray(blind1After.humanGraded));
  check('the actual betting card is reconstructable: each graded ticket carries its tellerCall (not just outcome/plCents)', (() => {
    const g = blind1After.humanGraded[0];
    return g && g.ticket.tellerCall === '$25 W 1' && g.ticket.betType === 'win' && g.outcome === 'win' && g.plCents === 6250;
  })(), JSON.stringify(blind1After.humanGraded));

  const summaryPostReveal = await jget(`/api/replay/cards/${humanCardId}/summary`);
  check('summary.anyRevealed flips to true once a race is revealed', summaryPostReveal.anyRevealed === true, JSON.stringify(summaryPostReveal));

  // D87: the day landing feeds the day-level ticket builder, so it now carries
  // entries + wagerMenu per race. Same key-set discipline as the blind view one
  // level up: pre-race data only, never an unrevealed race's outcome.
  console.log('-- day landing carries what the builder needs, and nothing more --');
  const landing = await jget(`/api/replay/days/${dayId}/races?cardId=${humanCardId}`);
  check('every landing row carries entries and a wagerMenu key', landing.races.length > 0
    && landing.races.every((r) => Array.isArray(r.entries) && 'wagerMenu' in r),
    JSON.stringify(landing.races.map((r) => ({ n: r.raceNumber, e: r.entries?.length }))));
  check('landing entries carry the fields the builder renders', (() => {
    const e = landing.races[0].entries[0];
    return e && typeof e.programNumber === 'string' && typeof e.horseName === 'string'
      && typeof e.scratched === 'boolean' && 'morningLine' in e;
  })(), JSON.stringify(landing.races[0].entries[0]));
  check('landing entries agree with the blind view for the same race', (() => {
    const fromLanding = landing.races.find((r) => r.raceNumber === 1).entries;
    return JSON.stringify(fromLanding) === JSON.stringify(blind1After.entries);
  })());
  check('an UNREVEALED landing row leaks no outcome (null PL, no finishOrder/payoffs/classification)', (() => {
    const unrevealed = landing.races.filter((r) => !r.revealed);
    return unrevealed.length > 0 && unrevealed.every((r) => r.humanRacePl === null && r.leanRacePl === null
      && !('finishOrder' in r) && !('payoffs' in r) && !('classification' in r));
  })(), JSON.stringify(landing.races.filter((r) => !r.revealed)));
  check('a locked race carries its own tickets so the modal can show them read-only', (() => {
    const locked = landing.races.find((r) => r.locked && !r.pass);
    return locked && Array.isArray(locked.tickets) && locked.tickets.length === 1
      && locked.tickets[0].tellerCall === '$25 W 1';
  })(), JSON.stringify(landing.races.filter((r) => r.locked)));
  check('an unplayed race has no tickets', (() => {
    const unplayed = landing.races.find((r) => !r.locked);
    return unplayed && unplayed.tickets === null;
  })());

  // The classification toggle and its one-way reveal lived here: a card could
  // opt into seeing the engine's D09 read of a race before locking it, and
  // the assertions checked that it stayed hidden by default and could never
  // be un-seen. D111 deleted the engine and D112 the classification, so there
  // is no read to reveal and POST .../reveal-classification is gone. The
  // `cards.saw_classification` column stays (shipped migrations are
  // immutable) and every card that set it keeps its recorded fact - the
  // standing table still groups by it, which is asserted further down.

  console.log('-- close(): PASSes the unlocked race, is idempotent, preserves PRE_COMMIT --');
  const summaryBeforeClose = await jget(`/api/replay/cards/${humanCardId}/summary`);
  check('not closed yet (race 2 never locked)', summaryBeforeClose.closed === false);
  const closed1 = await (await jpost(`/api/replay/cards/${humanCardId}/close`)).json();
  check('closed after close(), blindness determined', closed1.closed === true && closed1.blindness != null, JSON.stringify(closed1));
  const closed2 = await (await jpost(`/api/replay/cards/${humanCardId}/close`)).json();
  check('close() is idempotent', closed2.closed === true && closed2.blindness === closed1.blindness);

  console.log('-- a genuinely first-and-only card on a FRESH day still reads PRE_COMMIT after close() --');
  // A second card on `dayId` would be NON_BLIND unconditionally by design
  // (any card but the day's first is - the system cannot prove the human
  // wasn't influenced by an earlier attempt on the same day), so proving a
  // clean PRE_COMMIT needs a day where the human card really is the first.
  // A different DATE, not a different track name: canonicalizeTrack's
  // fallback code is the first 3 letters, and "...Downs" / "...Downs Two"
  // collide on "REP" - found running this check.
  const day2 = await (await jpost('/api/race-days', { ...day, date: '2026-07-21' })).json();
  const day2Id = day2.id;
  await jpost(`/api/race-days/${day2Id}/results`, {
    track: 'REPLAY FIXTURE DOWNS', date: '2026-07-21', sourceKind: 'paste',
    races: [
      { number: 1, results: [{ programNumber: '1', horseName: 'One Runner', finishPosition: 1, winCents: 700, placeCents: 340, showCents: 260 }], exotics: [], scratches: [] },
      { number: 2, results: [{ programNumber: '2', horseName: 'Race Two Two', finishPosition: 1, winCents: 1200, placeCents: 600, showCents: 440 }], exotics: [], scratches: [] },
    ],
  });
  const preCommitCard = await (await jpost(`/api/race-days/${day2Id}/human-cards`, { race: 1, pass: true })).json();
  const preCommitCardId = preCommitCard.cardId;
  await jpost(`/api/race-days/${day2Id}/human-cards`, { race: 2, pass: true, cardId: preCommitCardId });
  const preCommitClosed = await (await jpost(`/api/replay/cards/${preCommitCardId}/close`)).json();
  check('the day\'s first (and only) card, every race PASSed then closed in one call -> PRE_COMMIT',
    preCommitClosed.blindness === 'PRE_COMMIT', JSON.stringify(preCommitClosed));

  console.log('-- a SECOND card on the same day is NON_BLIND regardless of its own timestamps --');
  const secondCard = await (await jpost(`/api/race-days/${day2Id}/human-cards`, { race: 1, pass: true })).json();
  await jpost(`/api/race-days/${day2Id}/human-cards`, { race: 2, pass: true, cardId: secondCard.cardId });
  const secondClosed = await (await jpost(`/api/replay/cards/${secondCard.cardId}/close`)).json();
  check('a later human card on the same day is NON_BLIND even though it was ALSO played cleanly',
    secondClosed.blindness === 'NON_BLIND', JSON.stringify(secondClosed));

  console.log('-- day landing (D62): per-race status + PL without opening a race --');
  const daySummaryNoCard = await jget(`/api/replay/days/${dayId}/races`);
  check('no cardId -> every race unlocked, no PL', daySummaryNoCard.races.every((r) => r.locked === false && r.revealed === false && r.humanRacePl === null));
  const daySummary = await jget(`/api/replay/days/${dayId}/races?cardId=${humanCardId}`);
  check('one row per race, in order', daySummary.races.length === 2 && daySummary.races[0].raceNumber === 1 && daySummary.races[1].raceNumber === 2);
  check('race 1 revealed with the same human P/L the reveal payload showed',
    daySummary.races[0].revealed === true && daySummary.races[0].humanRacePl === 6250, JSON.stringify(daySummary.races[0]));
  check('race 2 was auto-passed by close(), never locked with tickets', daySummary.races[1].pass === true, JSON.stringify(daySummary.races[1]));

  console.log('-- standing: only closed cards count, meets pool by default --');
  const standing = await jget('/api/replay/standing');
  check('meets pooled by default (no ?meet= narrowing needed to see every group)', standing.selectedMeet === 'all');
  const totalStandingDays = standing.groups.reduce((a, g) => a + g.days, 0);
  check('standing counts exactly the 3 closed cards, none double-counted, none missing',
    totalStandingDays === 3, JSON.stringify(standing.groups.map((g) => ({ blindness: g.blindness, saw: g.sawClassification, days: g.days }))));
  check('blindness and sawClassification never pooled into one group',
    new Set(standing.groups.map((g) => `${g.blindness}::${g.sawClassification}`)).size === standing.groups.length);
  check('pickerAgreement line present on the standing response', typeof standing.pickerAgreement === 'object');

  // D87: the day-level builder's "lock all previewed races" is a sequential
  // loop that threads ONE card id - the first save mints it, every later race
  // must land on the SAME card - and locks every race before anything is
  // revealed. That is the shape PRE_COMMIT exists to detect, so assert the
  // semantics here rather than only in the UI.
  console.log('-- batch lock: one card, every lock before any reveal -> PRE_COMMIT --');
  {
    // No results needed: locking never requires them (grading just doesn't run),
    // and blindness is computed purely from the lock/reveal timestamps.
    const batchDay = await (await jpost('/api/race-days', { ...day, date: '2026-08-27' })).json();

    let batchCard = null;
    const locked = [];
    for (const n of [1, 2]) {
      const r = await (await jpost(`/api/race-days/${batchDay.id}/human-cards`, {
        race: n, text: n === 1 ? '$25 W 1' : '$10 W 1', bankrollCents: 20000, cardId: batchCard,
      })).json();
      batchCard = r.cardId;
      locked.push(r.cardId);
    }
    check('every race in the batch landed on ONE card (first save minted it)',
      locked.length === 2 && locked[0] === locked[1] && Number.isInteger(locked[0]), JSON.stringify(locked));

    const bt = await jget(`/api/replay/cards/${batchCard}/summary`);
    check('nothing revealed during the batch', bt.anyRevealed === false, JSON.stringify(bt));

    const landing2 = await jget(`/api/replay/days/${batchDay.id}/races?cardId=${batchCard}`);
    check('both batch-locked races report their tickets on the landing', (() => {
      const withTickets = landing2.races.filter((r) => Array.isArray(r.tickets) && r.tickets.length > 0);
      return withTickets.length === 2 && withTickets[0].tickets[0].tellerCall === '$25 W 1';
    })(), JSON.stringify(landing2.races.map((r) => ({ n: r.raceNumber, t: r.tickets?.length }))));

    const afterClose = await (await jpost(`/api/replay/cards/${batchCard}/close`)).json();
    check('a fully batch-locked day closes as PRE_COMMIT',
      afterClose.closed === true && afterClose.blindness === 'PRE_COMMIT', JSON.stringify(afterClose));

  }

  console.log('-- bucket isolation + no-version-bump identity (defense in depth) --');
  // The engine bucket this used to be held apart from is gone with the engine
  // (D111). What the HUMAN bucket must still never do is absorb a card from
  // another day or another producer, which is what is asserted here.
  const pl = await jget('/api/pl?engineVersion=all');
  check('HUMAN bucket present and holds only this day\'s human cards', (() => {
    const human = pl.buckets.find((b) => b.completeness === 'HUMAN');
    const humanCards = pl.cards.filter((c) => c.completeness === 'HUMAN');
    return Boolean(human) && humanCards.length > 0 &&
      humanCards.every((c) => c.raceDayId === dayId) &&
      humanCards.reduce((a, c) => a + c.costCents, 0) === human.costCents;
  })(), JSON.stringify(pl.buckets));
  check('no engine bucket exists any more - nothing generates one',
    !pl.buckets.some((b) => ['FULL', 'PARTIAL', 'PROGRAM_ONLY', 'ODDS_ONLY'].includes(b.completeness)),
    JSON.stringify(pl.buckets.map((b) => b.completeness)));
  const { ENGINE_VERSION } = await import('../shared/version.js');
  check('ENGINE_VERSION unchanged at lean-1.1', ENGINE_VERSION === 'lean-1.1', ENGINE_VERSION);
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-replay: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-replay: all checks passed');
