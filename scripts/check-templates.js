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

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-templcheck-'));
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'unit-logs');

const { DEFAULT_RULES, generateCard } = await import('../shared/card-engine.js');
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
check('exactly one template is simulation-only (the invariant-1 breaker)',
  listTemplates().filter((t) => t.simulationOnly).map((t) => t.name).join(',') === 'no-place-money');

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
  check('simulation-only template on the LIVE endpoint -> 422 (invariant 1)', simOnly.status === 422);
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
