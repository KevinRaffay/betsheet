// P-0.2: the graded-card regression fixtures (D108).
//
// This is the PLACEHOLDER the pivot's P-0.2 asks for. It proves the fixtures
// are present, well-formed and internally consistent - it does NOT yet re-run
// the grader against them. That assertion is P-6.1's, and it is the one that
// matters: load each fixture's card and results, grade them, and require the
// summary to match to the cent. A mismatch there means grading BEHAVIOUR
// changed, which is a finding to investigate before the factory reset
// proceeds, not a rounding error to absorb.
//
// Until then this guards the thing that would quietly break first: a fixture
// being edited, truncated, or copied over with a different card's export.
//
// Run: npm run check-graded-card-fixtures

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

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

if (failures) {
  console.error(`\ncheck-graded-card-fixtures: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-graded-card-fixtures: all checks passed');
