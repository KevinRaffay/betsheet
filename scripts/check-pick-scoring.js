// Verification for pick-source scoring, PS-1 (D220): shared/pick-scoring.js.
// Run: npm run check-pick-scoring
//
// PURE - no database, no server, no temp directory. Everything here is a
// hand-built race whose answer was worked out before the code ran.
//
// The assertions that matter most are about what the module REFUSES to
// claim: a role the source never backed is NULL, not a miss; a scratched
// primary is NULL, not promoted; every rate is NULL at n=0; sources are never
// pooled; and the favorite baseline is computed on the same races.

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const {
  rolesFromTickets, rolesFromTipPicks, scorePickRace, aggregatePickScores, bySource,
} = await import('../shared/pick-scoring.js');
const { scoreTipRace } = await import('../shared/tip-scoring.js');

// A real-shaped result: 6 won, 4 second, 2 third, 7 ran unplaced, 9 scratched.
const finishers = [
  { programNumber: '6', finishPosition: 1 }, { programNumber: '4', finishPosition: 2 },
  { programNumber: '2', finishPosition: 3 }, { programNumber: '7', finishPosition: null },
  { programNumber: '1', finishPosition: 4 }, { programNumber: '3', finishPosition: 5 },
];
const scratched = ['9'];
const entries = [
  { programNumber: '1', morningLineDecimal: 6 }, { programNumber: '2', morningLineDecimal: 2.5 },
  { programNumber: '3', morningLineDecimal: 12 }, { programNumber: '4', morningLineDecimal: 3.5 },
  { programNumber: '6', morningLineDecimal: 8 }, { programNumber: '7', morningLineDecimal: 20 },
  { programNumber: '9', morningLineDecimal: 2, scratched: true },   // the scratched ML favorite
];

console.log('-- rolesFromTickets: an OTR-shaped race --');
{
  // server/equibase-otr.js writes: show on the show pick, win on the win pick,
  // exacta boxes on box4 (show, win, +2) and box3.
  const otr = rolesFromTickets([
    { betType: 'show', legs: [['4']], stakeCents: 200, sequence: 1 },
    { betType: 'exacta_box', legs: [['4', '6', '2', '7']], stakeCents: 100, sequence: 2 },
    { betType: 'win', legs: [['6']], stakeCents: 200, sequence: 3 },
    { betType: 'exacta_box', legs: [['4', '6', '2']], stakeCents: 200, sequence: 4 },
  ]);
  check('win pick is winBacked and the primary', same(otr.winBacked, ['6']) && otr.primary === '6');
  check('show pick is showBacked, nothing is placeBacked', same(otr.showBacked, ['4']) && otr.placeBacked.length === 0);
  check('named is every horse on any ticket, de-duplicated', same([...otr.named].sort(), ['2', '4', '6', '7']));

  const s = scorePickRace({ roles: otr, finishers, scratched, entries });
  check('primary won: win/place/show all true', s.primaryWin === true && s.primaryPlace === true && s.primaryShow === true);
  check('show pick ran 2nd: showHit true', s.showHit === true);
  check('no place ticket: placeHit is NULL, not false', s.placeHit === null && s.placeBackedCount === 0);
  check('named all three real top-3 finishers', s.namedTop3 === 3 && s.top3Possible === 3);
  check('winner named', s.winnerProgramNumber === '6');
}

