// M-3 (docs/requirements/multi-parser-entries-ingest.md): the pure diff
// between a baseline parser's output and a challenger's, for the SAME
// track and date. Pure and browser-safe (no `node:` import), matching
// every other module under `shared/`, so it can be unit-tested directly
// with hand-built fixtures rather than only through a file on disk.
//
// Always baseline-vs-challenger, never symmetric peer comparison (the
// scope's own stated rule: the HTML parser is the trusted reference until
// a comparison process says otherwise) - callers pass whichever parser is
// currently `isDefault` as `baseline`, always.
//
// Horses are matched across the two parses by `nameKey` (`shared/parsers/
// human-picks.js` - the ONE horse-name normalizer in this codebase),
// not by `programNumber`: one source may print a state suffix in the name
// ("Sweet Scorecard (KY)") and the other may not, but `programNumber`
// itself can be exactly the field under test (a real parser bug could
// print the wrong one), so matching on it first would hide that class of
// bug behind a "missing" report instead of a "mismatch" one.
//
// `fieldsNotProvided` on each side decides how a field is reported:
// neither side claims it -> skipped entirely (not a finding); only the
// CHALLENGER lacks it -> a baseline-only field (the challenger's gap);
// only the BASELINE lacks it -> a challenger-only field (the scope's
// "additive value" case - reported separately from mismatches, never
// lumped in with them, so a challenger with more coverage but a few
// formatting bugs doesn't read as worse than it is on net); both claim it
// -> compared value-for-value, and a disagreement is a mismatch.

import { nameKey } from './human-picks.js';

const RACE_FIELDS = ['postTime', 'distance', 'surface', 'raceType', 'wagerMenu', 'conditions', 'claimingPriceCents'];
const ENTRY_FIELDS = [
  'programNumber', 'postPosition', 'jockey', 'trainer', 'weight',
  'morningLine', 'morningLineDecimal', 'medication', 'ageSex', 'claimPrice', 'scratched',
];

// Two parsers can agree on a value while disagreeing on its TYPE - the
// HTML parser stores `postPosition`/`weight` as printed STRINGS ("124"),
// the Apify parser as numbers (124). A strict `!==` flags that as a
// mismatch even though `insertRaceDay`'s own `toInt()` treats them
// identically downstream - found live while verifying this module against
// real parser output (Broheim's `postPosition` and `weight` both "matched
// as different" until this fix landed). Coerce through `Number` only when
// BOTH sides look numeric; anything else (strings that aren't numeric,
// booleans, nulls) stays a strict comparison, so a real content
// disagreement is never masked by this.
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const an = Number(a);
  const bn = Number(b);
  return !Number.isNaN(an) && !Number.isNaN(bn) && an === bn;
}

function splitFieldCoverage(allFields, baselineFieldsNotProvided, challengerFieldsNotProvided) {
  const baseNP = new Set(baselineFieldsNotProvided);
  const challNP = new Set(challengerFieldsNotProvided);
  return {
    // The challenger's gap: baseline has it, challenger structurally can't.
    baselineOnlyFields: allFields.filter((f) => !baseNP.has(f) && challNP.has(f)),
    // The scope's "additive value": challenger has it, baseline structurally can't.
    challengerOnlyFields: allFields.filter((f) => baseNP.has(f) && !challNP.has(f)),
    // Both claim it - the only fields actually diffed value-for-value.
    bothProvide: allFields.filter((f) => !baseNP.has(f) && !challNP.has(f)),
  };
}

// Data-quality checks named explicitly in the inherited scope, generalised
// beyond the one actor (getascraper) it originally named them for - both
// are real, general risk classes any scraped source can exhibit, not a
// property of one vendor.
// `Number(e.postPosition)`, not `e.postPosition` directly - the HTML
// parser prints post position as a STRING ("1"), the Apify parser as a
// number (1). Filtering on `Number.isInteger(e.postPosition)` without
// coercing first would silently exclude every HTML-parser entry from this
// check, never finding a gap on that side at all - the same class of trap
// `valuesEqual` above exists to avoid.
function checkPostPositionGap(entries) {
  const positions = entries
    .filter((e) => !e.scratched && Number.isInteger(Number(e.postPosition)))
    .map((e) => Number(e.postPosition))
    .sort((a, b) => a - b);
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] !== positions[i - 1] + 1) return positions;
  }
  return null;
}

