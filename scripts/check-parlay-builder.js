// Verification for the WPS parlay builder (D436): shared/parlay-builder.js
// and its producer, server/combined-cards.js.
// Run: npm run check-parlay-builder
//
// The pure half builds parlays over hand-made race models whose best answer
// was worked out first. The producer half seeds a THROWAWAY temp database
// with the logger redirected there too (BETSHEET_DB alone is not isolation),
// then previews, saves, grades and reads the decision trace back.
//
// The assertions that matter most: the chosen parlay really is the argmax of
// P(all hit) under the floor; the floor is checked against the LOW estimate;
// every candidate carries BOTH the combined and the market P plus the
// calibration note; save refuses a parlay the rebuild no longer produces; the
// saved card lands in COMBINED under COMBINED_VERSION with race_id NULL; and
// ticket_added carries every leg's reasoning.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-parlay-'));
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const { buildWpsParlays, legMultiplier, KIND_BET_TYPE, CALIBRATION_NOTE } = await import('../shared/parlay-builder.js');
const { combineRace, MARKET_ONLY_WEIGHTS } = await import('../shared/race-consensus.js');
const { rolesFromTipPicks } = await import('../shared/pick-scoring.js');
const { BET, showEstimate, placeEstimate } = await import('../shared/betmath.js');
const { COMBINED_VERSION } = await import('../shared/version.js');
const { BUCKET_ORDER, BUCKET_CHIP } = await import('../shared/distribution.js');

// Three races. Race 1 has a heavy favorite, race 2 a moderate one, race 3 is
// wide open. Odds are the morning line (no board).
const field = (mls) => mls.map((ml, i) => ({ programNumber: String(i + 1), morningLineDecimal: ml }));
const ENTRIES = {
  1: field([0.5, 4, 6, 10, 15]),
  2: field([1.5, 2.5, 5, 8]),
  3: field([3, 3.5, 4, 5, 6, 8]),
};
const racesFor = (tips = {}) => Object.entries(ENTRIES).map(([n, entries]) => {
  const raceNumber = Number(n);
  const tipRoles = tips[raceNumber] ? [rolesFromTipPicks([{ horse_no: tips[raceNumber], rank: 1 }])] : [];
  const byPgm = new Map(entries.map((e) => [e.programNumber, e.morningLineDecimal]));
  return {
    raceNumber,
    combined: combineRace({ entries, tipRoles }),
    market: combineRace({ entries, weights: MARKET_ONLY_WEIGHTS }),
    oddsOf: (p) => byPgm.get(p) ?? null,
  };
});

/** Brute force the best P(all hit) independently of the builder, for one kind. */
function bruteBest(races, kind, legs, floor) {
  const key = { win: 'combinedP', place: 'placeP', show: 'showP' }[kind];
  let best = null;
  const lists = races.map((r) => r.combined.runners.slice().sort((a, b) => b[key] - a[key]).slice(0, 3)
    .map((x) => ({ race: r.raceNumber, pgm: x.programNumber, p: x[key], low: legMultiplier(kind, r.oddsOf(x.programNumber))[0] })));
  const rec = (i, chosen) => {
    if (chosen.length === legs) {
      const p = chosen.reduce((a, c) => a * c.p, 1);
      const low = chosen.reduce((a, c) => a * c.low, 1);
      if (floor !== null && low < floor) return;
      if (!best || p > best.p) best = { p, chosen: [...chosen] };
      return;
    }
    for (let j = i; j < lists.length; j++) for (const c of lists[j]) { chosen.push(c); rec(j + 1, chosen); chosen.pop(); }
  };
  rec(0, []);
  return best;
}

console.log('-- estimates --');
{
  check('win leg multiplier is exact at the odds', same(legMultiplier('win', 4), [5, 5]));
  check('place leg multiplier is placeEstimate per $1', same(legMultiplier('place', 4), placeEstimate(100, 4).map((c) => c / 100)));
  check('show leg multiplier is showEstimate per $1', same(legMultiplier('show', 4), showEstimate(100, 4).map((c) => c / 100)));
  check('show band is 1 + ml*0.065 .. 1 + ml*0.2 (the measured IQR)', same(showEstimate(200, 10), [330, 600]));
  check('no odds, no multiplier', legMultiplier('show', null) === null && legMultiplier('win', NaN) === null);
  check('parlay_place / parlay_show have minimums', BET.minimums.parlay_place === 200 && BET.minimums.parlay_show === 200);
}

