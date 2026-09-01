// Verification for shared/classification.js - exits non-zero on any
// failure. Run: npm run check-classification
//
// Pure unit checks, hand-built scenarios. Every rule from the spec gets a
// case that would catch its inversion: the 2-external-source floor for
// UNANIMOUS, program-only defaults, both contrarian flags (including the
// favorite missing from an algo's order entirely), and the 2+-source
// coverage counts.

import {
  buildConsensusTable, classifyRace, classifyDay, contrarianFlags,
  publicFavorite, sourceCounts,
} from '../shared/classification.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const entry = (pgm, name, ml, rank = null, scratched = 0) => ({
  program_number: pgm, horse_name: name, morning_line: `${ml}/1`,
  morning_line_decimal: ml, program_rank: rank, scratched,
});
const pick = (source, kind, type, pgm, note = null) => ({
  source_name: source, source_kind: kind, pick_type: type,
  program_number: pgm, horse_name: `Horse ${pgm}`, note,
});

const entries = [
  entry('1', 'Fav Horse', 0.8),
  entry('4', 'Solid Pick', 3, 1),
  entry('7', 'Other Pick', 5, 2),
  entry('9', 'Long Shot', 12, 3),
  entry('6', 'Scratched Long', 15, null, 1),
];

// --- consensus table ---

const table1 = buildConsensusTable(entries, [
  pick('Source A', 'algorithmic', 'top', '4'),
  pick('Source A', 'algorithmic', 'second', '1'),
  pick('Source B', 'race_guide', 'top', '4'),
  pick('Source B', 'race_guide', 'watch_out', '9'),
]);
check('table: program analysis joins as a NON-external source', (() => {
  const prog = table1.find((s) => s.name === 'Program analysis');
  return prog && !prog.external && prog.top.programNumber === '4' &&
    prog.second.programNumber === '7' && prog.third.programNumber === '9';
})(), JSON.stringify(table1));
check('table: external sources carry ranked and flagged picks', (() => {
  const b = table1.find((s) => s.name === 'Source B');
  return b?.external && b.top.programNumber === '4' &&
    b.flagged.some((f) => f.programNumber === '9' && f.pickType === 'watch_out');
})());

// --- classification ---

check('UNANIMOUS: everyone agrees AND >= 2 external sources', (() => {
  const r = classifyRace(table1);
  return r.classification === 'UNANIMOUS' && r.externalSourceCount === 2 &&
    r.topVotes[0].programNumber === '4' && r.topVotes[0].sources.length === 3;
})());

check('capped: agreement with only 1 external source is SPLIT', (() => {
  const t = buildConsensusTable(entries, [pick('Source A', 'algorithmic', 'top', '4')]);
  const r = classifyRace(t);
  return r.classification === 'SPLIT' && r.cappedFromUnanimous === true;
})());

check('program-only day: program top pick defaults to SPLIT, not capped', (() => {
  const r = classifyRace(buildConsensusTable(entries, []));
  return r.classification === 'SPLIT' && r.cappedFromUnanimous === false && r.externalSourceCount === 0;
})());

check('no signal at all: CHAOS', (() => {
  const bare = [entry('1', 'A', 2), entry('2', 'B', 3)];
  return classifyRace(buildConsensusTable(bare, [])).classification === 'CHAOS';
})());

check('2-way disagreement: SPLIT', (() => {
  const t = buildConsensusTable(entries, [
    pick('Source A', 'algorithmic', 'top', '4'),
    pick('Source B', 'race_guide', 'top', '7'),
  ]);
  return classifyRace(t).classification === 'SPLIT';
})());

check('3-way disagreement: CHAOS', (() => {
  const t = buildConsensusTable(entries, [
    pick('Source A', 'algorithmic', 'top', '1'),
    pick('Source B', 'race_guide', 'top', '7'),
    pick('Source C', 'digest', 'top', '9'),
  ]);
  return classifyRace(t).classification === 'CHAOS';
})());

