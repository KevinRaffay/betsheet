// The graded-card regression fixtures (P-0.2, D108) AND the grading regression
// itself (P-6.1, D120).
//
// Two phases, and the second is the one that matters.
//
// PHASE 1 (D108) guards what would quietly break first: a fixture being
// edited, truncated, or copied over with a different card's export. It never
// takes gradeSummary's word for anything - every fixture's tickets are re-added
// independently, so a doctored summary fails against its own rows.
//
// PHASE 2 (D120) is the assertion the pivot's P-6.1 asks for and the gate its
// sequencing puts in front of the factory reset: load each fixture's tickets
// and the day's results, run the REAL grader, and require the summary to match
// the archived value TO THE CENT and every per-ticket outcome to match too. A
// mismatch is a finding - grading behaviour changed - and must be investigated
// before a reset proceeds, never absorbed as a rounding error.
//
// Phase 2 also carries a NEGATIVE CONTROL, because a regression test that
// cannot fail is worse than no test: perturb one winning payoff by a cent and
// the grader must notice. Without it, a harness bug that fed the grader an
// empty ticket list would report nine green cards.
//
// Pure: no server, no database. The fixtures ARE the corpus here, which is why
// they were frozen (D107) before any removal began.
//
// Run: npm run check-graded-card-fixtures

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { buildDayResults, gradeCard } from '../shared/grading.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIR = path.join(ROOT, 'tests', 'fixtures', 'graded-cards');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

const sidecar = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));

console.log('-- the fixture set --');
check('sidecar lists at least the three cards the pivot doc names',
  [139, 144, 146].every((id) => sidecar.cards.some((c) => c.cardId === id)));
check('9 fixtures', sidecar.cards.length === 9, String(sidecar.cards.length));
check('every listed file exists on disk',
  sidecar.cards.every((c) => fs.existsSync(path.join(DIR, c.file))));
check('no stray export in the directory that the sidecar does not list',
  fs.readdirSync(DIR).filter((f) => f.startsWith('card-')).length === sidecar.cards.length);

console.log('\n-- the values the pivot doc quotes, to the cent --');
const pl = (id) => sidecar.cards.find((c) => c.cardId === id).expected.plCents;
check('card 139 is -5045', pl(139) === -5045, String(pl(139)));
check('card 144 is +7015', pl(144) === 7015, String(pl(144)));
check('card 146 is -9778', pl(146) === -9778, String(pl(146)));

console.log('\n-- each fixture is internally consistent --');
for (const c of sidecar.cards) {
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, c.file), 'utf8'));
  const s = doc.gradeSummary;
  const ok = doc.card.id === c.cardId
    && doc.raceDay.date === c.date
    && doc.card.engineVersion === c.engineVersion
    && doc.tickets.length === c.tickets
    && s.costCents === c.expected.costCents
    && s.returnedCents === c.expected.returnedCents
    && s.plCents === c.expected.plCents
    && JSON.stringify(s.outcomes) === JSON.stringify(c.expected.outcomes);
  check(`card ${c.cardId} (${c.date}, ${c.llmModel ?? c.engineVersion}) matches its sidecar entry`, ok);
}

console.log('\n-- arithmetic, independent of what the summary claims --');
for (const c of sidecar.cards) {
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, c.file), 'utf8'));
  // Recompute from the tickets rather than trusting gradeSummary: if a fixture
  // were edited, the summary and its own rows would stop agreeing.
  const graded = doc.tickets.filter((t) => t.grade);
  const cost = graded.reduce((a, t) => a + t.costCents, 0);
  const ret = graded.reduce((a, t) => a + t.grade.returnedCents, 0);
  const p = graded.reduce((a, t) => a + t.grade.plCents, 0);
  const counts = {};
  for (const t of graded) counts[t.grade.outcome] = (counts[t.grade.outcome] ?? 0) + 1;
  check(`card ${c.cardId}: tickets re-add to the summary (${graded.length} graded)`,
    cost === c.expected.costCents && ret === c.expected.returnedCents && p === c.expected.plCents
    && p === ret - cost
    && Object.entries(c.expected.outcomes).every(([k, v]) => counts[k] === v),
    JSON.stringify({ cost, ret, p, counts }));
}

console.log('\n-- coverage the set is supposed to give P-6.1 --');
const set = (k) => new Set(sidecar.cards.map((c) => c[k]));
check('all four completeness buckets',
  set('bucket').size === 4, [...set('bucket')].join(', '));
check('all four engine versions',
  set('engineVersion').size === 4, [...set('engineVersion')].join(', '));
check('more than one date, so nothing is pinned to a single day',
  set('date').size >= 5, String(set('date').size));
const kinds = new Set(sidecar.cards.flatMap((c) => Object.keys(c.expected.outcomes)));
check('every outcome the grader emits appears: win, loss, refund, partial',
  ['win', 'loss', 'refund', 'partial'].every((k) => kinds.has(k)), [...kinds].join(', '));

console.log('\n-- the gap this set cannot cover, recorded rather than implied --');
check('the sidecar states that no multi-race ticket exists in the whole corpus',
  /multi-race/i.test(sidecar.knownGap ?? ''), sidecar.knownGap);

// ---------------------------------------------------------------------------
// PHASE 2 (P-6.1): the grader still reproduces every archived summary.
// ---------------------------------------------------------------------------

const load = (file) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));