console.log('-- rolesFromTickets: an LLM race with three win tickets --');
{
  const llm = rolesFromTickets([
    { betType: 'win', legs: [['4']], stakeCents: 400, sequence: 1 },
    { betType: 'win', legs: [['6']], stakeCents: 1000, sequence: 2 },   // largest stake, written second
    { betType: 'win', legs: [['1']], stakeCents: 400, sequence: 3 },
    { betType: 'place', legs: [['7']], stakeCents: 200, sequence: 4 },
    { betType: 'trifecta', legs: [['4'], ['6'], ['3']], stakeCents: 100, sequence: 5 },
  ]);
  check('primary is the LARGEST stake, not the first written (user decision 2026-09-10)', llm.primary === '6');
  check('all three are winBacked', same([...llm.winBacked].sort(), ['1', '4', '6']));
  const s = scorePickRace({ roles: llm, finishers, scratched, entries });
  check('primary (6) won', s.primaryWin === true && s.anyWin === true);
  check('winBackedCount reports how much "any" is buying', s.winBackedCount === 3);
  check('place ticket on an unplaced also-ran: placeHit false (ran and lost, not unknown)',
    s.placeHit === false && s.unknownPicks.length === 0);

  // Same tickets, but the money is on the loser: primary and any now differ.
  const llm2 = rolesFromTickets([
    { betType: 'win', legs: [['1']], stakeCents: 1000, sequence: 1 },
    { betType: 'win', legs: [['6']], stakeCents: 200, sequence: 2 },
  ]);
  const s2 = scorePickRace({ roles: llm2, finishers, scratched, entries });
  check('primary lost but another win-backed horse won: primaryWin false, anyWin true',
    s2.primaryWin === false && s2.anyWin === true);

  // Ties on stake break by sequence (the first written).
  const tie = rolesFromTickets([
    { betType: 'win', legs: [['1']], stakeCents: 200, sequence: 5 },
    { betType: 'win', legs: [['6']], stakeCents: 200, sequence: 2 },
  ]);
  check('a stake tie breaks by lowest sequence', tie.primary === '6');
}

console.log('-- box-only race: nothing backed to win --');
{
  const box = rolesFromTickets([
    { betType: 'exacta_box', legs: [['6', '4']], stakeCents: 100, sequence: 1 },
    { betType: 'trifecta_box', legs: [['6', '4', '1']], stakeCents: 50, sequence: 2 },
  ]);
  check('winBacked empty, primary null, named full', box.winBacked.length === 0 && box.primary === null && box.named.length === 3);
  const s = scorePickRace({ roles: box, finishers, scratched, entries });
  check('scores (named is live) but every win/place/show role is NULL',
    s !== null && s.primaryWin === null && s.anyWin === null && s.placeHit === null && s.showHit === null);
  check('namedTop3 counts 6 and 4 out of 3', s.namedTop3 === 2 && s.top3Possible === 3);
}

console.log('-- scratches --');
{
  const roles = rolesFromTickets([
    { betType: 'win', legs: [['9']], stakeCents: 1000, sequence: 1 },   // scratched
    { betType: 'win', legs: [['6']], stakeCents: 200, sequence: 2 },
    { betType: 'show', legs: [['9']], stakeCents: 200, sequence: 3 },
  ]);
  const s = scorePickRace({ roles, finishers, scratched, entries });
  check('a scratched primary is NULL, not a miss, and NOT promoted to the next win ticket',
    s.primaryWin === null && s.primary === null && s.primaryScratched === true);
  check('  the other win-backed horse still scores anyWin', s.anyWin === true && s.winBackedCount === 1);
  check('  a show role whose only horse scratched is NULL', s.showHit === null && s.showBackedCount === 0);
  check('  scratches are counted, not hidden', s.scratchedCount === 1);

  const all = rolesFromTickets([{ betType: 'win', legs: [['9']], stakeCents: 200, sequence: 1 }]);
  check('every named horse scratched: the race scores null', scorePickRace({ roles: all, finishers, scratched, entries }) === null);
}