console.log('-- the builder --');
{
  const races = racesFor();
  const out = buildWpsParlays({ races, kinds: ['show'], legsMin: 2, legsMax: 2, limit: 3 });
  const brute = bruteBest(races, 'show', 2, null);
  check('no error', out.error === null, out.error);
  check('the top candidate is the brute-force argmax of P(all hit)', near(out.candidates[0].pHit, brute.p),
    `${out.candidates[0].pHit} vs ${brute.p}`);
  check('candidates are sorted best first', out.candidates.every((c, i, a) => i === 0 || a[i - 1].pHit >= c.pHit));
  const top = out.candidates[0];
  check('shape: parlay_show, one horse per leg, race order', top.betType === 'parlay_show' && top.legs.every((l) => l.length === 1)
    && top.raceNumbers.every((n, i, a) => i === 0 || a[i - 1] < n));
  check('both probabilities carried, plus the calibration note', typeof top.combinedPHit === 'number'
    && typeof top.marketPHit === 'number' && top.calibration === CALIBRATION_NOTE);
  check('the teller call names the races and the kind', /^Races \d+-\d+ \$2 SHOW PARLAY /.test(top.tellerCall), top.tellerCall);
  check('estimate band is low <= high, and a range for show', top.estMinCents <= top.estMaxCents && top.estIsRange === true);

  // The floor must bind on the LOW end: pick a floor between the top
  // candidate's low and high, and it must be excluded.
  const lowMult = top.estMinCents / top.stakeCents;
  const highMult = top.estMaxCents / top.stakeCents;
  if (highMult > lowMult) {
    const floor = (lowMult + highMult) / 2;
    const floored = buildWpsParlays({ races, kinds: ['show'], legsMin: 2, legsMax: 2, payoutFloor: floor, limit: 20 });
    check('a floor above the LOW estimate excludes the candidate even though its HIGH clears it',
      !floored.candidates.some((c) => c.tellerCall === top.tellerCall));
    check('every floored candidate clears the floor at its low end', floored.candidates.every((c) => c.estMinCents / c.stakeCents >= floor - 1e-9));
    const bf = bruteBest(races, 'show', 2, floor);
    check('the floored top candidate is the brute-force argmax under the floor', bf ? near(floored.candidates[0].pHit, bf.p) : floored.candidates.length === 0);
  }

  const win = buildWpsParlays({ races, kinds: ['win'], legsMin: 2, legsMax: 3, limit: 50 });
  check('win parlays price exactly (not a range)', win.candidates.every((c) => c.betType === 'parlay' && c.estIsRange === false && c.estMinCents === c.estMaxCents));
  check('legsMin..legsMax both appear', new Set(win.candidates.map((c) => c.legs.length)).size === 2);
  check('P(hit) of a parlay is the product of its legs', win.candidates.every((c) => near(c.pHit, c.legDetail.reduce((a, l) => a * l.pHit, 1))));

  const all = buildWpsParlays({ races, legsMin: 2, legsMax: 2, limit: 100 });
  check('show parlays out-rank place, place out-rank win at the top', all.candidates[0].kind === 'show');
  check('every kind maps to its own bet type', Object.entries(KIND_BET_TYPE).every(([k, t]) => all.candidates.filter((c) => c.kind === k).every((c) => c.betType === t)));

  // A tip vote on #4 (5/1) lifts it past #3 (4/1) into race 3's top three
  // for the combined selection; the market selection never sees the vote.
  const tipped = racesFor({ 3: '4' });
  const comb = buildWpsParlays({ races: tipped, kinds: ['win'], legsMin: 2, legsMax: 2, limit: 100, selection: 'combined' });
  const mkt = buildWpsParlays({ races: tipped, kinds: ['win'], legsMin: 2, legsMax: 2, limit: 100, selection: 'market' });
  const pOf = (res, pgm) => res.candidates.find((c) => c.raceNumbers.includes(3) && c.legs[c.raceNumbers.indexOf(3)][0] === pgm);
  check('selection=market ignores the source votes', mkt.candidates.every((c) => near(c.pHit, c.marketPHit)));
  check('selection=combined uses them', comb.candidates.every((c) => near(c.pHit, c.combinedPHit)));
  const c4 = pOf(comb, '4');
  check('the tipped horse reaches the combined candidates, carrying its vote', c4 && c4.legDetail.find((l) => l.race === 3).votes.tipTop === 1);
  check('...and never the market-selected ones', !pOf(mkt, '4'));

  check('refuses a stake under the minimum', buildWpsParlays({ races, stakeCents: 100 }).error !== null);
  check('refuses more legs than parlayLegsMax', buildWpsParlays({ races, legsMax: BET.parlayLegsMax + 1 }).error !== null);
  check('refuses an unknown selection', buildWpsParlays({ races, selection: 'vibes' }).error !== null);
  check('refuses no usable kind', buildWpsParlays({ races, kinds: ['exacta'] }).error !== null);
  check('a null race model is skipped and reported', (() => {
    const r = buildWpsParlays({ races: [...races, { raceNumber: 9, combined: null, market: null, oddsOf: () => null }] });
    return r.error === null && r.skippedRaces.includes(9);
  })());
  check('an impossible floor returns no candidates, not an error', (() => {
    const r = buildWpsParlays({ races, payoutFloor: 1e9 });
    return r.error === null && r.candidates.length === 0;
  })());
}

