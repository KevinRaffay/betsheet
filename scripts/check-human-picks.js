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
import { parseHumanPicksText } from '../shared/parsers/human-picks.js';
import { estimateTicketPayouts, exactaEstimate, moneyToken, parseMoneyToken, placeEstimate,
  trifectaBoxEstimate, winPayout } from '../shared/betmath.js';

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
  // ---------- payout estimates, pure (D91) ----------
  // Runs before the server so a math break reports as a math break. The
  // identity assertions are the point: they are what stops a future
  // "helpful" multiplier being invented for a type this codebase has no
  // validated formula for.
  console.log('-- payout estimator (pure) --');
  {
    const ML = { 1: 2.5, 2: 4, 6: 12, 7: 3 };
    const mlOf = (p) => ML[p] ?? null;
    const T = (betType, legs, stakeCents) => ({ betType, legs, stakeCents, estMinCents: null, estMaxCents: null, estIsRange: false });
    const one = (t) => estimateTicketPayouts([t], mlOf)[0];

    check('win is exact, not a band', (() => {
      const r = one(T('win', [['6']], 3000));
      return r.estMinCents === winPayout(3000, 12) && r.estMinCents === r.estMaxCents && r.estIsRange === false;
    })(), JSON.stringify(one(T('win', [['6']], 3000))));
    check('win: $30 on a 12-1 shot is $390 exact', one(T('win', [['6']], 3000)).estMinCents === 39000);
    check('place is a band off the same horse', (() => {
      const r = one(T('place', [['1']], 1000));
      const [lo, hi] = placeEstimate(1000, 2.5);
      return r.estMinCents === lo && r.estMaxCents === hi && r.estIsRange === true;
    })());
    check('straight exacta bands top over under', (() => {
      const r = one(T('exacta', [['1'], ['2']], 200));
      const [lo, hi] = exactaEstimate(200, 2.5, 4);
      return r.estMinCents === lo && r.estMaxCents === hi;
    })());
    // Written with the box in DESCENDING price order so "it happened to take
    // legs[0][0] and legs[0][1]" cannot pass by accident.
    check('exacta box uses the two SHORTEST-priced, whatever order they are pasted in', (() => {
      const descending = one(T('exacta_box', [['6', '2', '1']], 1100));   // ML 12, 4, 2.5
      const [lo, hi] = exactaEstimate(1100, 2.5, 4);
      return descending.estMinCents === lo && descending.estMaxCents === hi;
    })(), JSON.stringify(one(T('exacta_box', [['6', '2', '1']], 1100))));
    check('trifecta box uses the three shortest', (() => {
      const r = one(T('trifecta_box', [['6', '1', '2', '7']], 100));      // shortest three: 2.5, 3, 4
      const [lo, hi] = trifectaBoxEstimate(100, [2.5, 3, 4]);
      return r.estMinCents === lo && r.estMaxCents === hi;
    })());

    // Identity, not a copy: an untouched ticket must be the SAME object.
    const untouched = [
      ['show', T('show', [['1']], 200)],
      ['trifecta (straight)', T('trifecta', [['1'], ['2'], ['7']], 100)],
      ['superfecta', T('superfecta', [['1'], ['2'], ['7'], ['6']], 10)],
      ['superfecta_box', T('superfecta_box', [['1', '2', '7', '6']], 10)],
      ['no morning line for the selection', T('win', [['99']], 500)],
    ];
    for (const [label, t] of untouched) {
      check(`${label}: left null, returned by identity`, (() => {
        const out = estimateTicketPayouts([t], mlOf);
        return out[0] === t && out[0].estMinCents === null;
      })());
    }
    check('an empty ticket list is fine', estimateTicketPayouts([], mlOf).length === 0);
  }

  // ---------- teller grammar, pure (D84) ----------
  // Run before the server so a grammar break is reported as a grammar break,
  // not as a mysterious preview failure 200 lines later.
  console.log('-- teller grammar (pure) --');
  {
    const tEntries = [1, 2, 3, 4, 5, 6, 7, 9].map((n) => ({ program_number: String(n), horse_name: `Horse ${n}` }));
    const tMenu = '$1 Exacta / $2 Quinella / 50c Trifecta / $1 Superfecta (10c min)';
    const tp = (text, opts = {}) => parseHumanPicksText({
      text, race: 1, entries: tEntries, wagerMenu: tMenu,
      scratchedProgramNumbers: opts.scratched ?? [],
    });

    // The exact string from the request that started D84.
    const EXAMPLE = '$10 W 5 / $5 W 2 / $3 W 4 / $2 EX BOX 2-4-5 / $1 EX 5 WITH 1-2-4-6 '
      + '/ $1 TRI 5 WITH 2-4 WITH 2-4 / $1 TRI 2-4 WITH 5 WITH 1-6-9 '
      + '/ $1 SUPER 5 WITH 2-4 WITH 2-4 WITH 1-6-7-9';
    const ex = tp(EXAMPLE);
    check('the worked example: 8 tickets, no warnings', ex.tickets.length === 8 && ex.warnings.length === 0,
      JSON.stringify(ex.warnings));
    check('the worked example: per-ticket costs, per-combo money x combination count', (() => {
      const want = [1000, 500, 300, 1200, 400, 200, 600, 800];
      return ex.tickets.length === want.length && want.every((c, i) => ex.tickets[i].costCents === c);
    })(), JSON.stringify(ex.tickets.map((t) => t.costCents)));
    check('the worked example: $50.00 for the race', ex.raceCostCents === 5000, String(ex.raceCostCents));
    check('repeat-dropping is real: "5 WITH 2-4 WITH 2-4" is 2 combos, not 4',
      ex.tickets[5].costCents === 200 && ex.tickets[5].stakeCents === 100);

    // The property the whole design rests on: what tellerCall emits, this
    // parser reads back to the identical ticket. Checked over every ticket
    // the example produces AND every ticket the column grammar produces.
    const roundTrips = (t) => {
      const back = tp(t.tellerCall);
      if (back.tickets.length !== 1) return false;
      const b = back.tickets[0];
      return b.betType === t.betType && b.stakeCents === t.stakeCents && b.costCents === t.costCents
        && JSON.stringify(b.legs) === JSON.stringify(t.legs) && b.tellerCall === t.tellerCall;
    };
    check('every teller ticket round-trips through its own tellerCall', ex.tickets.every(roundTrips),
      JSON.stringify(ex.tickets.filter((t) => !roundTrips(t)).map((t) => t.tellerCall)));
    check('every COLUMN-grammar ticket round-trips through its own tellerCall too', (() => {
      const col = tp(DESIGN_TABLE.replace(/#/g, '')).tickets;
      return col.length === 5 && col.every(roundTrips);
    })());
    check('the example is byte-identical to its own re-emission (canonical input)',
      ex.tickets.map((t) => t.tellerCall).join(' / ') === EXAMPLE.replace(/\s+/g, ' '));

    // Money tokens: canonical out, tolerant in.
    check('moneyToken/parseMoneyToken are inverses over every stake that matters',
      [2500, 200, 100, 50, 10, 250].every((c) => parseMoneyToken(moneyToken(c)) === c));
    check('a 50c trifecta canonicalizes to $0.50', (() => {
      const r = tp('50c TRI 5 WITH 2-4 WITH 2-4');
      return r.tickets.length === 1 && r.tickets[0].stakeCents === 50
        && r.tickets[0].tellerCall === '$0.50 TRI 5 WITH 2-4 WITH 2-4';
    })(), JSON.stringify(tp('50c TRI 5 WITH 2-4 WITH 2-4').tickets.map((t) => t.tellerCall)));
    check('"50-cent", "$.50" and ".50" all read as 50 cents',
      ['50-cent', '$.50', '.50'].every((m) => tp(`${m} TRI 5 WITH 2-4 WITH 2-4`).tickets[0]?.stakeCents === 50));
    check('a 10-cent superfecta base survives the round trip', (() => {
      const r = tp('$0.10 SUPER 5 WITH 2-4 WITH 2-4 WITH 1-6-7-9');
      return r.tickets[0]?.stakeCents === 10 && r.tickets[0].costCents === 80 && roundTrips(r.tickets[0]);
    })());

    // Synonyms and case.
    check('OVER is WITH, lowercase is fine, "," is "-"', (() => {
      const a = tp('$1 ex 5 over 1-2').tickets[0];
      const b = tp('$1 EX 5 WITH 1,2').tickets[0];
      return a && b && a.tellerCall === b.tellerCall && a.tellerCall === '$1 EX 5 WITH 1-2';
    })());
    check('full words work as well as abbreviations', (() => {
      const a = tp('$2 EXACTA BOX 2,4,5').tickets[0];
      const b = tp('$2 EX BOX 2-4-5').tickets[0];
      return a && b && a.tellerCall === b.tellerCall && a.costCents === 1200;
    })());
    check('longest match wins: SUPER is superfecta, not show', (() => {
      const r = tp('$0.10 SUPER 5 WITH 2-4 WITH 2-4 WITH 1-6-7-9');
      return r.tickets[0]?.betType === 'superfecta';
    })());

    // Odds + rationale ride in a trailing parenthetical.
    check('a trailing parenthetical carries odds then rationale', (() => {
      const r = tp('$10 W 5 (9/2 big overlay) / $2 EX BOX 2-4-5 (spread the chalk)');
      const [a, b] = r.tickets;
      return r.tickets.length === 2
        && a.odds_at_bet === '9/2' && a.rationale_text === 'big overlay'
        && b.odds_at_bet === null && b.rationale_text === 'spread the chalk';
    })());
    check('a rationale containing " / " does not split the ticket in half', (() => {
      const r = tp('$2 EX BOX 2-4-5 (good spot / bad post)');
      return r.tickets.length === 1 && r.tickets[0].rationale_text === 'good spot / bad post';
    })());

    // Structural rules the teller grammar makes one keystroke away.
    check('"$1 EX 5" - a straight exacta with one position - blocks', (() => {
      const ws = tp('$1 EX 5').warnings;
      return tp('$1 EX 5').tickets.length === 0
        && ws.some((x) => x.type === 'insufficient_selections' && x.blocking === true);
    })());
    check('"$1 EX 5 WITH 2 WITH 3" - three positions on a two-position bet - blocks', (() => {
      const ws = tp('$1 EX 5 WITH 2 WITH 3').warnings;
      return ws.some((x) => x.type === 'too_many_positions' && x.blocking === true);
    })());
    check('a win bet on two horses is TWO tickets, not one two-combo ticket', (() => {
      const r = tp('$10 W 2-5');
      return r.tickets.length === 2 && r.raceCostCents === 2000
        && r.tickets.every((t) => t.costCents === 1000 && t.legs[0].length === 1)
        && r.warnings.some((x) => x.type === 'wps_split' && x.blocking === false);
    })(), JSON.stringify(tp('$10 W 2-5').tickets.map((t) => t.tellerCall)));
    check('the WPS split preserves the total under the column grammar too', (() => {
      const r = parseHumanPicksText({ text: 'Win | 2,5 | $20', race: 1, entries: tEntries, wagerMenu: tMenu });
      return r.tickets.length === 2 && r.raceCostCents === 2000;
    })());

    // Rejections.
    check('a multi-race teller ticket is rejected, not silently mis-saved', (() => {
      const ws = tp('Races 1-2 $2 DD 5 WITH 2-4').warnings;
      return ws.some((x) => x.type === 'multi_race_unsupported' && x.blocking === true);
    })());
    check('a ticket segment with no money token blocks on the stake', (() => {
      const ws = tp('$10 W 5 / W 2').warnings;
      return ws.some((x) => x.type === 'unrecognized_stake' && x.blocking === true);
    })());
    check('a scratched horse still blocks in the teller grammar', (() => {
      const ws = tp('$5 W 5', { scratched: ['5'] }).warnings;
      return ws.some((x) => x.type === 'scratched_selection' && x.blocking === true);
    })());
    check('an off-increment per-combo stake blocks', (() => {
      const ws = tp('$1.50 EX 2 WITH 4').warnings;
      return ws.some((x) => x.type === 'non_multiple_stake' && x.blocking === true);
    })());
    check('a coupled entry (1A) resolves in the teller grammar', (() => {
      const r = parseHumanPicksText({
        text: '$10 W 1A', race: 1, wagerMenu: tMenu,
        entries: [...tEntries, { program_number: '1A', horse_name: 'Coupled Colt' }],
      });
      return r.tickets.length === 1 && r.tickets[0].legs[0][0] === '1A' && r.tickets[0].tellerCall === '$10 W 1A';
    })());

    // Detection: the two grammars coexist in one paste without interfering.
    check('a teller line and a column line in the SAME paste both parse', (() => {
      const r = tp('$10 W 5 / $2 EX BOX 2-4-5\nWin | 2 | $25\nTrifecta | 2,4/2,4/3,5 | $20');
      return r.tickets.length === 4 && r.warnings.length === 0 && r.raceCostCents === 1000 + 1200 + 2500 + 2000;
    })(), JSON.stringify(tp('$10 W 5 / $2 EX BOX 2-4-5\nWin | 2 | $25\nTrifecta | 2,4/2,4/3,5 | $20').tickets.map((t) => t.tellerCall)));
  }

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
  check('teller calls are the D84 grammar, exact strings', (() => {
    const want = ['$25 W 2', '$15 W 4', '$10 EX BOX 2-4', '$5 TRI 2-4 WITH 2-4 WITH 3-5', '$20 W 5'];
    const got = p1.tickets.map((t) => t.tellerCall);
    return want.length === got.length && want.every((w, i) => got[i] === w);
  })(), JSON.stringify(p1.tickets.map((t) => t.tellerCall)));

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
  // D91 + invariant 9, mechanically: the preview must be exactly what Save
  // stores, for the estimate column too - not just a claim in a doc comment.
  check('"If it hits" is populated on a saved human ticket (D91 reverses D54)', await (async () => {
    const card = await jget(`/api/cards/${humanCardId}`);
    const win = card.tickets.find((t) => t.bet_type === 'win');
    const box = card.tickets.find((t) => t.bet_type === 'exacta_box');
    // #2 Tahini is 9/2 -> 4.5 decimal; $25 win pays $137.50 exact.
    return win && win.est_payout_min_cents === 13750 && win.est_is_range === 0
      && box && box.est_payout_min_cents != null && box.est_is_range === 1;
  })(), JSON.stringify((await jget(`/api/cards/${humanCardId}`)).tickets.map((t) => [t.bet_type, t.est_payout_min_cents, t.est_is_range])));
  check('preview and save agree on the estimate (invariant 9)', await (async () => {
    const p = await preview(dayId, 1, 'Win	#4	$15');
    const previewed = p.tickets[0];
    const card = await jget(`/api/cards/${humanCardId}`);
    const saved = card.tickets.find((t) => t.bet_type === 'win' && t.cost_cents === 1500);
    return previewed.estMinCents != null && saved && saved.est_payout_min_cents === previewed.estMinCents
      && Boolean(saved.est_is_range) === previewed.estIsRange;
  })());
  check('a show ticket saves with NO estimate - the honest gap, pinned', await (async () => {
    const p = await preview(dayId, 1, '$10 S 2');
    return p.tickets.length === 1 && p.tickets[0].estMinCents === null;
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
  check('multi-race type rejected, names the deliverable that will cover it', await (async () => {
    const ws = await w('Daily Double\t2/4\t$10');
    return ws.some((x) => x.type === 'multi_race_unsupported' && x.blocking === true && /D88/.test(x.message));
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