console.log('-- refusals and unknowns --');
{
  const roles = rolesFromTickets([{ betType: 'win', legs: [['6']], stakeCents: 200, sequence: 1 }]);
  check('no result on file: null', scorePickRace({ roles, finishers: [] }) === null);
  check('nothing named: null', scorePickRace({ roles: rolesFromTickets([]), finishers }) === null);
  check('null input does not throw', scorePickRace(null) === null);
  check('junk tickets do not throw', rolesFromTickets([null, {}, { betType: 'win' }]).named.length === 0);

  const ghost = scorePickRace({ roles: rolesFromTickets([
    { betType: 'win', legs: [['99']], stakeCents: 200, sequence: 1 },
  ]), finishers, scratched, entries });
  check('a program number in no result is SURFACED as unknown, and its primary scores false-not-thrown',
    same(ghost.unknownPicks, ['99']) && ghost.primaryWin === false);
  check('program numbers compare case- and whitespace-insensitively',
    scorePickRace({ roles: rolesFromTickets([{ betType: 'win', legs: [[' 6 ']], stakeCents: 200, sequence: 1 }]),
      finishers, scratched }).primaryWin === true);
}

console.log('-- the favorite baseline, on the same race --');
{
  const roles = rolesFromTickets([{ betType: 'win', legs: [['6']], stakeCents: 200, sequence: 1 }]);
  const s = scorePickRace({ roles, finishers, scratched, entries });
  check('the SCRATCHED lowest line (9 at 2/1) is not the favorite; 2 at 5/2 is',
    same(s.favorite.horseNos, ['2']) && s.favorite.morningLineDecimal === 2.5);
  check('favorite ran 3rd: show true, place false, win false',
    s.favorite.win === false && s.favorite.place === false && s.favorite.show === true);
  check('field size is the LIVE entries (7 minus the scratch)', s.fieldSize === 6);

  const tied = scorePickRace({ roles, finishers, scratched, entries: [
    { programNumber: '6', morningLineDecimal: 3 }, { programNumber: '2', morningLineDecimal: 3 },
    { programNumber: '7', morningLineDecimal: 9 },
  ] });
  check('a tied favorite is a hit if ANY tied horse got there, and is flagged',
    tied.favorite.tied === true && tied.favorite.win === true && same([...tied.favorite.horseNos].sort(), ['2', '6']));
  check('no entries: no favorite, field size falls back to the finisher count',
    scorePickRace({ roles, finishers, scratched }).favorite === null
    && scorePickRace({ roles, finishers, scratched }).fieldSize === 6);
  check('entries without a line: no favorite', scorePickRace({ roles, finishers, scratched,
    entries: [{ programNumber: '6', morningLineDecimal: null }] }).favorite === null);
}

console.log('-- rolesFromTipPicks agrees with D170 on a real tip_picks row --');
{
  // The stored shape, verbatim from the corpus (tip_picks.picks, 2026-09-10).
  const picks = [
    { horse_no: '3', horse_name: 'Cryster (NY)', rank: 1 },
    { horse_no: '5', horse_name: "Arch's Assault (NY)", rank: 2 },
    { horse_no: '7', horse_name: 'Palpable (KY)', rank: 3 },
  ];
  const fin = [
    { programNumber: '5', finishPosition: 1 }, { programNumber: '3', finishPosition: 2 },
    { programNumber: '1', finishPosition: 3 }, { programNumber: '7', finishPosition: 4 },
  ];
  const roles = rolesFromTipPicks([...picks].reverse());   // order on the way in must not matter
  check('rank 1 is winBacked and primary; ranks 1-3 are named; nothing place/show-backed',
    same(roles.winBacked, ['3']) && roles.primary === '3' && same([...roles.named].sort(), ['3', '5', '7'])
    && roles.placeBacked.length === 0 && roles.showBacked.length === 0);
  const mine = scorePickRace({ roles, finishers: fin });
  const d170 = scoreTipRace({ picks, finishers: fin });
  check('primary win/place/show == D170 top-pick win/place/show',
    mine.primaryWin === d170.win && mine.primaryPlace === d170.place && mine.primaryShow === d170.show);
  check('namedTop3 == D170 top3Overlap', mine.namedTop3 === d170.top3Overlap && mine.top3Possible === d170.top3Possible);
  check('empty / junk pick lists give empty roles', rolesFromTipPicks([]).named.length === 0 && rolesFromTipPicks(null).primary === null);
}