console.log('-- menuPools: which pools start at a race (real menu shapes) --');
{
  const { menuPools, parseWagerMenu } = await import('../shared/betmath.js');
  const a = menuPools('Daily Double / Exacta / Trifecta / Superfecta / Pick 3 (Races 2-3-4) Pick 4 (Races 2-3-4-5) / Super Hi-5 / Odd vs Even', 2);
  check('an amount-less menu still offers its pools', Boolean(a.daily_double && a.pick3 && a.pick4));
  check('...over the printed legs', same(a.pick3.races, [2, 3, 4]) && same(a.pick4.races, [2, 3, 4, 5]) && same(a.daily_double.races, [2, 3]));
  check('...at an ASSUMED base, labelled so', a.pick3.baseSource === 'assumed' && a.pick4.baseCents === 100);
  const b = menuPools('Exacta ($1), Trifecta (.50), Super (.10), Double ($1) 3 & 4, Pick 3 ($1) (3-5) Mandatory Pay Pick 5 (.50) (3-7)', 3);
  check('trailing parenthetical amounts and a (3-5) range', b.pick3.baseCents === 100 && b.pick3.baseSource === 'menu' && same(b.pick3.races, [3, 4, 5]));
  check('a Pick 5 range (3-7) expands to five legs', same(b.pick5.races, [3, 4, 5, 6, 7]) && b.pick5.baseCents === 50);
  check('a double "($1) 3 & 4"', same(b.daily_double.races, [3, 4]) && b.daily_double.baseCents === 100);
  const c = menuPools('$1 Exacta / $1 Trifecta / $2 Rolling Double / $1 Superfecta (.10 Min.) $1 Pick Three (Races 1-2-3) / $0.50 Pick 5 (Races 1-5)', 1);
  check('"Pick Three" is Pick 3, at its printed $1', c.pick3?.baseCents === 100 && c.pick3.baseSource === 'menu');
  check('parseWagerMenu reads "$1 Pick Three" as $1, not the 50c fallback', parseWagerMenu('$1 Pick Three (Races 1-2-3)').pick3 === 100);
  const d = menuPools('Rolling Double / Exacta / 0.20 Trifecta / 0.20 Superfecta 0 0.20 Pick 3 (Races 9-10-11) / 0.20 Pick 4 (Races 4-5-6-7)/$1 Swinger', 9);
  check('a printed list that starts at ANOTHER race is not offered here (the real race-9 typo)', Boolean(d.pick3) && !d.pick4);
  check('20c bare-decimal amounts are read', d.pick3.baseCents === 20);
  check('no menu, no pools', Object.keys(menuPools(null, 1)).length === 0);
  // Gulfstream's real race-2 menu: a NON-consecutive Pick 3 must not become a rolling one.
  const g = menuPools('$1 Daily Double /$1 Exacta / $.50 Trifecta / $.10 Superfecta $1 Bet 3 (Races 2-3-4) / $.50 Pick 4 (Races 2-3-4-5) $1 Players Place Pick 8 (Races 2-9) / $3 Tropical Turf Pick 3 (Races 2, 6, 9)', 2);
  check('a non-consecutive printed list (Races 2, 6, 9) is not offered, never read as rolling', !g.pick3 && same(g.pick4?.races, [2, 3, 4, 5]) && g.pick4.baseCents === 50);
  // Remington Park prints the minimum AFTER the race list, as "(.50 Cent Minimum)".
  const e = menuPools('WPS / Exacta / Trifecta (.20 Cent Minimum) / Superfecta (.10 Cent Minimum) Pick 3 (Races 3-4-5) (.20 Cent Minimum)', 3);
  check('an amount AFTER the race list is read, and labelled as printed', e.pick3?.baseCents === 20 && e.pick3.baseSource === 'menu' && same(e.pick3.races, [3, 4, 5]));
  check('".20 Cent Minimum" is 20c on the single-race bets too', parseWagerMenu('Trifecta (.20 Cent Minimum) / Superfecta (.10 Cent Minimum)').trifecta === 20
    && parseWagerMenu('Trifecta (.20 Cent Minimum)').superfecta === BET.minimums.superfecta);
}

