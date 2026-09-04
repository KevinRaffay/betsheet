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
  publicFavorite, sourceCounts, CLASSIFY_UNANIMOUS,
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

// --- D74: the three-external-source rule (Equibase OTR joins SFTB/ATR) ---

check('D74: default CLASSIFY_UNANIMOUS is "all" (majority is opt-in, never a silent default)', CLASSIFY_UNANIMOUS === 'all');

// A clean entries set with NO program_rank, so buildConsensusTable never
// adds a "Program analysis" source - isolates these cases to exactly the
// external-source count each name describes.
const entries3 = [entry('1', 'A', 2), entry('2', 'B', 3), entry('3', 'C', 6)];

check('D74: UNANIMOUS 3/3 - three external sources all agree', (() => {
  const t = buildConsensusTable(entries3, [
    pick('SFTB', 'algorithmic', 'top', '2'),
    pick('At The Races', 'manual', 'top', '2'),
    pick('Equibase Off to the Races', 'algorithmic', 'top', '2'),
  ]);
  const r = classifyRace(t);
  return r.classification === 'UNANIMOUS' && r.externalSourceCount === 3 && r.agreement === 3;
})());

check('D74: SPLIT 2/3 - two of three external sources agree, `agreement` records 2', (() => {
  const t = buildConsensusTable(entries3, [
    pick('SFTB', 'algorithmic', 'top', '2'),
    pick('Equibase Off to the Races', 'algorithmic', 'top', '2'),
    pick('At The Races', 'manual', 'top', '3'),
  ]);
  const r = classifyRace(t);
  return r.classification === 'SPLIT' && r.agreement === 2 && r.externalSourceCount === 3;
})());

check('D74: CHAOS - three external sources, nobody agrees with anybody', (() => {
  const t = buildConsensusTable(entries3, [
    pick('SFTB', 'algorithmic', 'top', '1'),
    pick('At The Races', 'manual', 'top', '2'),
    pick('Equibase Off to the Races', 'algorithmic', 'top', '3'),
  ]);
  const r = classifyRace(t);
  return r.classification === 'CHAOS' && r.agreement === 1;
})());

check('D74: 4 contributing sources, 3 distinct picks but ONE pair agrees -> SPLIT, never CHAOS', (() => {
  // The regression this PR closes: with the pre-D74 world (at most 2
  // external + program = 3 total sources), "3 distinct picks" and "nobody
  // agrees with anybody" were the same condition. A 3rd external source
  // breaks that equivalence - here program+SFTB both pick '4' (a real
  // agreeing pair) while ATR picks '7' and OTR picks '9': 3 distinct
  // picks, but NOT "no two agree". The old unconditional
  // "votes.size >= 3 -> CHAOS" rule would have mislabeled this CHAOS.
  const t = buildConsensusTable(entries, [ // `entries` (outer scope) carries program_rank -> Program analysis contributes '4'
    pick('SFTB', 'algorithmic', 'top', '4'),
    pick('At The Races', 'manual', 'top', '7'),
    pick('Equibase Off to the Races', 'algorithmic', 'top', '9'),
  ]);
  const r = classifyRace(t);
  return r.classification === 'SPLIT' && r.agreement === 2 && r.topVotes[0].programNumber === '4';
})());

check('D74: source-count cap verified absent - all three external sources reach classifyDay, none silently dropped', (() => {
  const day = classifyDay([1], { 1: entries3 }, { 1: [
    pick('SFTB', 'algorithmic', 'top', '2'),
    pick('At The Races', 'manual', 'top', '2'),
    pick('Equibase Off to the Races', 'algorithmic', 'top', '2'),
  ] });
  return day[0].externalSourceCount === 3 && day[0].table.length === 3;
})());

check('D74: CLASSIFY_UNANIMOUS="majority" promotes a 2/3-agreement SPLIT race to UNANIMOUS', (() => {
  const t = buildConsensusTable(entries3, [
    pick('SFTB', 'algorithmic', 'top', '2'),
    pick('Equibase Off to the Races', 'algorithmic', 'top', '2'),
    pick('At The Races', 'manual', 'top', '3'),
  ]);
  const rAll = classifyRace(t); // default 'all'
  const rMajority = classifyRace(t, { classifyUnanimous: 'majority' });
  return rAll.classification === 'SPLIT' && rMajority.classification === 'UNANIMOUS';
})());

check('D74: "majority" never promotes when the program itself contradicts the plurality pick', (() => {
  // Program (via `entries`' program_rank) picks '4'; two externals (SFTB,
  // OTR) agree on '9' instead - a real 2-of-3 majority, but the program
  // names a DIFFERENT horse, so majority mode must still hold at SPLIT.
  const t = buildConsensusTable(entries, [
    pick('SFTB', 'algorithmic', 'top', '9'),
    pick('Equibase Off to the Races', 'algorithmic', 'top', '9'),
    pick('At The Races', 'manual', 'top', '7'),
  ]);
  const r = classifyRace(t, { classifyUnanimous: 'majority' });
  return r.classification === 'SPLIT';
})());

// --- D74: OTR's partial-order fade (a box, not a ranked expected order) ---

check('D74: a box-only algo source fades the favorite when absent from its box', (() => {
  const flags = contrarianFlags(entries, [
    pick('Equibase Off to the Races', 'algorithmic', 'top', '4', 'show-tier'),
    pick('Equibase Off to the Races', 'algorithmic', 'second', '7', 'win-tier'),
    pick('Equibase Off to the Races', 'algorithmic', 'also', '9', 'box-only'),
  ]);
  // favorite is '1' (0.8 ML); the box is {4,7,9} - favorite absent -> fires.
  return flags.some((f) => f.type === 'algo_fades_favorite' && f.programNumber === '1' && /box/.test(f.detail));
})());

check('D74: a box-only algo source does NOT fade when the favorite IS in its box', (() => {
  const flags = contrarianFlags(entries, [
    pick('Equibase Off to the Races', 'algorithmic', 'top', '1', 'show-tier'),
    pick('Equibase Off to the Races', 'algorithmic', 'second', '7', 'win-tier'),
    pick('Equibase Off to the Races', 'algorithmic', 'also', '9', 'box-only'),
  ]);
  return !flags.some((f) => f.type === 'algo_fades_favorite');
})());

check('D74: a source with a real ranked fullOrder is never double-flagged by the box-only rule', (() => {
  const flags = contrarianFlags(entries, [
    pick('SFTB', 'algorithmic', 'top', '4', orderNote([
      { rank: 1, programNumber: '4' }, { rank: 2, programNumber: '7' },
      { rank: 3, programNumber: '9' }, { rank: 4, programNumber: '1' },
    ])),
  ]);
  return flags.filter((f) => f.type === 'algo_fades_favorite').length === 1;
})());

if (failures) {
  console.error(`\ncheck-classification: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-classification: all checks passed');