/**
 * A fixture's `results` block -> the map `gradeCard` grades against.
 * Deliberately regrouped here rather than imported from `server/grading.js`'s
 * `loadDayResultsFor`: that one reads a live database, and the whole point of
 * this check is that it needs neither a server nor a corpus. Both funnel into
 * the same `buildDayResults`, which is the shared part that matters.
 */
function dayResultsFrom(doc) {
  const byRace = new Map();
  const raceFor = (n) => {
    if (!byRace.has(n)) byRace.set(n, { number: n, results: [], exotics: [], scratchedPgms: [] });
    return byRace.get(n);
  };
  for (const f of doc.results.finishers) {
    raceFor(f.race).results.push({
      programNumber: f.programNumber, finishPosition: f.finishPosition,
      winCents: f.winCents, placeCents: f.placeCents, showCents: f.showCents,
    });
  }
  for (const x of doc.results.exotics) {
    raceFor(x.race).exotics.push({
      betType: x.betType, baseCents: x.baseCents,
      combination: x.combination, payoutCents: x.payoutCents,
    });
  }
  for (const sc of doc.results.scratches) {
    if (sc.programNumber != null) raceFor(sc.race).scratchedPgms.push(sc.programNumber);
  }
  return buildDayResults([...byRace.values()]);
}

// Only the fields the grader is allowed to see. Notably NOT the stored grade -
// feeding that back in would make the comparison circular.
const ticketsFrom = (doc) => doc.tickets.map((t) => ({
  betType: t.betType, races: t.races, legs: t.legs,
  stakeCents: t.stakeCents, costCents: t.costCents,
}));

console.log('\n-- P-6.1: the grader reproduces the archived summaries, to the cent --');
let regradedTickets = 0;
for (const c of sidecar.cards) {
  const doc = load(c.file);
  const { grades, summary } = gradeCard(ticketsFrom(doc), dayResultsFrom(doc));
  const e = c.expected;

  check(`card ${c.cardId} (${c.engineVersion}): summary matches the archive`,
    summary.costCents === e.costCents
    && summary.returnedCents === e.returnedCents
    && summary.plCents === e.plCents
    && JSON.stringify(summary.outcomes) === JSON.stringify(e.outcomes),
    JSON.stringify({
      expected: e,
      got: {
        costCents: summary.costCents,
        returnedCents: summary.returnedCents,
        plCents: summary.plCents,
        outcomes: summary.outcomes,
      },
    }));

  // The summary can match while individual tickets disagree - two errors that
  // cancel. Per-ticket is the assertion the spec actually asks for.
  const differing = [];
  doc.tickets.forEach((t, i) => {
    if (!t.grade) return;
    regradedTickets += 1;
    const g = grades[i];
    if (g.outcome !== t.grade.outcome
      || g.returnedCents !== t.grade.returnedCents
      || g.plCents !== t.grade.plCents) {
      differing.push({
        seq: t.sequence, betType: t.betType, tellerCall: t.tellerCall,
        archived: { outcome: t.grade.outcome, returnedCents: t.grade.returnedCents },
        regraded: { outcome: g.outcome, returnedCents: g.returnedCents },
      });
    }
  });
  check(`card ${c.cardId}: every one of ${doc.tickets.length} tickets regrades identically`,
    differing.length === 0, JSON.stringify(differing.slice(0, 4)));
}
check(`${regradedTickets} tickets regraded across ${sidecar.cards.length} cards`,
  regradedTickets >= 386, String(regradedTickets));

console.log('\n-- negative control: this check is capable of failing --');
{
  // Take the card whose numbers the pivot doc quotes, move ONE payoff the card
  // ACTUALLY COLLECTED ON by a single cent, and require the grader to disagree
  // with the archive. If this passes silently, the phase above proves nothing.
  //
  // The target is derived from the card's own biggest winning WIN ticket rather
  // than picked by hand: the first draft perturbed "the first finisher with a
  // win price", which sat in a race this card never had a win bet in, so the
  // total did not move and the control reported a false pass. A control has to
  // be aimed at something the subject actually reads.
  const doc = load('card-139.json');
  const perturbed = JSON.parse(JSON.stringify(doc));
  const collected = doc.tickets
    .filter((t) => t.betType === 'win' && t.grade?.outcome === 'win')
    .sort((a, b) => b.grade.returnedCents - a.grade.returnedCents)[0];
  check('the control has a win ticket to aim at', Boolean(collected));
  const winner = perturbed.results.finishers.find(
    (f) => f.race === collected.races[0] && f.programNumber === collected.legs[0][0],
  );
  check('the control found the horse that ticket collected on', Boolean(winner?.winCents));
  winner.winCents += 1;
  const { summary } = gradeCard(ticketsFrom(perturbed), dayResultsFrom(perturbed));
  const archived = sidecar.cards.find((c) => c.cardId === 139).expected;
  check('a one-cent change to a winning payoff makes the regrade disagree',
    summary.returnedCents !== archived.returnedCents,
    `perturbed=${summary.returnedCents} archived=${archived.returnedCents}`);

  // And the harness is genuinely feeding the grader tickets - an empty list
  // would sail through every equality above on a card that lost everything.
  check('the harness feeds the grader real tickets, not an empty list',
    ticketsFrom(doc).length === doc.tickets.length && doc.tickets.length > 0);
}

if (failures) {
  console.error(`\ncheck-graded-card-fixtures: ${failures} failure(s)`);
  console.error('A PHASE 2 failure means GRADING BEHAVIOUR CHANGED. Investigate before');
  console.error('any factory reset proceeds - the archive is the only other copy.');
  process.exit(1);
}
console.log('\ncheck-graded-card-fixtures: all checks passed');