function checkDoubleSpaceNames(entries) {
  const hits = [];
  for (const e of entries) {
    for (const field of ['jockey', 'trainer']) {
      if (e[field] && /\s{2,}/.test(e[field])) hits.push({ horseName: e.horseName, field, value: e[field] });
    }
  }
  return hits;
}

export function compareParsedDays(baseline, challenger, {
  baselineFieldsNotProvided = [], challengerFieldsNotProvided = [],
} = {}) {
  const raceFieldCoverage = splitFieldCoverage(RACE_FIELDS, baselineFieldsNotProvided, challengerFieldsNotProvided);
  const entryFieldCoverage = splitFieldCoverage(ENTRY_FIELDS, baselineFieldsNotProvided, challengerFieldsNotProvided);

  const baseRaces = new Map(baseline.races.map((r) => [r.number, r]));
  const challRaces = new Map(challenger.races.map((r) => [r.number, r]));
  const allRaceNumbers = [...new Set([...baseRaces.keys(), ...challRaces.keys()])].sort((a, b) => a - b);

  const perRace = [];
  const dataQuality = { postPositionGaps: [], doubleSpaceNames: [] };

  for (const number of allRaceNumbers) {
    const baseRace = baseRaces.get(number) ?? null;
    const challRace = challRaces.get(number) ?? null;
    const row = {
      number,
      inBaseline: !!baseRace,
      inChallenger: !!challRace,
      baselineEntries: baseRace?.entries.length ?? null,
      challengerEntries: challRace?.entries.length ?? null,
      entryCountMatch: baseRace && challRace ? baseRace.entries.length === challRace.entries.length : null,
      raceFieldMismatches: [],
      entryMismatches: [],
      missingInChallenger: [],
      missingInBaseline: [],
    };

    if (baseRace && challRace) {
      for (const field of raceFieldCoverage.bothProvide) {
        if (!valuesEqual(baseRace[field], challRace[field])) {
          row.raceFieldMismatches.push({ field, baseline: baseRace[field], challenger: challRace[field] });
        }
      }

      const baseByKey = new Map(baseRace.entries.map((e) => [nameKey(e.horseName), e]));
      const challByKey = new Map(challRace.entries.map((e) => [nameKey(e.horseName), e]));
      const allKeys = [...new Set([...baseByKey.keys(), ...challByKey.keys()])];

      for (const key of allKeys) {
        const be = baseByKey.get(key);
        const ce = challByKey.get(key);
        if (be && !ce) { row.missingInChallenger.push(be.horseName); continue; }
        if (ce && !be) { row.missingInBaseline.push(ce.horseName); continue; }
        const mismatches = [];
        for (const field of entryFieldCoverage.bothProvide) {
          if (!valuesEqual(be[field], ce[field])) mismatches.push({ field, baseline: be[field], challenger: ce[field] });
        }
        if (mismatches.length) row.entryMismatches.push({ horseName: be.horseName, mismatches });
      }

      const baseGap = checkPostPositionGap(baseRace.entries);
      if (baseGap) dataQuality.postPositionGaps.push({ side: 'baseline', race: number, positions: baseGap });
      const challGap = checkPostPositionGap(challRace.entries);
      if (challGap) dataQuality.postPositionGaps.push({ side: 'challenger', race: number, positions: challGap });

      for (const hit of checkDoubleSpaceNames(baseRace.entries)) {
        dataQuality.doubleSpaceNames.push({ side: 'baseline', race: number, ...hit });
      }
      for (const hit of checkDoubleSpaceNames(challRace.entries)) {
        dataQuality.doubleSpaceNames.push({ side: 'challenger', race: number, ...hit });
      }
    }

    perRace.push(row);
  }

  return {
    baselineRaceCount: baseline.races.length,
    challengerRaceCount: challenger.races.length,
    raceCountMatch: baseline.races.length === challenger.races.length,
    baselineOnlyFields: [...raceFieldCoverage.baselineOnlyFields, ...entryFieldCoverage.baselineOnlyFields],
    challengerOnlyFields: [...raceFieldCoverage.challengerOnlyFields, ...entryFieldCoverage.challengerOnlyFields],
    perRace,
    dataQuality,
  };
}