console.log('-- aggregate: every rate carries its own n --');
{
  const win6 = rolesFromTickets([{ betType: 'win', legs: [['6']], stakeCents: 200, sequence: 1 }]);
  const win1 = rolesFromTickets([{ betType: 'win', legs: [['1']], stakeCents: 200, sequence: 1 }]);
  const showOnly = rolesFromTickets([{ betType: 'show', legs: [['2']], stakeCents: 200, sequence: 1 }]);
  const scores = [
    scorePickRace({ roles: win6, finishers, scratched, entries }),
    scorePickRace({ roles: win1, finishers, scratched, entries }),
    scorePickRace({ roles: showOnly, finishers, scratched, entries }),
    null,   // a race with no result yet
  ];
  const a = aggregatePickScores(scores);
  check('n counts scored races; unscored counts the rest', a.n === 3 && a.unscored === 1);
  check('primaryWin: 1 of 2 (the show-only race is not in the denominator)',
    a.primaryWin.hits === 1 && a.primaryWin.n === 2 && a.primaryWin.rate === 0.5);
  check('show: 1 of 1', a.show.hits === 1 && a.show.n === 1 && a.show.rate === 1);
  check('place: nobody bet place - n=0, rate NULL, not 0', a.place.n === 0 && a.place.rate === null);
  check('namedTop3 over what was possible', a.namedTop3.hits === 2 && a.namedTop3.n === 9);
  check('meanWinBacked over races that backed something to win', a.meanWinBacked === 1);
  check('favorite baseline on the same 3 races: show 3/3, win 0/3',
    a.baselines.favoriteShow.hits === 3 && a.baselines.favoriteShow.n === 3
    && a.baselines.favoriteWin.hits === 0 && a.baselines.favoriteWin.n === 3);
  check('random baselines from field size 6', Math.abs(a.baselines.randomWin - 1 / 6) < 1e-12
    && Math.abs(a.baselines.randomTop3 - 0.5) < 1e-12 && a.baselines.meanFieldSize === 6);

  const empty = aggregatePickScores([null, null]);
  check('n=0: every rate NULL, every mean NULL, nothing 0-for-0',
    empty.n === 0 && empty.unscored === 2 && empty.primaryWin.rate === null && empty.anyWin.rate === null
    && empty.namedTop3.rate === null && empty.meanWinBacked === null && empty.baselines.favoriteWin.rate === null
    && empty.baselines.randomWin === null);
  check('aggregate of nothing at all does not throw', aggregatePickScores(undefined).n === 0);
}

console.log('-- bySource: never pooled --');
{
  const win6 = rolesFromTickets([{ betType: 'win', legs: [['6']], stakeCents: 200, sequence: 1 }]);
  const win1 = rolesFromTickets([{ betType: 'win', legs: [['1']], stakeCents: 200, sequence: 1 }]);
  const rows = [
    { source: 'EQB_OTR', score: scorePickRace({ roles: win6, finishers, scratched, entries }) },
    { source: 'EQB_OTR', score: scorePickRace({ roles: win1, finishers, scratched, entries }) },
    { source: 'claude-opus-5', score: scorePickRace({ roles: win1, finishers, scratched, entries }) },
    { source: 'trackmaster', score: null },
  ];
  const by = bySource(rows);
  check('one row per source, sorted by n desc then name', same(by.map((r) => r.source), ['EQB_OTR', 'claude-opus-5', 'trackmaster']));
  check('EQB_OTR 1 of 2; opus 0 of 1; trackmaster n=0 with NULL rates - no combined figure anywhere',
    by[0].primaryWin.hits === 1 && by[0].primaryWin.n === 2
    && by[1].primaryWin.hits === 0 && by[1].primaryWin.n === 1
    && by[2].n === 0 && by[2].primaryWin.rate === null
    && by.every((r) => !('all' in r)));
  check('bySource of nothing is an empty list', same(bySource([]), []) && same(bySource(null), []));
}

console.log(failures ? `\n${failures} FAILED` : '\nall pick-scoring checks passed');
process.exit(failures ? 1 : 0);
