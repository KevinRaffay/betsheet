// D219: the third registered entries parser, `shared/parsers/
// equibase-getascraper.js`, against the one real captured sample on file plus
// hand-built synthetic cases for every refusal and every inference.
//
// Shaped like scripts/check-equibase-apify-parseforge.js: a golden diff for
// "nothing moved," then INDEPENDENT hand counts against the raw file so the
// golden itself is checkable rather than self-certifying (a golden regenerated
// from a broken parser passes its own diff forever).
//
// THE LOAD-BEARING SECTION IS `checkCalendarPlacement()`. This parser exists for
// one measured reason - parseforge carries no post time, so every day ingested
// from it is blank on the D209-D211 race-day calendar - and the way to fail at
// that job silently is to store a post time the calendar cannot read. That
// section asserts the real `placeRacePacific` actually places this parser's
// output, and asserts the parseforge contrast in the same breath so the premise
// stays checked rather than remembered.
//
// SAMPLE LIMITATION, stated rather than hidden: the real capture holds ONE
// entries row (Saratoga race 1, 9 horses). It is a genuine end-to-end sample and
// every field assertion below is real, but it cannot exercise multi-race
// assembly, a scratch, or a coupled entry. Those are covered synthetically here
// and flagged in DELIVERABLES.md D219 as wanting a fuller capture.

import { readFileSync } from 'node:fs';
import { parseGetascraperDataset, getascraperToPayload } from '../shared/parsers/equibase-getascraper.js';
import { parseApifyParseforgeDataset } from '../shared/parsers/equibase-apify-parseforge.js';
import { placeRacePacific } from '../shared/race-calendar.js';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { morningLineToDecimal } from '../shared/betmath.js';

const FIXTURES = 'tests/fixtures/equibase-getascraper';
const SAMPLE = `${FIXTURES}/getascraper-sar-2026-09-07`;
const LEGACY = `${FIXTURES}/getascraper-legacy-shape-dmr-2026-08-30.json`;
const PARSEFORGE = 'tests/fixtures/equibase-apify/parseforge-dmr-2026-09-07.json';