console.log('-- pool tickets (Daily Double / Pick N) --');
{
  const { buildPoolTickets, POOL_TYPES } = await import('../shared/parlay-builder.js');
  const menus = { 1: '$1 Daily Double / $1 Exacta / .50 Pick 3 (Races 1-2-3)', 2: '$1 Daily Double / $1 Exacta', 3: '$1 Exacta' };
  const races = racesFor().map((r) => ({ ...r, wagerMenu: menus[r.raceNumber] }));
  const out = buildPoolTickets({ races, pools: ['daily_double', 'pick3'], budgetCents: 1200, limit: 10 });
  check('no error', out.error === null, out.error);
  const dd = out.candidates.filter((c) => c.betType === 'daily_double');
  const p3 = out.candidates.find((c) => c.betType === 'pick3');
  check('doubles start where the menu offers one (races 1-2 and 2-3), never at race 3', same(dd.map((c) => c.raceNumbers).sort(), [[1, 2], [2, 3]]));
  check('the pick 3 covers races 1-3 at the menu\'s 50c base', p3 && same(p3.raceNumbers, [1, 2, 3]) && p3.stakeCents === 50 && p3.baseSource === 'menu');
  check('every ticket fits the budget, and cost = base x combinations',
    out.candidates.every((c) => c.costCents <= 1200 && c.costCents === c.stakeCents * c.legs.reduce((a, l) => a * l.length, 1)));
  check('P(hit) is the product of leg coverages', out.candidates.every((c) => near(c.pHit, c.legDetail.reduce((a, l) => a * l.pHit, 1))));
  check('a leg spreads to more than one horse when the budget allows', p3.legs.some((l) => l.length > 1));
  check('each leg holds its most likely horses (as a set)', p3.legDetail.every((l) => {
    const race = races.find((r) => r.raceNumber === l.race);
    const top = race.combined.runners.slice(0, l.programNumbers.length).map((x) => x.programNumber);
    return same([...top].sort(), [...l.programNumbers].sort());
  }));
  check('each leg lists its horses in program-number order, the teller order', out.candidates.every((c) =>
    c.legs.every((leg) => leg.every((pgm, i) => i === 0 || Number(leg[i - 1]) < Number(pgm)))));
  check('both coverages and the calibration note ride along', out.candidates.every((c) => typeof c.combinedPHit === 'number' && typeof c.marketPHit === 'number' && c.calibration === CALIBRATION_NOTE));
  check('estimate band low <= high', out.candidates.every((c) => c.estMinCents <= c.estMaxCents && c.estIsRange));
  check('teller call names the pool and the races', /^Races 1-2-3 \$0\.50 PICK 3 /.test(p3.tellerCall) || /^Races 1-2-3 50c PICK 3 /.test(p3.tellerCall), p3.tellerCall);
  const bigger = buildPoolTickets({ races, pools: ['pick3'], budgetCents: 4800 }).candidates[0];
  check('a bigger budget never LOWERS the chance of hitting', bigger.pHit >= p3.pHit - 1e-12);
  const floored = buildPoolTickets({ races, pools: ['pick3'], budgetCents: 4800, payoutFloor: 3 });
  check('a payout floor holds at the pessimistic estimate over COST', floored.candidates.every((c) => c.estMinCents / c.costCents >= 3 - 1e-9));
  check('a base bigger than the budget is skipped with a reason', (() => {
    const r = buildPoolTickets({ races, pools: ['pick3'], budgetCents: 40 });
    return r.candidates.length === 0 && r.skipped.some((s) => /exceeds the budget/.test(s.reason));
  })());
  check('pick 6 is not buildable (no estimate exists)', !POOL_TYPES.includes('pick6') && buildPoolTickets({ races, pools: ['pick6'] }).error !== null);
  check('selection=market coverage equals market coverage', buildPoolTickets({ races, pools: ['pick3'], selection: 'market' }).candidates.every((c) => near(c.pHit, c.marketPHit)));
}

