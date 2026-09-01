// Verification for the card engine - exits non-zero on any failure.
// Run: npm run check-engine
//
// Three layers: (1) the engine run PURE against the real Del Mar goldens
// (program PDF entries + SFTB picks + a synthetic agreeing second source),
// (2) synthetic mini-days that guarantee each rule a deterministic case,
// (3) a server round-trip on a temp DB: save day -> paste picks -> generate
// via the API -> read the card back -> find its trace in the decision-trace
// log file.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-enginecheck-'));
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'unit-logs');

const { classifyDay } = await import('../shared/classification.js');
const { generateCard } = await import('../shared/card-engine.js');
const { parseWagerMenu, winPayout } = await import('../shared/betmath.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

// ---------- shared harness: the real day ----------

const prog = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/programs/delmar-2026-08-30.expected.json'), 'utf8'));
const sftb = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sources/sftb-delmar-2026-08-30.expected.json'), 'utf8'));

const toDbEntry = (e) => ({
  program_number: e.programNumber, horse_name: e.horseName,
  morning_line: e.morningLine, morning_line_decimal: e.morningLineDecimal,
  program_rank: e.programRank, best_bet: e.bestBet ? 1 : 0,
  scratched: e.scratched ? 1 : 0,
});

function realDay({ dropSecondSourceForRace = null, noExternal = false } = {}) {
  const entriesByRace = Object.fromEntries(prog.races.map((r) => [r.number, r.entries.map(toDbEntry)]));
  const picksByRace = {};
  if (!noExternal) {
    for (const r of sftb.races) {
      picksByRace[r.race] = r.picks.map((p) => ({
        source_name: 'SFTB', source_kind: 'algorithmic', pick_type: p.pickType,
        program_number: p.programNumber, horse_name: p.horseName, note: p.note,
      }));
      if (r.race !== dropSecondSourceForRace) {
        picksByRace[r.race].push({
          source_name: 'Digest', source_kind: 'manual', pick_type: 'top',
          program_number: r.picks[0].programNumber, horse_name: r.picks[0].horseName, note: null,
        });
      }
    }
  }
  const numbers = prog.races.map((r) => r.number);
  const cls = classifyDay(numbers, entriesByRace, picksByRace);
  const byN = Object.fromEntries(cls.map((c) => [c.number, c]));
  return prog.races.map((r) => ({
    number: r.number, race_type: r.raceType, conditions: r.conditions,
    wager_menu: r.wagerMenu, entries: entriesByRace[r.number], classification: byN[r.number],
  }));
}

const gen = (races, opts = {}) => generateCard({
  bankrollCents: 20000, perRaceMinCents: 500, races,
  sourcesUsed: ['SFTB', 'Digest'], sourcesUnavailable: ['At The Races'], ...opts,
});

const entryOf = (races, raceNo, pgm) =>
  races.find((r) => r.number === raceNo).entries.find((e) => e.program_number === pgm);

console.log('-- real Del Mar day, pure engine --');
const races = realDay();
const card = gen(races);
const total = (c) => c.tickets.reduce((a, t) => a + t.costCents, 0);

check('bankroll sums exactly ($200)', total(card) === 20000, `${total(card)}`);
const odd = gen(races, { bankrollCents: 17300 });
check('bankroll sums exactly on an odd amount ($173)', total(odd) === 17300, `${total(odd)}`);

check('allocation targets sum to bankroll minus the multi-race reserve', (() => {
  const sumFor = (c, bank) => {
    const allocSum = c.allocations.reduce((a, x) => a + x.amountCents, 0);
    const reserveSpent = c.tickets.filter((t) => t.raceNumbers.length > 1)
      .reduce((a, t) => a + t.costCents, 0);
    return allocSum + reserveSpent === bank;
  };
  return sumFor(card, 20000) && sumFor(odd, 17300);
})(), JSON.stringify([card, odd].map((c) => c.allocations.reduce((a, x) => a + x.amountCents, 0))));

check('completeness FULL when every race has 2 external sources', card.completeness === 'FULL');
check('completeness PARTIAL when one race drops to 1 external',
  gen(realDay({ dropSecondSourceForRace: 4 })).completeness === 'PARTIAL');
check('completeness PROGRAM_ONLY with no external picks',
  gen(realDay({ noExternal: true })).completeness === 'PROGRAM_ONLY');

check('2yo maiden races get the guesswork minimum (R2, R5)', (() => {
  const a = Object.fromEntries(card.allocations.map((x) => [x.race, x]));
  return a[2].confidence === 'GUESS' && a[2].amountCents === 500 &&
    a[5].confidence === 'GUESS' && a[5].amountCents === 500;
})(), JSON.stringify(card.allocations.map((a) => [a.race, a.confidence, a.amountCents])));

check('UNANIMOUS races carry the heaviest allocations', (() => {
  const a = Object.fromEntries(card.allocations.map((x) => [x.race, x.amountCents]));
  return a[1] > a[3] && a[7] > a[3];
})());

// The real odds-on case: Howie's Law at 4/5 in R1, unanimous.
check('fade-the-price: no win bet in R1, favorite on TOP of an exacta', (() => {
  const r1 = card.tickets.filter((t) => t.raceNumbers.length === 1 && t.raceNumbers[0] === 1);
  return !r1.some((t) => t.betType === 'win') &&
    r1.some((t) => t.betType === 'exacta' && t.legs[0][0] === '1') &&
    card.trace.some((e) => e.event === 'rule_fired' && e.rule === 'fade_favorite_price' && e.race === 1);
})());
check('fade-the-price: the flip (longshot over favorite) is kept as a stack',
  card.tickets.some((t) => t.raceNumbers[0] === 1 && t.betType === 'exacta' &&
    t.legs[1][0] === '1' && t.ruleTags.includes('longshot_on_top')));

check('place-money rule: EVERY 8-1+ win carries matching place (invariant 1)', (() => {
  const wins = card.tickets.filter((t) => t.betType === 'win');
  return wins.every((w) => {
    const e = entryOf(races, w.raceNumbers[0], w.legs[0][0]);
    if (e.morning_line_decimal < 8) return true;
    return card.tickets.some((p) => p.betType === 'place' &&
      p.raceNumbers[0] === w.raceNumbers[0] && p.legs[0][0] === w.legs[0][0] &&
      p.stakeCents === w.stakeCents);
  });
})());
check('place-money rule actually fired on this card (8-1 wins exist)',
  card.tickets.some((t) => t.ruleTags.includes('place_money_rule')));

check('never 3+ win bets in one race (cut hedges)', (() => {
  const perRace = {};
  for (const t of card.tickets.filter((t) => t.betType === 'win')) {
    perRace[t.raceNumbers[0]] = (perRace[t.raceNumbers[0]] ?? 0) + 1;
  }
  return Object.values(perRace).every((n) => n <= 2);
})());

check('consensus parlay + doubles present, $2 each, within budget', (() => {
  const parlay = card.tickets.find((t) => t.betType === 'parlay');
  const doubles = card.tickets.filter((t) => t.betType === 'daily_double');
  return parlay && parlay.costCents === 200 && parlay.raceNumbers.length >= 2 &&
    doubles.length >= 1 && doubles.every((d) => d.costCents === 200);
})());

check('win payouts are exact morning-line math', card.tickets
  .filter((t) => t.betType === 'win')
  .every((t) => {
    const e = entryOf(races, t.raceNumbers[0], t.legs[0][0]);
    return !t.estIsRange && t.estMinCents === winPayout(t.stakeCents, e.morning_line_decimal);
  }));
check('exotic estimates are ranges, labeled', card.tickets
  .filter((t) => ['exacta', 'exacta_box', 'trifecta_box', 'daily_double'].includes(t.betType))
  .every((t) => t.estIsRange && t.estMaxCents > t.estMinCents));

check('teller calls: race first, amount, type, program numbers', card.tickets.every((t) =>
  /^Races? [\d-]+, (\$[\d.]+|50-cent|10-cent) .+, .+$/.test(t.tellerCall)));

check('exacta stakes respect the $1 menu minimum', card.tickets
  .filter((t) => t.betType === 'exacta')
  .every((t) => t.stakeCents >= 100 && t.stakeCents % 100 === 0));

check('mid-price program horses covered in exotics',
  card.tickets.some((t) => t.ruleTags.includes('mid_price_coverage')));

check('the three failure-mode warnings ride every card',
  card.warnings.filter((w) => /Unanimous consensus|chaos days|draw from the same well/.test(w)).length === 3);

// ---------- trace ----------

console.log('-- decision trace --');
check('trace: inputs first, card_finalized last',
  card.trace[0].event === 'inputs_snapshot' &&
  card.trace[card.trace.length - 1].event === 'card_finalized');
check('trace: every race classified with its votes',
  prog.races.every((r) => card.trace.some((e) =>
    e.event === 'race_classified' && e.race === r.number && Array.isArray(e.topVotes))));
check('trace: one ticket_added per ticket',
  card.trace.filter((e) => e.event === 'ticket_added').length === card.tickets.length);
check('trace: card_finalized totals match the tickets', (() => {
  const fin = card.trace[card.trace.length - 1];
  return fin.totalCents === total(card) && fin.ticketCount === card.tickets.length &&
    fin.completeness === card.completeness;
})());
check('trace: allocation_decided for every race',
  prog.races.every((r) => card.trace.some((e) => e.event === 'allocation_decided' && e.race === r.number)));

// ---------- synthetic guarantees + structure-layer toggles ----------

console.log('-- synthetic + toggles --');
const synthEntries = [
  { program_number: '1', horse_name: 'Longshot Top', morning_line: '10/1', morning_line_decimal: 10, program_rank: 1, best_bet: 0, scratched: 0 },
  { program_number: '2', horse_name: 'Second Fiddle', morning_line: '3/1', morning_line_decimal: 3, program_rank: 2, best_bet: 0, scratched: 0 },
  { program_number: '3', horse_name: 'Filler', morning_line: '6/1', morning_line_decimal: 6, program_rank: 3, best_bet: 0, scratched: 0 },
];
const synthPicks = { 1: [
  { source_name: 'A', source_kind: 'algorithmic', pick_type: 'top', program_number: '1', horse_name: 'Longshot Top', note: null },
  { source_name: 'B', source_kind: 'manual', pick_type: 'top', program_number: '1', horse_name: 'Longshot Top', note: null },
] };
const synthCls = classifyDay([1], { 1: synthEntries }, synthPicks)[0];
const synthRace = { number: 1, race_type: 'ALLOWANCE', conditions: 'FOR THREE YEAR OLDS', wager_menu: null, entries: synthEntries, classification: synthCls };

const synthCard = generateCard({ bankrollCents: 5000, perRaceMinCents: 500, races: [synthRace] });
check('synthetic: 10-1 unanimous top -> win bet + FORCED matching place', (() => {
  const w = synthCard.tickets.find((t) => t.betType === 'win');
  const p = synthCard.tickets.find((t) => t.betType === 'place');
  return w && p && p.stakeCents === w.stakeCents && p.ruleTags.includes('place_money_rule');
})(), JSON.stringify(synthCard.tickets.map((t) => [t.betType, t.stakeCents])));

const noPlace = generateCard({ bankrollCents: 5000, perRaceMinCents: 500, races: [synthRace], rules: { placeMoneyRule: false } });
check('toggle: placeMoneyRule off (simulation only) -> no forced place, suppression traced',
  !noPlace.tickets.some((t) => t.ruleTags.includes('place_money_rule')) &&
  noPlace.trace.some((e) => e.event === 'rule_suppressed' && e.rule === 'place_money_rule'));

const noFade = gen(realDay(), { rules: { fadeThePrice: false } });
check('toggle: fadeThePrice off -> R1 gets a win bet again',
  noFade.tickets.some((t) => t.betType === 'win' && t.raceNumbers[0] === 1));

check('toggle: parlays off -> no multi-race tickets',
  !gen(realDay(), { rules: { parlays: false } }).tickets.some((t) => t.raceNumbers.length > 1));

check('betmath: parseWagerMenu reads the real menu string', (() => {
  const m = parseWagerMenu('$1 Exacta / $2 Quinella / 50c Trifecta / $2 Rolling Double, 50c Rolling Pick 3/ $1 Superfecta (10c min), $2 Pick Six / $2 WPS Parlay');
  return m.exacta === 100 && m.trifecta === 50 && m.superfecta === 10 && m.daily_double === 200 && m.parlay === 200;
})());

// ---------- server round-trip ----------

console.log('-- server round-trip --');
const PORT = 8903;
const BASE = `http://127.0.0.1:${PORT}`;
const logDir = path.join(tmp, 'server-logs');
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(PORT),
    BETSHEET_DB: path.join(tmp, 'check.sqlite'),
    BETSHEET_LOG_DIR: logDir,
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

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  check('server boots', up, serverOut.slice(-300));

  const saved = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: '2026-08-30', bankrollCents: 20000, perRaceMinCents: 500,
    races: prog.races,
  })).json();
  check('day saved from the program golden', Number.isInteger(saved.id));

  // Two pasted sources -> FULL completeness.
  for (const name of ['Digest One', 'Digest Two']) {
    const text = sftb.races.map((r) => `Race ${r.race}: ${r.picks.map((p) => p.programNumber).join(', ')}`).join('\n');
    const preview = await (await jpost(`/api/race-days/${saved.id}/consensus/manual-preview`, { sourceName: name, text })).json();
    await jpost(`/api/race-days/${saved.id}/consensus/manual`, { sourceName: name, races: preview.races });
  }

  const genRes = await jpost(`/api/race-days/${saved.id}/cards`, { variant: 'default' });
  const genCard = await genRes.json();
  check('card generated via API (201, FULL, exact bankroll)',
    genRes.status === 201 && genCard.completeness === 'FULL' &&
    genCard.tickets.reduce((a, t) => a + t.costCents, 0) === 20000,
    JSON.stringify({ status: genRes.status, completeness: genCard.completeness }));

  const read = await (await fetch(`${BASE}/api/cards/${genCard.id}`)).json();
  check('card reads back: completeness column, allocations, tickets match',
    read.consensus_completeness === 'FULL' &&
    read.allocations.length === 10 &&
    read.tickets.length === genCard.tickets.length &&
    read.tickets.every((t) => typeof t.teller_call === 'string' && Array.isArray(t.selections.legs)));

  const regen = await jpost(`/api/race-days/${saved.id}/cards`, { variant: 'default' });
  const cardsList = await (await fetch(`${BASE}/api/race-days/${saved.id}/cards`)).json();
  check('regenerating the same variant replaces, never duplicates',
    regen.status === 201 && cardsList.length === 1);

  const variant2 = await (await jpost(`/api/race-days/${saved.id}/cards`, { variant: 'spread', rules: { fadeThePrice: false } })).json();
  const cardsList2 = await (await fetch(`${BASE}/api/race-days/${saved.id}/cards`)).json();
  check('a second variant is stored beside the first', Number.isInteger(variant2.id) && cardsList2.length === 2);

  await new Promise((r) => setTimeout(r, 300));
  const traceFile = path.join(logDir, 'decision-trace.jsonl');
  const traceLines = fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  check('decision-trace stream holds the card\'s full trace under its correlation id', (() => {
    const forCard = traceLines.filter((l) => l.cardId === variant2.id);
    return forCard.length > 0 &&
      forCard.every((l) => l.correlationId === variant2.correlationId) &&
      forCard.some((l) => l.event === 'inputs_snapshot') &&
      forCard.some((l) => l.event === 'card_finalized') &&
      forCard.some((l) => l.event === 'rule_suppressed' && l.rule === 'fadeThePrice' === false || l.event === 'race_classified');
  })(), `trace lines total=${traceLines.length}`);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-engine: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-engine: all checks passed');
