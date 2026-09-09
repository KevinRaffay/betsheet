// The second registered entries parser (M-1's registry, `shared/parsers/
// registry.js`), unblocking M-3's own dependency ("needs >=2 registered
// parsers") - see docs/requirements/multi-parser-entries-ingest.md.
//
// Reads an Apify dataset export from the `parseforge/equibase-scraper`
// actor - identified from the sample's own filename convention
// (`dataset_equibase-scraper_<timestamp>.json`, Apify's default export name
// is `dataset_<actor-name>_<timestamp>`) and corroborated by content: the
// scope this codebase inherited said "only parseforge currently reports
// scratches, medication, and claiming price," and this sample's rows carry
// all three (`isScratched`, `medication`, `claimingPrice`/
// `horseClaimingPrice`).
//
// Pure and browser-safe (no `node:` import), matching every other parser
// under `shared/parsers/`. `JSON.parse` on malformed input throws inside a
// try/catch here, never escapes - the "never throws" contract every other
// parser in this codebase holds itself to.
//
// STRUCTURAL DIFFERENCE FROM THE HTML PARSER: one Apify dataset file is a
// FLAT array of per-horse rows (`rowType: 'entry'` on every row seen so
// far - no header/race-summary row exists), with every race-level field
// (track, date, distance, wagers, ...) REPEATED on each of that race's
// rows, and - unlike one Equibase HTML page, which is always exactly one
// track - the array can span MULTIPLE TRACKS in one file (this sample
// holds IND and KD together). `parse(rawInput, context)` therefore accepts
// an optional `context.trackCode` to select which track's rows to extract;
// with more than one track present and no `trackCode` given, it refuses
// with a blocking warning rather than guessing which one the caller wanted.
//
// LOAD-BEARING FIX, do not "simplify" away: this source's own
// `morningLineDecimal` is EUROPEAN "decimal odds" (fraction + 1 - "7/5"
// carries 2.4 in the sample, not 1.4). This codebase's `morningLineToDecimal`
// (shared/betmath.js) returns the fractional RATIO ALONE - D171's own
// ledger entry proves it ("the fractional RATIO, winPayout's stake *
// (ml + 1) proves it"). Trusting the source's number directly would
// silently double-count the +1 on every payout estimate and grade built
// from this parser, so it is always DISCARDED and recomputed from
// `morningLineOdds` here.
//
// fieldsNotProvided (declared on this parser's registry entry, not
// returned per-call, since the gap is structural to the SOURCE, not any
// one day's data): this source never carries a post time, live odds, or
// also-eligible status, on any row seen. `distanceYards` is additive value
// the HTML parser doesn't have, but `insertRaceDay`'s schema has no column
// for it (same class of gap `UNMAPPED` already tracks in
// batch-import-equibase-entries.js) - dropped here, not stored anywhere.

import { morningLineToDecimal } from '../betmath.js';

const SEE_MORE_LESS_RE = /\s*\.{0,3}\s*See More See Less\s*$/;

function cleanConditions(text) {
  if (!text) return null;
  const cleaned = text.replace(SEE_MORE_LESS_RE, '').trim();
  return cleaned || null;
}

