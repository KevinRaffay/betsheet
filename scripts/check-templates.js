// Verification for strategy templates (D18) - exits non-zero on failure.
// Run: npm run check-templates
//
// Three layers: (1) template hygiene - every template resolves onto real
// engine knobs, the signal/structure layer map covers the rule set exactly;
// (2) the real Del Mar day generated under each template, pure - each
// template's signature behavior must show up in the tickets, and the
// place-money invariant must hold under every non-simulation template;
// (3) a server round-trip - template stored on the card by FK, resolved
// rules + template name in the trace, invariant-1 guard (422) on the live
// endpoint, reseed after factory reset.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import crypto from 'node:crypto';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-templcheck-'));
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'unit-logs');

const { DEFAULT_RULES, generateCard, ENGINE_VERSION } = await import('../shared/card-engine.js');
const { TEMPLATES, RULE_LAYERS, resolveTemplate, templateLayers, listTemplates } = await import('../shared/templates.js');
const { classifyDay } = await import('../shared/classification.js');
const { BET } = await import('../shared/betmath.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

// ---------- template hygiene ----------

console.log('-- template hygiene --');
const ruleKeys = Object.keys(DEFAULT_RULES).sort();
check('every template override names a real engine rule',
  Object.values(TEMPLATES).every((t) => Object.keys(t.rules).every((k) => ruleKeys.includes(k))));
check('the layer map covers the rule set exactly (no gaps, no strays)',
  JSON.stringify(Object.keys(RULE_LAYERS).sort()) === JSON.stringify(ruleKeys),
  JSON.stringify({ layers: Object.keys(RULE_LAYERS).sort(), rules: ruleKeys }));
check('lean resolves to the live defaults, byte for byte',
  JSON.stringify(resolveTemplate('lean')) === JSON.stringify(DEFAULT_RULES));
check('unknown template resolves to null', resolveTemplate('yolo') === null);
check('every allocationCurve named by a template exists in betmath',
  Object.values(TEMPLATES).every((t) =>
    t.rules.allocationCurve == null || BET.allocationCurves[t.rules.allocationCurve]));
check('layer tags: spread=structure, structure-only=signal, no-place-money=structure',
  JSON.stringify(templateLayers('spread')) === '["structure"]' &&
  JSON.stringify(templateLayers('structure-only')) === '["signal"]' &&
  JSON.stringify(templateLayers('no-place-money')) === '["structure"]');
check('listTemplates carries name/description/rules/layers/simulationOnly for all',
  listTemplates().length === Object.keys(TEMPLATES).length &&
  listTemplates().every((t) => t.name && t.description && t.rules && Array.isArray(t.layers) &&
    typeof t.simulationOnly === 'boolean'));
check('the simulation-only set: the invariant-1 breaker plus the four D48 program-rank templates',
  listTemplates().filter((t) => t.simulationOnly).map((t) => t.name).join(',') === 'no-place-money,exacta-primary,no-exotics,box-depth-3,best-bet-weighted');

// ---------- the real day under each template, pure ----------

console.log('-- real Del Mar day per template --');
const prog = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/programs/delmar-2026-08-30.expected.json'), 'utf8'));
const sftb = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sources/sftb-delmar-2026-08-30.expected.json'), 'utf8'));
const toDbEntry = (e) => ({
  program_number: e.programNumber, horse_name: e.horseName,
  morning_line: e.morningLine, morning_line_decimal: e.morningLineDecimal,
  program_rank: e.programRank, best_bet: e.bestBet ? 1 : 0, scratched: e.scratched ? 1 : 0,
});
const entriesByRace = Object.fromEntries(prog.races.map((r) => [r.number, r.entries.map(toDbEntry)]));
const picksByRace = {};
for (const r of sftb.races) {
  picksByRace[r.race] = r.picks.map((p) => ({
    source_name: 'SFTB', source_kind: 'algorithmic', pick_type: p.pickType,
    program_number: p.programNumber, horse_name: p.horseName, note: p.note,
  }));
  picksByRace[r.race].push({
    source_name: 'Digest', source_kind: 'manual', pick_type: 'top',
    program_number: r.picks[0].programNumber, horse_name: r.picks[0].horseName, note: null,
  });
}
const cls = classifyDay(prog.races.map((r) => r.number), entriesByRace, picksByRace);
const byN = Object.fromEntries(cls.map((c) => [c.number, c]));
const races = prog.races.map((r) => ({
  number: r.number, race_type: r.raceType, conditions: r.conditions,
  wager_menu: r.wagerMenu, entries: entriesByRace[r.number], classification: byN[r.number],
}));
const genWith = (name) => generateCard({
  bankrollCents: 20000, perRaceMinCents: 500, races,
  sourcesUsed: ['SFTB', 'Digest'], sourcesUnavailable: [],
  rules: TEMPLATES[name].rules, template: name,
});
const total = (c) => c.tickets.reduce((a, t) => a + t.costCents, 0);
const allocOf = (c, n) => c.allocations.find((a) => a.race === n);

const lean = genWith('lean');
const spread = genWith('spread');
check('every template still sums exactly to the bankroll',
  Object.keys(TEMPLATES).every((n) => total(genWith(n)) === 20000));
check('spread flattens: UNANIMOUS races allocated less than under lean',
  allocOf(spread, 1).amountCents < allocOf(lean, 1).amountCents &&
  allocOf(spread, 7).amountCents < allocOf(lean, 7).amountCents,
  JSON.stringify({ lean: allocOf(lean, 1), spread: allocOf(spread, 1) }));
check('spread names its curve in the allocation rule string',
  spread.allocations.every((a) => a.confidence === 'GUESS' || a.rule.startsWith('spread_weight_')));
check('inputs_snapshot records the template name and the resolved curve',
  spread.trace[0].template === 'spread' && spread.trace[0].rules.allocationCurve === 'spread' &&
  lean.trace[0].template === 'lean');

const noFade = genWith('no-fade');
check('no-fade: the odds-on unanimous favorite gets its win bet back (R1)',
  noFade.tickets.some((t) => t.betType === 'win' && t.raceNumbers[0] === 1) &&
  !lean.tickets.some((t) => t.betType === 'win' && t.raceNumbers[0] === 1));

const structOnly = genWith('structure-only');
check('structure-only: no multi-race tickets (lean has them on this day)',
  !structOnly.tickets.some((t) => t.raceNumbers.length > 1) &&
  lean.tickets.some((t) => t.raceNumbers.length > 1));

// Coverage adds need a 2+-source horse the construction didn't already use.
// This pure harness's picks never produce one (the real-day coverage adds
// come from multiple full-order sources), so a synthetic race proves the
// toggle both ways: '4' is on both sources' lists but never in the exacta.
const covEntries = [
  { program_number: '1', horse_name: 'Cov Top', morning_line: '3/1', morning_line_decimal: 3, program_rank: 1, best_bet: 0, scratched: 0 },
  { program_number: '2', horse_name: 'Cov Second', morning_line: '4/1', morning_line_decimal: 4, program_rank: 2, best_bet: 0, scratched: 0 },
  { program_number: '3', horse_name: 'Cov Filler', morning_line: '9/1', morning_line_decimal: 9, program_rank: 3, best_bet: 0, scratched: 0 },
  { program_number: '4', horse_name: 'Cov Flagged', morning_line: '12/1', morning_line_decimal: 12, program_rank: 4, best_bet: 0, scratched: 0 },
];
const covPicks = { 1: ['A', 'B'].flatMap((src) => [
  { source_name: src, source_kind: 'algorithmic', pick_type: 'top', program_number: '1', horse_name: 'Cov Top', note: null },
  { source_name: src, source_kind: 'algorithmic', pick_type: 'second', program_number: '2', horse_name: 'Cov Second', note: null },
  { source_name: src, source_kind: 'algorithmic', pick_type: 'third', program_number: '4', horse_name: 'Cov Flagged', note: null },
]) };
const covCls = classifyDay([1], { 1: covEntries }, covPicks)[0];
const covRace = { number: 1, race_type: 'ALLOWANCE', conditions: 'FOR THREE YEAR OLDS', wager_menu: null, entries: covEntries, classification: covCls };
const covGen = (rules) => generateCard({ bankrollCents: 5000, perRaceMinCents: 500, races: [covRace], rules });
check('structure-only: coverage adds off (they fire under lean on the same race)',
  covGen({}).tickets.some((t) => t.ruleTags.includes('two_source_coverage')) &&
  !covGen(TEMPLATES['structure-only'].rules).tickets.some((t) => t.ruleTags.includes('two_source_coverage')));

check('place-money invariant holds under EVERY non-simulation template', (() => {
  for (const name of Object.keys(TEMPLATES)) {
    if (TEMPLATES[name].simulationOnly) continue;
    const c = genWith(name);
    for (const w of c.tickets.filter((t) => t.betType === 'win')) {
      const e = races.find((r) => r.number === w.raceNumbers[0]).entries
        .find((x) => x.program_number === w.legs[0][0]);
      if (e.morning_line_decimal < BET.placeMoneyThresholdMl) continue;
      const paired = c.tickets.some((p) => p.betType === 'place' &&
        p.raceNumbers[0] === w.raceNumbers[0] && p.legs[0][0] === w.legs[0][0] &&
        p.stakeCents === w.stakeCents);
      if (!paired) return false;
    }
  }
  return true;
})());
const noPlace = genWith('no-place-money');
check('no-place-money (simulation): rule suppressed and traced as such',
  !noPlace.tickets.some((t) => t.ruleTags.includes('place_money_rule')) &&
  noPlace.trace.some((e) => e.event === 'rule_suppressed' && e.rule === 'place_money_rule'));

// Chaos box needs a CHAOS race; the real day has none, so a synthetic one.
const chaosEntries = [
  { program_number: '1', horse_name: 'Chaos Alpha', morning_line: '4/1', morning_line_decimal: 4, program_rank: 1, best_bet: 0, scratched: 0 },
  { program_number: '2', horse_name: 'Chaos Beta', morning_line: '5/1', morning_line_decimal: 5, program_rank: 2, best_bet: 0, scratched: 0 },
  { program_number: '3', horse_name: 'Chaos Gamma', morning_line: '12/1', morning_line_decimal: 12, program_rank: 3, best_bet: 0, scratched: 0 },
  { program_number: '4', horse_name: 'Chaos Delta', morning_line: '6/1', morning_line_decimal: 6, program_rank: 4, best_bet: 0, scratched: 0 },
];
const chaosRace = {
  number: 1, race_type: 'CLAIMING', conditions: 'FOR THREE YEAR OLDS', wager_menu: null,
  entries: chaosEntries,
  classification: {
    classification: 'CHAOS', externalSourceCount: 2, cappedFromUnanimous: false,
    topVotes: [], contrarianFlags: [], sourceCounts: {}, table: [],
  },
};
const chaosGen = (rules, template) => generateCard({
  bankrollCents: 10000, perRaceMinCents: 500, races: [chaosRace], rules, template,
});
check('chaos race under lean: the trifecta box carries the upside',
  chaosGen(TEMPLATES.lean.rules, 'lean').tickets.some((t) => t.betType === 'trifecta_box'));
check('no-chaos-box: the box is gone, anchor + longshot exacta stay',
  (() => {
    const c = chaosGen(TEMPLATES['no-chaos-box'].rules, 'no-chaos-box');
    return !c.tickets.some((t) => t.betType === 'trifecta_box') &&
      c.tickets.some((t) => t.betType === 'win') && total(c) === 10000;
  })());

// ---------- D48: the program-rank templates on a PROGRAM_ONLY day ----------
// The same real program with NO external picks: every race classifies SPLIT
// (capped), completeness PROGRAM_ONLY - the bucket the whole backfill
// corpus lives in. The six D18 templates tie lean to the penny here (that
// tie is documented-correct); each D48 template MUST differ.
console.log('-- D48: program-rank templates on the PROGRAM_ONLY day --');
const digestOf = (c) => crypto.createHash('sha256').update(JSON.stringify(c.tickets.map((t) => [t.raceNumbers, t.betType, t.legs, t.stakeCents, t.costCents]))).digest('hex').slice(0, 16);
const clsPO = classifyDay(prog.races.map((r) => r.number), entriesByRace, {});
const byNPO = Object.fromEntries(clsPO.map((c) => [c.number, c]));
const racesPO = prog.races.map((r) => ({ number: r.number, race_type: r.raceType, conditions: r.conditions, wager_menu: r.wagerMenu, entries: entriesByRace[r.number], classification: byNPO[r.number] }));
const genPO = (name, extra = {}) => generateCard({ bankrollCents: 20000, perRaceMinCents: 500, races: racesPO, sourcesUsed: [], rules: { ...TEMPLATES[name].rules, ...extra }, template: name });
const spentIn = (c, n) => c.tickets.filter((t) => t.raceNumbers.length === 1 && t.raceNumbers[0] === n).reduce((a, t) => a + t.costCents, 0);
const leanPO = genPO('lean');
check('no engine version bump: ENGINE_VERSION is still lean-1.1 and lean is byte-identical to the pre-D48 engine on the FULL day (30 tickets) and the PROGRAM_ONLY day (25 tickets) - frozen digests',
  ENGINE_VERSION === 'lean-1.1' && digestOf(lean) === '0f6269f62f8349c3' && digestOf(leanPO) === 'e1d7df85f7a0d0bd' && leanPO.completeness === 'PROGRAM_ONLY',
  `${ENGINE_VERSION} ${digestOf(lean)} ${digestOf(leanPO)}`);
const NEW = ['exacta-primary', 'no-exotics', 'box-depth-3', 'best-bet-weighted'];
const cards = Object.fromEntries(NEW.map((n) => [n, genPO(n)]));
check('the six D18 templates tie lean on the PROGRAM_ONLY day (documented-correct: nothing they toggle fires there)',
  ['spread', 'no-fade', 'no-chaos-box', 'structure-only'].every((n) => digestOf(genPO(n)) === digestOf(leanPO)));
for (const n of NEW) {
  check(`${n}: a DIFFERENT ticket set from lean on the PROGRAM_ONLY day, still exactly the bankroll`, digestOf(cards[n]) !== digestOf(leanPO) && total(cards[n]) === 20000, `${digestOf(cards[n])} total ${total(cards[n])}`);
}
check('RULE_LAYERS: all four are structure-layer', NEW.every((n) => JSON.stringify(templateLayers(n)) === '["structure"]'));
const ep = cards['exacta-primary'];
check('exacta-primary: no place tickets; every win ticket at the per-race minimum ($5); boxes and mid-price exactas stay',
  !ep.tickets.some((t) => t.betType === 'place') && ep.tickets.filter((t) => t.betType === 'win').every((t) => t.stakeCents === 500) &&
  ep.tickets.filter((t) => t.betType === 'exacta_box').length === leanPO.tickets.filter((t) => t.betType === 'exacta_box').length && ep.tickets.some((t) => t.ruleTags.includes('mid_price_coverage')),
  JSON.stringify(ep.tickets.filter((t) => t.betType === 'win').map((t) => t.stakeCents)));
check('exacta-primary: the balancer steps the box, never the held win (remainder_distributed names the box ticket; held races without a box are skipped as stake_held_by_template)', (() => {
  const rem = ep.trace.find((e) => e.event === 'remainder_distributed');
  return rem && rem.races.every((r) => ep.tickets.find((t) => t.sequence === r.ticket)?.betType === 'exacta_box') && rem.skipped.some((s) => s.reason === 'stake_held_by_template');
})());
const ne = cards['no-exotics'];
check('no-exotics: zero exacta / exacta_box / trifecta_box tickets; win tickets carry the allocation; place-money pairs still ride at 8-1+',
  !ne.tickets.some((t) => ['exacta', 'exacta_box', 'trifecta_box'].includes(t.betType)) && ne.tickets.some((t) => t.betType === 'place' && t.ruleTags.includes('place_money_rule')) &&
  ne.allocations.every((a) => spentIn(ne, a.race) === a.amountCents), JSON.stringify(ne.tickets.map((t) => t.betType)));
const b3 = cards['box-depth-3'];
check('box-depth-3: every split exacta box takes three program ranks (6 combos) and every hedge_cut race lands on its allocation (D36 tolerance: exact after balancing)',
  b3.tickets.filter((t) => t.betType === 'exacta_box').every((t) => t.legs[0].length === 3 && t.costCents === t.stakeCents * 6) && b3.tickets.some((t) => t.betType === 'exacta_box') &&
  b3.allocations.filter((a) => b3.trace.some((e) => e.event === 'rule_fired' && e.rule === 'hedge_cut' && e.race === a.race)).every((a) => spentIn(b3, a.race) === a.amountCents),
  JSON.stringify(b3.allocations.map((a) => [a.race, a.amountCents, spentIn(b3, a.race)])));
const bb = cards['best-bet-weighted'];
const bbRace = prog.races.find((r) => r.entries.some((e) => e.bestBet)).number;
check(`best-bet-weighted: the Best Bet race (R${bbRace}) takes the heavy weight (double any other race), allocations sum to the bankroll, best_bet_weight traced`, (() => {
  const a = Object.fromEntries(bb.allocations.map((x) => [x.race, x.amountCents]));
  const others = bb.allocations.filter((x) => x.race !== bbRace && x.confidence !== 'GUESS').map((x) => x.amountCents);
  return a[bbRace] >= 2 * Math.max(...others) && bb.allocations.reduce((s, x) => s + x.amountCents, 0) === 20000 && bb.trace.some((e) => e.event === 'rule_fired' && e.rule === 'best_bet_weight' && e.race === bbRace);
})(), JSON.stringify(bb.allocations.map((x) => [x.race, x.amountCents])));
const noBB = generateCard({ bankrollCents: 20000, perRaceMinCents: 500, races: racesPO.map((r) => ({ ...r, entries: r.entries.map((e) => ({ ...e, best_bet: 0 })) })), sourcesUsed: [], rules: TEMPLATES['best-bet-weighted'].rules, template: 'best-bet-weighted' });
check('best-bet-weighted with no Best Bet on the day: flat (every non-guess race equal, one race carrying the rounding drift), best_bet_weight suppressed with no_best_bet', (() => {
  const amts = noBB.allocations.filter((x) => x.confidence !== 'GUESS').map((x) => x.amountCents).sort((a, b) => a - b);
  const common = amts[Math.floor(amts.length / 2)];
  return amts.filter((a) => a !== common).length <= 1 && Math.max(...amts) - Math.min(...amts) < 100 * amts.length && noBB.trace.some((e) => e.event === 'rule_suppressed' && e.rule === 'best_bet_weight' && e.reason === 'no_best_bet');
})());
// rule_suppressed: "never fired" and "never evaluated" are now different things.
const sups = (c, rule, reason) => c.trace.filter((e) => e.event === 'rule_suppressed' && e.rule === rule && (reason == null || e.reason === reason));
check('rule_suppressed on the PROGRAM_ONLY day: fade declines with no_algo_order on EVERY race (10), chaos box declines per race (10) and once for the day (no_chaos_race)',
  sups(leanPO, 'fade_favorite_price', 'no_algo_order').length === 10 && sups(leanPO, 'chaos_trifecta_box', 'not_chaos_classification').length === 10 && sups(leanPO, 'chaos_trifecta_box', 'no_chaos_race').length === 1,
  JSON.stringify({ fade: sups(leanPO, 'fade_favorite_price').map((e) => e.reason), chaos: sups(leanPO, 'chaos_trifecta_box').length }));
check('rule_suppressed: place money declines per win ticket below 8-1 (below_odds_threshold with the ml); mid-price declines where no mid-priced horse remains; hedge_cut answers on every race (fired or declined)',
  sups(leanPO, 'place_money_rule', 'below_odds_threshold').length > 0 && sups(leanPO, 'place_money_rule', 'below_odds_threshold').every((e) => typeof e.ml === 'number' && e.ml < 8) &&
  sups(leanPO, 'mid_price_coverage', 'no_mid_priced_horse').length > 0 &&
  racesPO.every((r) => leanPO.trace.some((e) => e.rule === 'hedge_cut' && e.race === r.number)));
check('rule_suppressed: a disabled rule says disabled_by_template (no-fade on this day; place money under exacta-primary; the D18 no-place-money reason is now machine-readable)',
  sups(genPO('no-fade'), 'fade_favorite_price', 'disabled_by_template').length === 10 && sups(ep, 'place_money_rule', 'disabled_by_template').length === 1 && sups(genPO('no-place-money'), 'place_money_rule', 'disabled_by_template').length === 1);
check('rule_suppressed on the FULL day: fade fires on the odds-on unanimous favorite and declines above_odds_on / not_unanimous elsewhere; every reason is a machine token',
  lean.trace.some((e) => e.event === 'rule_fired' && e.rule === 'fade_favorite_price') && sups(lean, 'fade_favorite_price').every((e) => ['above_odds_on', 'not_unanimous', 'no_algo_order', 'no_morning_line'].includes(e.reason)) &&
  lean.trace.filter((e) => e.event === 'rule_suppressed' && e.rule !== 'win_bet').every((e) => /^[a-z_]+$/.test(e.reason)),
  JSON.stringify([...new Set(lean.trace.filter((e) => e.event === 'rule_suppressed').map((e) => e.rule + ':' + e.reason))]));
check('no-exotics traces why each exotic is missing (no_exotic_tickets on the box, the mid-price exacta and the coverage adds)',
  sups(ne, 'split_exacta_box', 'no_exotic_tickets').length > 0 && sups(ne, 'mid_price_coverage', 'no_exotic_tickets').length === 8 && sups(ne, 'two_source_coverage', 'no_exotic_tickets').length > 0);


// ---------- server round-trip ----------

console.log('-- server round-trip --');
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
const jpost = (url, body) => fetch(BASE + url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const jget = (url) => fetch(BASE + url).then((r) => r.json());

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); }
  }
  check('server boots', up, serverOut.slice(-300));

  const apiTemplates = await jget('/api/templates');
  check('GET /api/templates serves the catalog with layers + simulationOnly',
    apiTemplates.length === Object.keys(TEMPLATES).length &&
    apiTemplates.find((t) => t.name === 'no-place-money')?.simulationOnly === true &&
    apiTemplates.every((t) => Array.isArray(t.layers)));

  const day = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: '2026-08-30', bankrollCents: 20000, perRaceMinCents: 500,
    races: prog.races,
  })).json();
  for (const name of ['Digest One', 'Digest Two']) {
    const text = sftb.races.map((x) => `Race ${x.race}: ${x.picks.map((p) => p.programNumber).join(', ')}`).join('\n');
    const preview = await (await jpost(`/api/race-days/${day.id}/consensus/manual-preview`, { sourceName: name, text })).json();
    await jpost(`/api/race-days/${day.id}/consensus/manual`, { sourceName: name, races: preview.races });
  }

  const spreadCard = await (await jpost(`/api/race-days/${day.id}/cards`, { template: 'spread' })).json();
  const defaulted = await (await jpost(`/api/race-days/${day.id}/cards`, {})).json();
  const list = await jget(`/api/race-days/${day.id}/cards`);
  check('template rides the card row by FK; omitted template defaults to lean',
    list.find((c) => c.id === spreadCard.id)?.template === 'spread' &&
    list.find((c) => c.id === defaulted.id)?.template === 'lean');
  const detail = await jget(`/api/cards/${spreadCard.id}`);
  check('card detail carries the template name', detail.template === 'spread');

  await new Promise((rr) => setTimeout(rr, 300));
  const exported = await jget(`/api/cards/${spreadCard.id}/export`);
  check('export: card.template + inputs_snapshot template/resolved rules', (() => {
    const snap = exported.trace.find((e) => e.event === 'inputs_snapshot');
    return exported.card.template === 'spread' && snap &&
      snap.template === 'spread' && snap.rules.allocationCurve === 'spread';
  })());

  const unknown = await jpost(`/api/race-days/${day.id}/cards`, { template: 'yolo' });
  check('unknown template -> 400 with the valid list', unknown.status === 400 &&
    /Templates:/.test((await unknown.json()).error));
  const simOnly = await jpost(`/api/race-days/${day.id}/cards`, { template: 'no-place-money' });
  const simOnly48 = await jpost(`/api/race-days/${day.id}/cards`, { template: 'exacta-primary' });
  check('simulation-only templates on the LIVE endpoint -> 422 (invariant 1; the D48 four ride the same gate)', simOnly.status === 422 && simOnly48.status === 422);
  const rawOff = await jpost(`/api/race-days/${day.id}/cards`, { rules: { placeMoneyRule: false } });
  check('raw placeMoneyRule:false override -> 422 (invariant 1 holds at the API)', rawOff.status === 422);

  const chart = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/charts/dmr-2026-08-30.expected.json'), 'utf8'));
  await jpost(`/api/race-days/${day.id}/results`, {
    track: chart.track, date: chart.date, sourceKind: 'paste', races: chart.races,
  });
  const pl = await jget('/api/pl');
  check('P/L rows carry the template for cross-template comparison',
    pl.cards.length === 2 &&
    pl.cards.find((c) => c.cardId === spreadCard.id)?.template === 'spread' &&
    pl.cards.find((c) => c.cardId === defaulted.id)?.template === 'lean');
  const dayPl = await jget(`/api/race-days/${day.id}/pl`);
  check('per-day compare rows carry the template too',
    dayPl.cards.every((c) => ['spread', 'lean'].includes(c.template)));

  await jpost('/api/reset', { confirm: 'RESET' });
  const reseeded = await jget('/api/templates');
  const freshDay = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: '2026-08-30', bankrollCents: 20000, perRaceMinCents: 500,
    races: prog.races,
  })).json();
  const freshCard = await jpost(`/api/race-days/${freshDay.id}/cards`, { template: 'spread' });
  check('factory reset reseeds the templates; generation works in the new era',
    reseeded.length === Object.keys(TEMPLATES).length && freshCard.status === 201);
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-templates: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-templates: all checks passed');