// --- contrarian flags ---

check('public favorite: lowest ML among unscratched', publicFavorite(entries)?.program_number === '1');

const orderNote = (rows) => JSON.stringify({ rank: 1, expected: 1, value: '2-1', fullOrder: rows });

check('algo_fades_favorite: favorite ranked 4th+ in an algo full order', (() => {
  const flags = contrarianFlags(entries, [
    pick('Algo', 'algorithmic', 'top', '4', orderNote([
      { rank: 1, programNumber: '4' }, { rank: 2, programNumber: '7' },
      { rank: 3, programNumber: '9' }, { rank: 4, programNumber: '2' },
      { rank: 5, programNumber: '1' },
    ])),
  ]);
  return flags.some((f) => f.type === 'algo_fades_favorite' && f.programNumber === '1' && /#5/.test(f.detail));
})());

check('algo ranks favorite 2nd: no fade flag', (() => {
  const flags = contrarianFlags(entries, [
    pick('Algo', 'algorithmic', 'top', '4', orderNote([
      { rank: 1, programNumber: '4' }, { rank: 2, programNumber: '1' },
    ])),
  ]);
  return !flags.some((f) => f.type === 'algo_fades_favorite');
})());

check('favorite absent from the full order: flagged as unplaced', (() => {
  const flags = contrarianFlags(entries, [
    pick('Algo', 'algorithmic', 'top', '4', orderNote([{ rank: 1, programNumber: '4' }])),
  ]);
  return flags.some((f) => f.type === 'algo_fades_favorite' && /unplaced/.test(f.detail));
})());

check('corroborated_longshot: 2 sources on the same 12-1 shot', (() => {
  const flags = contrarianFlags(entries, [
    pick('Source A', 'algorithmic', 'watch_out', '9'),
    pick('Source B', 'race_guide', 'second', '9'),
  ]);
  return flags.some((f) => f.type === 'corroborated_longshot' && f.programNumber === '9');
})());

check('one source on a longshot: no corroboration flag', (() => {
  const flags = contrarianFlags(entries, [pick('Source A', 'algorithmic', 'watch_out', '9')]);
  return !flags.some((f) => f.type === 'corroborated_longshot');
})());

check('two sources on a 5-1 shot: price too short to flag', (() => {
  const flags = contrarianFlags(entries, [
    pick('Source A', 'algorithmic', 'watch_out', '7'),
    pick('Source B', 'race_guide', 'watch_out', '7'),
  ]);
  return !flags.some((f) => f.type === 'corroborated_longshot');
})());

check('scratched longshot never flags', (() => {
  const flags = contrarianFlags(entries, [
    pick('Source A', 'algorithmic', 'watch_out', '6'),
    pick('Source B', 'race_guide', 'watch_out', '6'),
  ]);
  return !flags.some((f) => f.type === 'corroborated_longshot');
})());

// --- source coverage counts ---

check('sourceCounts: distinct sources per horse', (() => {
  const counts = sourceCounts([
    pick('A', 'algorithmic', 'top', '4'),
    pick('B', 'race_guide', 'second', '4'),
    pick('A', 'algorithmic', 'watch_out', '9'),
    pick('A', 'algorithmic', 'second', '9'), // same source twice = 1
  ]);
  return counts['4'] === 2 && counts['9'] === 1;
})());

// --- whole-day driver ---

check('classifyDay: mixed day classifies each race independently', (() => {
  const day = classifyDay([1, 2],
    { 1: entries, 2: [entry('1', 'A', 2), entry('2', 'B', 3)] },
    { 1: [pick('Source A', 'algorithmic', 'top', '4'), pick('Source B', 'race_guide', 'top', '4')], 2: [] });
  return day[0].classification === 'UNANIMOUS' && day[1].classification === 'CHAOS' &&
    day[0].table.length === 3 && typeof day[0].sourceCounts === 'object';
})());

if (failures) {
  console.error(`\ncheck-classification: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-classification: all checks passed');