function centsFromDollars(n) {
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// entries.claim_price is TEXT, "as printed" (migration 024's own comment) -
// every other parser stores a dollar string like "$50,000", never a number.
function dollarString(n) {
  return Number.isFinite(n) ? `$${n.toLocaleString('en-US')}` : null;
}

const emptyResult = (warnings) => ({ track: null, date: null, races: [], warnings });

export function parseApifyParseforgeDataset(rawInput, context = {}) {
  let rows;
  try {
    rows = JSON.parse(rawInput);
  } catch (err) {
    return emptyResult([{ type: 'invalid_json', blocking: true, message: String(err?.message ?? err) }]);
  }
  if (!Array.isArray(rows)) return emptyResult([{ type: 'not_an_array', blocking: true }]);

  const entryRows = rows.filter((r) => r && r.rowType === 'entry');
  if (entryRows.length === 0) return emptyResult([{ type: 'no_races', blocking: true }]);

  const tracksPresent = [...new Set(entryRows.map((r) => r.trackCode).filter(Boolean))];
  let trackCode = context.trackCode ?? null;
  if (trackCode) {
    if (!tracksPresent.includes(trackCode)) {
      return emptyResult([{ type: 'track_not_in_file', blocking: true, requested: trackCode, available: tracksPresent }]);
    }
  } else if (tracksPresent.length === 1) {
    trackCode = tracksPresent[0];
  } else {
    // Never guess which of several tracks in one file the caller wanted -
    // matches the HTML parser's own refusal shape (no_track_or_date) for
    // "this file's identity is ambiguous," so every caller already knows
    // how to treat it: a blocking warning, not a crash or a silent pick.
    return emptyResult([{ type: 'multiple_tracks_in_file', blocking: true, tracks: tracksPresent }]);
  }

  const trackRows = entryRows.filter((r) => r.trackCode === trackCode);
  const datesPresent = [...new Set(trackRows.map((r) => r.raceDate).filter(Boolean))];
  if (datesPresent.length === 0) return emptyResult([{ type: 'no_track_or_date', blocking: true }]);
  if (datesPresent.length > 1) {
    return emptyResult([{ type: 'multiple_dates_in_file', blocking: true, dates: datesPresent, trackCode }]);
  }
  const date = datesPresent[0];
  const track = trackRows[0].trackName || trackCode;

  const warnings = [];
  const byRace = new Map();

  for (const row of trackRows) {
    const number = row.raceNumber;
    if (!Number.isInteger(number)) {
      warnings.push({ type: 'row_missing_race_number', blocking: false, horse: row.horse ?? null });
      continue;
    }
    if (!byRace.has(number)) {
      byRace.set(number, {
        number,
        postTime: null, // fieldsNotProvided - this source never prints one
        distance: row.distance ?? null,
        surface: row.surface ?? null,
        raceType: row.raceType ?? null,
        wagerMenu: Array.isArray(row.wagers) && row.wagers.length ? row.wagers.join(' / ') : null,
        conditions: cleanConditions(row.conditions),
        claimingPriceCents: centsFromDollars(row.claimingPrice),
        entries: [],
      });
    }
    const race = byRace.get(number);
    if (!race.wagerMenu && Array.isArray(row.wagers) && row.wagers.length) {
      race.wagerMenu = row.wagers.join(' / ');
    }

    const scratched = row.isScratched === true;
    const horseName = row.horse
      ? (row.horseState ? `${row.horse} (${row.horseState})` : row.horse)
      : null;
    if (!horseName) warnings.push({ type: 'entry_missing_horse_name', blocking: false, race: number });

    const ageSex = Number.isFinite(row.age) && row.sex ? `${row.age}/${row.sex}` : null;

    const morningLine = row.morningLineOdds ?? null;
    const morningLineDecimal = morningLine ? morningLineToDecimal(morningLine) : null;

    if (Number.isFinite(row.weight) && (row.weight < 80 || row.weight > 200)) {
      warnings.push({
        type: 'implausible_weight', blocking: false, race: number,
        horse: row.horse ?? null, weight: row.weight,
      });
    }

    race.entries.push({
      programNumber: row.programNumber ?? null,
      postPosition: Number.isInteger(row.postPosition) ? row.postPosition : null,
      horseName,
      morningLine,
      morningLineDecimal,
      jockey: row.jockey ?? null,
      trainer: row.trainer ?? null,
      weight: Number.isFinite(row.weight) ? row.weight : null,
      scratched,
      liveOdds: null, // fieldsNotProvided
      liveOddsDecimal: null, // fieldsNotProvided
      medication: row.medication ?? null,
      ageSex,
      claimPrice: dollarString(row.horseClaimingPrice),
      alsoEligible: false, // fieldsNotProvided
    });
  }

  const races = [...byRace.values()].sort((a, b) => a.number - b.number);
  if (races.length === 0) warnings.push({ type: 'no_races', blocking: true });
  for (const race of races) {
    if (!race.wagerMenu) warnings.push({ type: 'no_wager_menu', blocking: false, race: race.number });
  }

  return { track, date, races, warnings };
}

// NOT WIRED TO ANY SAVE PATH (deliberately). insertRaceDay's
// `entries_source` CHECK constraint (migration 024) has no value for an
// Apify-sourced day - only 'program', 'ml_sheet', 'both', 'equibase_html'
// - and a value missing from that list is silently coerced to 'program'
// (M-1's finding 8) rather than refused. Adding a value needs a
// schema-rebuild migration verified against a VACUUM INTO copy of the real
// corpus (CLAUDE.md's own caution for this exact table), which is M-5's
// scope, not this parser's. Throwing here turns a silent mislabel into a
// loud, unmissable failure until that migration exists.
export function apifyParseforgeToPayload() {
  throw new Error(
    'equibase-apify-parseforge: toPayload is not wired to a real save path yet - '
    + "insertRaceDay's entries_source CHECK constraint has no value for an Apify-sourced "
    + "day (finding 8 / M-5), and passing an unlisted value would silently mislabel it as "
    + "'program' rather than refuse. Extend the schema (a rebuild migration, matching "
    + 'migration 024\'s own precedent) before wiring this parser into any save path.',
  );
}