let failures = 0;
let checks = 0;
function ok(cond, label, detail) {
  checks += 1;
  if (cond) { console.log(`  ok    ${label}`); return; }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
}
const eq = (actual, expected, label) =>
  ok(Object.is(actual, expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const readRaw = (p) => readFileSync(p, 'utf8');
const parse = (raw, ctx) => parseGetascraperDataset(raw, ctx);
const blockingTypes = (r) => r.warnings.filter((w) => w.blocking).map((w) => w.type);
const warnOfType = (r, t) => r.warnings.find((w) => w.type === t);

// ---------------------------------------------------------------- golden diff
function checkGolden() {
  console.log('-- golden: the real capture still parses byte-identically --');
  const actual = parse(readRaw(`${SAMPLE}.json`));
  const expected = JSON.parse(readRaw(`${SAMPLE}.expected.json`));
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    'parse output matches the committed golden',
    'regenerate only when the change is intended, and diff it before committing',
  );
}

// -------------------------------------------- hand counts against the raw file
function checkHandCounts() {
  console.log('-- hand counts, derived from the RAW file not the golden --');
  const rows = JSON.parse(readRaw(`${SAMPLE}.json`));
  const entryRows = rows.filter((r) => Array.isArray(r.entries) && r.entries.length);
  const resultRows = rows.filter((r) => r.resultsAvailable === true);
  eq(rows.length, 3, 'raw file holds 3 rows');
  eq(entryRows.length, 1, 'exactly 1 of them is an entries row');
  eq(resultRows.length, 2, 'the other 2 are results rows');

  const parsed = parse(readRaw(`${SAMPLE}.json`));
  eq(parsed.track, 'Saratoga', 'track is Saratoga');
  eq(parsed.date, '2026-09-07', 'date is 2026-09-07');
  eq(parsed.races.length, 1, 'results rows are ignored, leaving 1 race');
  eq(parsed.races[0].number, 1, 'the race is race 1');
  eq(parsed.races[0].entries.length, 9, 'race 1 has 9 entries (hand-counted on the raw row)');
  eq(parsed.races[0].entries.length, entryRows[0].entriesCount, 'entry count matches the row\'s own entriesCount');

  // Every horse name in the raw row survives, in order.
  const rawNames = entryRows[0].entries.map((e) => e.horseName);
  const gotNames = parsed.races[0].entries.map((e) => e.horseName);
  ok(JSON.stringify(rawNames) === JSON.stringify(gotNames), 'all 9 horse names survive in source order');

  // Spot-check the first and last horse end to end.
  const first = parsed.races[0].entries[0];
  eq(first.horseName, 'Miss Nightfall (GB)', 'first horse keeps its country suffix');
  eq(first.programNumber, '1', 'first horse program number derived from post position 1');
  eq(first.postPosition, 1, 'first horse post position preserved as a number');
  eq(first.morningLine, '5/2', 'first horse morning line preserved as printed');
  eq(first.weight, 126, 'first horse weight preserved');
  const last = parsed.races[0].entries[8];
  eq(last.horseName, 'Beira (KY)', 'last horse is Beira');
  eq(last.jockey, 'Rider TBA', 'a "Rider TBA" jockey is kept, not nulled');
}

// ------------------------------------------------------- the two derivations
function checkDerivations() {
  console.log('-- the two derived values, each asserted against its own source --');
  const parsed = parse(readRaw(`${SAMPLE}.json`));

  // 1. morning line decimal is RECOMPUTED, never taken from the source, and is
  //    the fractional RATIO (D190's finding on the sibling parser).
  const e = parsed.races[0].entries[0];
  eq(e.morningLineDecimal, morningLineToDecimal('5/2'), 'ML decimal comes from morningLineToDecimal, not a literal');
  ok(e.morningLineDecimal === 2.5, 'ML decimal for 5/2 is the ratio 2.5, not European 3.5');

  // 2. program numbers are derived from post position, and it is WARNED.
  const w = warnOfType(parsed, 'program_number_derived_from_post_position');
  ok(!!w, 'the derivation is reported, never silent');
  eq(w?.entries, 9, 'the warning names all 9 derived entries');
  ok(w?.blocking === false, 'the derivation warns but does not block');
  ok(/coupled entries/i.test(w?.message ?? ''), 'the warning names the coupled-entry case it does NOT cover');

  // The derivation is sound for an ordinary field: this source's own results
  // rows resolve their exotic combinations through post position. Verified here
  // against the raw file so the claim is checked, not asserted in a comment.
  const rows = JSON.parse(readRaw(`${SAMPLE}.json`));
  const entryRow = rows.find((r) => Array.isArray(r.entries) && r.entries.length);
  const resultRow = rows.find((r) => r.resultsAvailable === true && r.raceId === entryRow.raceId);
  const byPost = new Map(entryRow.entries.map((x) => [String(x.postPosition), x.horseName]));
  const exacta = resultRow.exoticPayouts.find((x) => /Exacta/.test(x.wagerType));
  const resolved = exacta.combination.split('-').map((n) => byPost.get(n));
  const stripCountry = (s) => String(s).replace(/\s*\([A-Z]{2,3}\)\s*$/, '');
  ok(
    resolved.length === 2 && resolved.every(Boolean),
    'every leg of the exacta combination resolves through post position',
  );
  ok(
    stripCountry(resolved[0]) === stripCountry(resultRow.finishOrder[0])
    && stripCountry(resolved[1]) === stripCountry(resultRow.finishOrder[1]),
    'the resolved exacta is exactly the 1st and 2nd finishers',
    `got ${resolved.join(' / ')} vs ${resultRow.finishOrder.slice(0, 2).join(' / ')}`,
  );
}

// ----------------------------------------------- post time: the whole point
const synth = (postTime, over = {}) => JSON.stringify([{
  raceId: 'SAR-2026-09-07-R1',
  raceNumber: 1,
  raceDate: '2026-09-07',
  trackCode: 'SAR',
  trackName: 'Saratoga',
  postTime,
  entriesCount: 1,
  entries: [{ postPosition: 1, horseName: 'A', weight: 126, morningLineOdds: '5/2' }],
  ...over,
}]);
const postTimeOf = (raw, ctx) => parse(raw, ctx).races[0]?.postTime ?? null;

function checkPostTime() {
  console.log('-- post time: the timezone suffix is stripped, the meridiem is NOT --');
  eq(postTimeOf(synth('11:30 AM ET')), '11:30 AM', 'a "ET" suffix is stripped');
  eq(postTimeOf(synth('11:30 AM EDT')), '11:30 AM', 'a "EDT" suffix is stripped');
  eq(postTimeOf(synth('1:30 PM')), '1:30 PM', 'a bare time is untouched');
  // The regression that shipped in this file's own first draft: /[A-Z]{2,4}$/
  // matches "AM", so "11:30 AM" was stored as "11:30" - a 12-hour error hiding
  // behind a populated-looking column.
  eq(postTimeOf(synth('11:30 AM')), '11:30 AM', 'AM is a meridiem, not a zone (regression guard)');
  eq(postTimeOf(synth('11:30 PM')), '11:30 PM', 'PM is a meridiem, not a zone (regression guard)');

  console.log('-- post time: the printed zone is cross-checked against the registry --');
  ok(!warnOfType(parse(synth('11:30 AM ET')), 'post_time_zone_mismatch'), 'ET on an Eastern track does not warn');
  ok(!!warnOfType(parse(synth('11:30 AM PT')), 'post_time_zone_mismatch'), 'PT on an Eastern track DOES warn');
  ok(!!warnOfType(parse(synth('11:30 AM MT')), 'post_time_zone_mismatch'), 'MT on an Eastern track DOES warn');
  ok(!warnOfType(parse(synth('11:30 AM')), 'post_time_zone_mismatch'), 'no printed zone cannot mismatch');

  const missing = parse(synth(null));
  eq(missing.races[0].postTime, null, 'a null post time stays null');
  const w = warnOfType(missing, 'races_without_post_time');
  ok(!!w, 'a race with no post time is reported');
  ok(/calendar/i.test(w?.message ?? ''), 'the warning says what the consequence is (no calendar placement)');
}

// -------------------------------------------- the reason this parser exists
function checkCalendarPlacement() {
  console.log('-- LOAD-BEARING: the parsed post time actually places on the calendar --');
  const g = parse(readRaw(`${SAMPLE}.json`));
  const zone = canonicalizeTrack(g.track).timezone;
  eq(zone, 'America/New_York', 'Saratoga resolves to a real IANA zone');
  const placed = placeRacePacific(g.date, g.races[0].postTime, zone);
  ok(!!placed, 'placeRacePacific accepts this parser\'s post time');
  eq(placed?.postTimePacific, '8:30 AM PDT', '11:30 AM ET converts to 8:30 AM PDT');
  eq(placed?.hourBucket, 1, 'and lands in hour bucket 1');

  // The premise, re-measured rather than remembered: the incumbent Apify source
  // places NOTHING, which is what this deliverable is for.
  const p = parseApifyParseforgeDataset(readRaw(PARSEFORGE));
  const pz = canonicalizeTrack(p.track).timezone;
  const pPlaced = p.races.filter((r) => placeRacePacific(p.date, r.postTime, pz)).length;
  eq(p.races.length, 11, 'the parseforge fixture holds 11 races');
  eq(pPlaced, 0, 'parseforge places 0 of them - the gap this parser closes');
}

// ------------------------------------------------------------- refusals
function checkRefusals() {
  console.log('-- refusals: every one warns rather than throwing --');
  const cases = [
    ['{nope', 'invalid_json', 'malformed JSON'],
    ['{"a":1}', 'not_an_array', 'a JSON object instead of an array'],
    ['[]', 'no_races', 'an empty array'],
    [JSON.stringify([{ raceId: 'X', raceNumber: 1, resultsAvailable: true, entriesCount: 0 }]), 'no_races', 'a results-only file'],
  ];
  for (const [input, type, label] of cases) {
    const r = parse(input);
    ok(blockingTypes(r).includes(type), `${label} -> ${type}`, `got ${blockingTypes(r).join(',') || '(none)'}`);
    eq(r.races.length, 0, `  ${label} yields no races`);
  }

  // The older snake_case output of this SAME actor is refused by name rather
  // than half-parsed - the real legacy capture, not a synthetic one.
  const legacy = parse(readRaw(LEGACY));
  ok(blockingTypes(legacy).includes('unsupported_output_shape'), 'the real legacy snake_case capture is refused by name');
  ok(/camelCase/.test(warnOfType(legacy, 'unsupported_output_shape')?.message ?? ''), 'and the refusal says how to fix it');

  const twoTracks = JSON.stringify([
    { raceNumber: 1, raceDate: '2026-09-07', trackCode: 'SAR', trackName: 'Saratoga', entries: [{ postPosition: 1, horseName: 'A' }] },
    { raceNumber: 1, raceDate: '2026-09-07', trackCode: 'KD', trackName: 'Kentucky Downs', entries: [{ postPosition: 1, horseName: 'B' }] },
  ]);
  ok(blockingTypes(parse(twoTracks)).includes('multiple_tracks_in_file'), 'two tracks and no context -> refuse, never guess');
  eq(parse(twoTracks, { trackCode: 'SAR' }).races.length, 1, 'two tracks with a context selects one');
  eq(parse(twoTracks, { trackCode: 'SAR' }).track, 'Saratoga', 'and it is the requested one');
  ok(blockingTypes(parse(twoTracks, { trackCode: 'DMR' })).includes('track_not_in_file'), 'a track not in the file -> refuse');

  const twoDates = JSON.stringify([
    { raceNumber: 1, raceDate: '2026-09-07', trackCode: 'SAR', trackName: 'Saratoga', entries: [{ postPosition: 1, horseName: 'A' }] },
    { raceNumber: 2, raceDate: '2026-09-08', trackCode: 'SAR', trackName: 'Saratoga', entries: [{ postPosition: 1, horseName: 'B' }] },
  ]);
  ok(blockingTypes(parse(twoDates)).includes('multiple_dates_in_file'), 'one track over two dates -> refuse');
}

// ------------------------------------------------------- data-quality warnings
function checkDataQuality() {
  console.log('-- data-quality warnings --');
  const heavy = parse(synth('1:00 PM', {
    entries: [{ postPosition: 1, horseName: 'A', weight: 1175, morningLineOdds: '5/2' }],
  }));
  const w = warnOfType(heavy, 'implausible_weight');
  ok(!!w, 'the 1175-style weight glitch (real, seen in both actors) is flagged');
  ok(w?.blocking === false, 'and it warns rather than blocking a whole card');

  const miscount = parse(synth('1:00 PM', { entriesCount: 5 }));
  ok(!!warnOfType(miscount, 'entries_count_mismatch'), 'a stated entriesCount that disagrees with the rows is flagged');

  const noPost = parse(synth('1:00 PM', {
    entries: [{ horseName: 'A', morningLineOdds: '5/2' }],
  }));
  ok(!!warnOfType(noPost, 'entry_missing_post_position'), 'a horse with no post position is flagged');
  eq(noPost.races[0].entries[0].programNumber, null, 'and gets NO invented program number');

  const dupe = JSON.parse(synth('1:00 PM'));
  const dupes = parse(JSON.stringify([dupe[0], { ...dupe[0] }]));
  ok(!!warnOfType(dupes, 'duplicate_race_row'), 'two entries rows for one race is flagged');
  eq(dupes.races.length, 1, 'and only one race is built');
}

// ------------------------------------------------- D207: every warning renders
function checkMessages() {
  console.log('-- D207: every warning carries a non-empty message (ParsePreview renders w.message) --');
  const produced = [
    parse(readRaw(`${SAMPLE}.json`)),
    parse(readRaw(LEGACY)),
    parse('{nope'),
    parse('{"a":1}'),
    parse('[]'),
    parse(synth(null)),
    parse(synth('11:30 AM PT')),
    parse(synth('1:00 PM', { entriesCount: 5 })),
    parse(synth('1:00 PM', { entries: [{ postPosition: 1, horseName: 'A', weight: 1175 }] })),
    parse(synth('1:00 PM', { entries: [{ horseName: 'A' }] })),
  ];
  let total = 0;
  let bad = 0;
  for (const r of produced) {
    for (const w of r.warnings) {
      total += 1;
      if (typeof w.message !== 'string' || !w.message.trim()) { bad += 1; console.log(`          empty message on ${w.type}`); }
    }
  }
  ok(total > 0, `${total} warnings produced across the scenarios`);
  eq(bad, 0, 'none of them has an empty message');
}

// ------------------------------------------------------------------ toPayload
function checkToPayload() {
  console.log('-- toPayload: provenance and capture time, nothing reshaped --');
  const parsed = parse(readRaw(`${SAMPLE}.json`));
  const payload = getascraperToPayload(parsed, '2026-09-10T18:21:01.882Z');
  eq(payload.entriesSource, 'equibase_getascraper', 'entriesSource is this source\'s own provenance value');
  eq(payload.oddsCapturedAt, '2026-09-10T18:21:01.882Z', 'capture time is carried through');
  eq(payload.track, parsed.track, 'track passes through unchanged');
  eq(payload.date, parsed.date, 'date passes through unchanged');
  ok(payload.races === parsed.races, 'races pass through by reference - no reshaping step exists');
}

console.log('== check-getascraper-entries ==');
checkGolden();
checkHandCounts();
checkDerivations();
checkPostTime();
checkCalendarPlacement();
checkRefusals();
checkDataQuality();
checkMessages();
checkToPayload();

console.log(`\n${failures === 0 ? 'All' : `${checks - failures} of ${checks}`} getascraper entries checks passed.`);
if (failures > 0) {
  console.error(`${failures} check(s) FAILED.`);
  process.exit(1);
}