console.log('-- the bucket --');
check('COMBINED is in BUCKET_ORDER with a chip', BUCKET_ORDER.includes('COMBINED') && BUCKET_CHIP.COMBINED === 'combined');
check('COMBINED_VERSION is not a lean-* version (grades under its own label)', !/^lean-/.test(COMBINED_VERSION));

console.log('-- the producer, on a temp database --');
{
  const { openDb } = await import('../server/db.js');
  const { seedTemplates } = await import('../server/templates.js');
  const { previewCombinedParlays, persistCombinedParlay, readOptions } = await import('../server/combined-cards.js');
  const db = openDb(process.env.BETSHEET_DB);
  seedTemplates(db);

  const dayId = db.prepare("INSERT INTO race_days (track, date, correlation_id, bankroll_cents) VALUES ('Del Mar', '2026-08-30', 'corr-day', 20000)").run().lastInsertRowid;
  const day = () => db.prepare('SELECT * FROM race_days WHERE id = ?').get(dayId);
  for (const [n, entries] of Object.entries(ENTRIES)) {
    // D442: race 1 prints a Pick 3 over races 1-3 at 50c; races 1-2 a $1 double.
    const menu = { 1: '.50 Pick 3 (Races 1-2-3) / $1 Daily Double / $1 Exacta', 2: '$1 Daily Double / $1 Exacta', 3: '$1 Exacta' }[n];
    const raceId = db.prepare('INSERT INTO races (race_day_id, number, wager_menu) VALUES (?, ?, ?)').run(dayId, Number(n), menu).lastInsertRowid;
    for (const e of entries) {
      db.prepare('INSERT INTO entries (race_id, program_number, horse_name, morning_line_decimal) VALUES (?, ?, ?, ?)')
        .run(raceId, e.programNumber, `Horse ${n}-${e.programNumber}`, e.morningLineDecimal);
    }
  }
  const options = readOptions({ kinds: ['show'], legsMin: 2, legsMax: 2, stakeCents: 200, limit: 5 });
  const p1 = previewCombinedParlays(db, dayId, options);
  check('preview returns both selections', p1.candidates.combined.length > 0 && p1.candidates.market.length > 0);
  check('preview names the model version, weights and calibration', p1.modelVersion === COMBINED_VERSION && p1.weights.maxBump > 0 && p1.calibration === CALIBRATION_NOTE);
  check('preview writes nothing', db.prepare('SELECT COUNT(*) n FROM cards').get().n === 0);
  check('preview reports no results on file yet', p1.resultsOnFile === false);

  const pick = p1.candidates.combined[0];
  const saved = persistCombinedParlay(db, day(), {
    options, choice: { selection: 'combined', betType: pick.betType, raceNumbers: pick.raceNumbers, legs: pick.legs },
    name: 'test parlay', correlationId: 'corr-parlay-1',
  });
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(saved.cardId);
  const tickets = db.prepare('SELECT * FROM tickets WHERE card_id = ?').all(saved.cardId);
  check('saved card: COMBINED bucket, COMBINED_VERSION, combined template, named',
    card.consensus_completeness === 'COMBINED' && card.engine_version === COMBINED_VERSION && card.name === 'test parlay'
    && db.prepare('SELECT name FROM strategy_templates WHERE id = ?').get(card.strategy_template_id).name === 'combined');
  check('variant records which model chose the legs', card.variant === 'combined-legs');
  check('one ticket, race_id NULL, selections {races, legs}', tickets.length === 1 && tickets[0].race_id === null
    && same(JSON.parse(tickets[0].selections), { races: pick.raceNumbers, legs: pick.legs }));
  check('ticket carries the teller call and the estimate band', tickets[0].teller_call === pick.tellerCall
    && tickets[0].est_payout_min_cents === pick.estMinCents && tickets[0].est_is_range === 1);
  check('no results yet: not graded', saved.graded === null);
  check('the response names the day card number the UI shows', saved.cardNumber === card.card_number);

  // A tampered choice, never shown by the preview, is refused.
  let refused = null;
  try {
    persistCombinedParlay(db, day(), { options, choice: { selection: 'combined', betType: 'parlay_show', raceNumbers: [1, 2], legs: [['5'], ['4']] }, correlationId: 'corr-x' });
  } catch (err) { refused = err; }
  check('a parlay the rebuild does not produce is refused 409', refused?.status === 409, refused?.message);

  // Results arrive: every leg of the saved parlay shows, so it cashes.
  const results = db.prepare('INSERT INTO race_results (race_day_id, race_number, program_number, finish_position, win_cents, place_cents, show_cents) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [i, raceNo] of pick.raceNumbers.entries()) {
    const pgm = pick.legs[i][0];
    const others = ENTRIES[raceNo].map((e) => e.programNumber).filter((p) => p !== pgm);
    results.run(dayId, raceNo, others[0], 1, 600, 400, 300);
    results.run(dayId, raceNo, pgm, 2, null, 380, 260);
    results.run(dayId, raceNo, others[1], 3, null, null, 340);
  }
  const p2 = previewCombinedParlays(db, dayId, options);
  check('with results on file, the preview says so', p2.resultsOnFile === true);
  const pick2 = p2.candidates.market[0];
  const saved2 = persistCombinedParlay(db, day(), {
    options, choice: { selection: 'market', betType: pick2.betType, raceNumbers: pick2.raceNumbers, legs: pick2.legs },
    correlationId: 'corr-parlay-2',
  });
  check('a second save mints a second card (append-only)', saved2.cardId !== saved.cardId
    && db.prepare("SELECT COUNT(*) n FROM cards WHERE consensus_completeness = 'COMBINED'").get().n === 2);
  check('market-selected card records its variant', db.prepare('SELECT variant FROM cards WHERE id = ?').get(saved2.cardId).variant === 'market-legs');
  check('saved with results on file: graded immediately under COMBINED_VERSION', saved2.graded?.engineVersion === COMBINED_VERSION);

  const { gradeAndPersist } = await import('../server/grading.js');
  const g1 = gradeAndPersist(db, saved.cardId, 'corr-regrade');
  const expected = Math.round(200 * (260 / 200) * (260 / 200));
  check('the first card grades as a show parlay at the chart\'s show prices',
    g1.engineVersion === COMBINED_VERSION && g1.grades[0].outcome === 'win' && g1.grades[0].returnedCents === expected,
    JSON.stringify(g1.grades[0]));

  const events = fs.readdirSync(process.env.BETSHEET_LOG_DIR).filter((f) => f.startsWith('decision-trace'))
    .flatMap((f) => fs.readFileSync(path.join(process.env.BETSHEET_LOG_DIR, f), 'utf8').split(/\r?\n/))
    .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const mine = events.filter((e) => e.correlationId === 'corr-parlay-1');
  const gen = mine.find((e) => e.event === 'card_generated');
  const added = mine.find((e) => e.event === 'ticket_added');
  check('card_generated carries version, weights and options', gen?.engineVersion === COMBINED_VERSION && gen.weights?.tipTop !== undefined && gen.options?.legsMax === 2);
  check('ticket_added carries every leg with both probabilities and its votes',
    added && added.legs.length === pick.legs.length && added.legs.every((l) => typeof l.combinedPHit === 'number' && typeof l.marketPHit === 'number' && l.votes)
    && typeof added.pHit === 'number' && added.calibration === CALIBRATION_NOTE);
  check('both saves trace under their own correlation id', events.some((e) => e.event === 'card_generated' && e.correlationId === 'corr-parlay-2'));

  // ---- D442: a Pick 3, previewed, saved and graded end to end ----
  // A FRESH day, so the pool is saved blind (no results) and the results are
  // then written so the ticket's own top horses win - the hit path, exactly.
  const day2Id = db.prepare("INSERT INTO race_days (track, date, correlation_id, bankroll_cents) VALUES ('Del Mar', '2026-08-31', 'corr-day2', 20000)").run().lastInsertRowid;
  for (const [n, entries] of Object.entries(ENTRIES)) {
    const menu = { 1: '.50 Pick 3 (Races 1-2-3) / $1 Daily Double / $1 Exacta', 2: '$1 Daily Double / $1 Exacta', 3: '$1 Exacta' }[n];
    const raceId = db.prepare('INSERT INTO races (race_day_id, number, wager_menu) VALUES (?, ?, ?)').run(day2Id, Number(n), menu).lastInsertRowid;
    for (const e of entries) {
      db.prepare('INSERT INTO entries (race_id, program_number, horse_name, morning_line_decimal) VALUES (?, ?, ?, ?)')
        .run(raceId, e.programNumber, `Horse ${n}-${e.programNumber}`, e.morningLineDecimal);
    }
  }
  const day2 = db.prepare('SELECT * FROM race_days WHERE id = ?').get(day2Id);
  const poolOptions = readOptions({ mode: 'pool', pools: ['pick3', 'daily_double'], budgetCents: 1200, limit: 5 });
  check('readOptions keeps only the pool fields in pool mode', poolOptions.mode === 'pool' && poolOptions.budgetCents === 1200 && !('kinds' in poolOptions));
  const pp = previewCombinedParlays(db, day2Id, poolOptions);
  const p3 = pp.candidates.combined.find((c) => c.betType === 'pick3');
  check('pool preview returns a Pick 3 over races 1-3 and doubles', p3 && same(p3.raceNumbers, [1, 2, 3]) && pp.candidates.combined.some((c) => c.betType === 'daily_double'));
  check('pool legDetail carries every horse of every leg', p3.legDetail.every((l, i) => same(l.programNumbers, p3.legs[i]) && l.horses.length === p3.legs[i].length));
  const saved3 = persistCombinedParlay(db, day2, {
    options: poolOptions, choice: { selection: 'combined', betType: 'pick3', raceNumbers: p3.raceNumbers, legs: p3.legs }, correlationId: 'corr-pool-1',
  });
  const t3 = db.prepare('SELECT * FROM tickets WHERE card_id = ?').get(saved3.cardId);
  check('saved pick 3: race_id NULL, stake = the 50c base, cost = base x combinations',
    t3.race_id === null && t3.bet_type === 'pick3' && t3.stake_cents === 50 && t3.cost_cents === p3.costCents
    && same(JSON.parse(t3.selections), { races: [1, 2, 3], legs: p3.legs }));
  check('saved blind: no results, not graded', saved3.graded === null);
  // Each leg's LAST covered horse wins - a hit, but not on the obvious favorites.
  const winners = p3.legs.map((leg) => leg[leg.length - 1]);
  for (const [i, raceNo] of [1, 2, 3].entries()) results.run(day2Id, raceNo, winners[i], 1, 800, 400, 300);
  db.prepare("INSERT INTO exotic_payoffs (race_day_id, race_number, bet_type, base_cents, combination, payout_cents) VALUES (?, 3, 'pick3', 50, ?, 12345)")
    .run(day2Id, winners.join('-'));
  const g3 = gradeAndPersist(db, saved3.cardId, 'corr-pool-grade').grades[0];
  check('the pick 3 grades as a HIT against the chart row: $123.45 back on a 50c combo',
    g3.outcome === 'win' && g3.returnedCents === 12345 && g3.plCents === 12345 - p3.costCents, JSON.stringify(g3));
  const lines = fs.readdirSync(process.env.BETSHEET_LOG_DIR).filter((f) => f.startsWith('decision-trace'))
    .flatMap((f) => fs.readFileSync(path.join(process.env.BETSHEET_LOG_DIR, f), 'utf8').split(String.fromCharCode(10)))
    .map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const poolAdded = lines.find((e) => e.event === 'ticket_added' && e.correlationId === 'corr-pool-1');
  check('the pool ticket_added traces each leg of horses with both probabilities', poolAdded && poolAdded.legs.every((l) => l.horses.every((h) => typeof h.combinedP === 'number' && typeof h.marketP === 'number')));
  db.close();
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nall parlay-builder checks passed');
}
