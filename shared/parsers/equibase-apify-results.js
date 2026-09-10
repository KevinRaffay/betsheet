// A second results source (D193, docs/requirements/
// equibase-apify-results-ingest.md): an Apify dataset export in the same
// `equibase-scraper` naming family already registered on the entries side
// (equibase-apify-parseforge.js, D190), but scraped in a results mode -
// rowType 'result' rather than 'entry', one row per finisher rather than
// per starter.
//
// Pure and browser-safe (no `node:` import), never throws - same contract
// every parser under shared/parsers/ holds. Produces `{track, date, races}`
// directly in server/results.js's `saveResults` shape (no adapter/toPayload
// reshaping step is needed the way the entries side needs one, since this
// source's fields already line up one-to-one with what race_results/
// exotic_payoffs/result_scratches persist).
//
// WIRED TO A REAL SAVE PATH (D195/D196): result_charts.source_kind's CHECK
// constraint (migration 033) admits 'equibase_apify';
// server/equibase-apify-results.js's preview route calls this parser
// directly and hands its output straight to saveResults, unchanged.
//
// SCRATCH DERIVATION (resolved 2026-09-09, user decision): this source
// names no scratches at all - only horses that actually finished appear.
// A program number present in the day's already-saved entries but absent
// from this race's finishers is ASSUMED SCRATCHED, no other state exists.
// Safe specifically because entries are always ingested before results for
// every race day this codebase handles - the diff always has a real,
// already-saved list to run against. Kept OUT of the database: the caller
// passes `context.entriesByRace` (the day's own entries, already loaded),
// so this file stays pure with no DB access, the same way `context.trackCode`
// already lets a caller supply what the source itself can't.
//
// STRUCTURAL DIFFERENCES FROM equibase-apify-parseforge.js:
//  - rows are finishers, not starters - `exoticWagers` rides on the WINNER'S
//    row only (confirmed: exactly one row per race carries it), not spread
//    across every row.
//  - payout figures (`winPayoff`/`placePayoff`/`showPayoff`/exotic `payoff`)
//    are plain decimal dollars-per-$2 mutuel prices, the SAME convention
//    shared/chart-parser.js's own `money()` already assumes (`× 100`) - no
//    unit-mismatch trap like D190 found with `morningLineDecimal`.
//  - `trackCode` is Equibase's own track id, present directly on every row -
//    the chart parser has to derive one from a free-text header line instead.
//
// fieldsNotProvided (structural to the source, not any one day's data):
// jockey, trainer, weight and win odds per finisher are never present -
// this is not a gap against what `race_results` persists, since none of
// those are stored columns; chart-parser.js only extracts them in passing.
// `finalTime` is present per race when the source captured it, but this
// real sample already shows it can be absent for a whole race (2 of 11) -
// reported as a non-blocking per-race warning, never rendered as `''`.

const BET_TYPES = {
  exacta: 'exacta', quinella: 'quinella', trifecta: 'trifecta',
  superfecta: 'superfecta', 'daily double': 'daily_double',
  'pick 3': 'pick3', 'pick 4': 'pick4', 'pick 5': 'pick5', 'pick 6': 'pick6',
  'super high five': 'super_high_five', consolation: 'consolation', '3x3': '3x3',
};

const COMBO_ANNOTATION_RE = /\s*\(\d+\s+correct\)\s*$/;
const WAGER_TYPE_RE = /^\$(\d+(?:\.\d+)?)\s+(.+)$/;

function centsFromDollars(n) {
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// "$1 Exacta" -> {baseCents: 100, betType: 'exacta'}; "$0.50 Pick 3" ->
// {baseCents: 50, betType: 'pick3'}. Unlike the raw chart text (one line to
// split positionally at the first "$"), base/type/combination/payout already
// arrive as four separate fields, so this is a strictly easier parse.
function parseWagerType(wagerType) {
  const m = String(wagerType ?? '').match(WAGER_TYPE_RE);
  if (!m) return null;
  const baseCents = centsFromDollars(Number(m[1]));
  const typeKey = m[2].trim().toLowerCase().replace(/\s+/g, ' ');
  const betType = BET_TYPES[typeKey] ?? typeKey.replace(/[^a-z0-9]+/g, '_');
  return { baseCents, betType };
}

// "12-4-4-1/2/5/6/8 (4 correct)" -> "12-4-4-1/2/5/6/8" - the same trailing
// annotation shared/chart-parser.js's parseExotic already strips, just
// arriving as a suffix on a clean field here instead of embedded in a line.
function stripComboAnnotation(winningNumbers) {
  return String(winningNumbers ?? '').replace(COMBO_ANNOTATION_RE, '').trim();
}

const emptyResult = (warnings) => ({ track: null, date: null, races: [], warnings });

export function parseApifyResultsDataset(rawInput, context = {}) {
  let rows;
  try {
    rows = JSON.parse(rawInput);
  } catch (err) {
    return emptyResult([{ type: 'invalid_json', blocking: true, message: String(err?.message ?? err) }]);
  }
  if (!Array.isArray(rows)) {
    return emptyResult([{
      type: 'not_an_array', blocking: true,
      message: 'This file is not a JSON array of rows - is this an Apify equibase-scraper results dataset export?',
    }]);
  }

  const resultRows = rows.filter((r) => r && r.rowType === 'result');
  if (resultRows.length === 0) {
    return emptyResult([{
      type: 'no_races', blocking: true,
      message: 'No result rows found in this file - every row was either absent or not tagged rowType "result".',
    }]);
  }

  const tracksPresent = [...new Set(resultRows.map((r) => r.trackCode).filter(Boolean))];
  let trackCode = context.trackCode ?? null;
  if (trackCode) {
    if (!tracksPresent.includes(trackCode)) {
      return emptyResult([{
        type: 'track_not_in_file', blocking: true, requested: trackCode, available: tracksPresent,
        message: `Track ${trackCode} is not present in this file. Tracks found: ${tracksPresent.join(', ') || '(none)'}.`,
      }]);
    }
  } else if (tracksPresent.length === 1) {
    trackCode = tracksPresent[0];
  } else {
    // Never guess which of several tracks in one file the caller wanted -
    // matches equibase-apify-parseforge.js's own refusal shape. The one
    // real sample this parser is verified against is single-track, so this
    // path is precautionary rather than exercised.
    return emptyResult([{
      type: 'multiple_tracks_in_file', blocking: true, tracks: tracksPresent,
      message: `This file holds multiple tracks (${tracksPresent.join(', ')}) - specify which one before saving.`,
    }]);
  }

  const trackRows = resultRows.filter((r) => r.trackCode === trackCode);
  const datesPresent = [...new Set(trackRows.map((r) => r.raceDate).filter(Boolean))];
  if (datesPresent.length === 0) {
    return emptyResult([{
      type: 'no_track_or_date', blocking: true,
      message: `Could not read a race date for ${trackCode} from this file.`,
    }]);
  }
  if (datesPresent.length > 1) {
    return emptyResult([{
      type: 'multiple_dates_in_file', blocking: true, dates: datesPresent, trackCode,
      message: `${trackCode} has rows for multiple dates in this file (${datesPresent.join(', ')}) - expected exactly one.`,
    }]);
  }
  const date = datesPresent[0];
  const track = trackRows[0].trackName || trackCode;

  // {[raceNumber]: [{programNumber, horseName}, ...]} - the day's own
  // entries, already loaded by whoever is calling this parser. Absent
  // entirely when the caller has none yet (parser still works, it just
  // derives no scratches - the day's entries not being ingested first is
  // out of scope for this source, by the resolved design).
  const entriesByRace = context.entriesByRace ?? {};

  const warnings = [];
  const byRace = new Map();

  for (const row of trackRows) {
    const number = row.raceNumber;
    if (!Number.isInteger(number)) {
      warnings.push({
        type: 'row_missing_race_number', blocking: false, horse: row.horse ?? null,
        message: `A row for ${row.horse ?? 'an unnamed horse'} carried no race number and was skipped.`,
      });
      continue;
    }
    if (!byRace.has(number)) {
      byRace.set(number, {
        number,
        raceType: row.raceType ?? null,
        distance: row.distance ?? null,
        surface: row.surface ?? null,
        finalTime: row.finalTime ?? null,
        results: [],
        exotics: [],
        scratches: [],
      });
    }
    const race = byRace.get(number);
    if (!race.finalTime && row.finalTime) race.finalTime = row.finalTime;

    const programNumber = row.programNumber ?? null;
    if (programNumber == null) {
      warnings.push({
        type: 'finisher_missing_program_number', blocking: false, race: number, horse: row.horse ?? null,
        message: `Race ${number}: ${row.horse ?? 'a finisher'} carried no program number.`,
      });
    }
    const horseName = row.horse ?? null;
    if (!horseName) {
      warnings.push({
        type: 'finisher_missing_horse_name', blocking: false, race: number,
        message: `Race ${number}: a finisher row carried no horse name.`,
      });
    }

    race.results.push({
      programNumber,
      horseName,
      finishPosition: Number.isInteger(row.finishPosition) ? row.finishPosition : null,
      winCents: centsFromDollars(row.winPayoff),
      placeCents: centsFromDollars(row.placePayoff),
      showCents: centsFromDollars(row.showPayoff),
    });

    if (Array.isArray(row.exoticWagers)) {
      for (const x of row.exoticWagers) {
        const parsed = parseWagerType(x.wagerType);
        if (!parsed) {
          warnings.push({
            type: 'unrecognized_wager_type', blocking: false, race: number, wagerType: x.wagerType,
            message: `Race ${number}: unrecognized wager type "${x.wagerType}" - ignored.`,
          });
          continue;
        }
        race.exotics.push({
          betType: parsed.betType,
          baseCents: parsed.baseCents,
          combination: stripComboAnnotation(x.winningNumbers),
          payoutCents: centsFromDollars(x.payoff),
        });
      }
    }
  }

  const races = [...byRace.values()].sort((a, b) => a.number - b.number);
  for (const race of races) {
    if (!race.finalTime) {
      warnings.push({
        type: 'no_final_time', blocking: false, race: race.number,
        message: `Race ${race.number}: no final time was captured for this race.`,
      });
    }
    if (!race.results.some((r) => r.winCents != null)) {
      warnings.push({
        type: 'no_win_payout', blocking: false, race: race.number,
        message: `Race ${race.number}: no win payout found among the finishers.`,
      });
    }

    const known = entriesByRace[race.number];
    if (Array.isArray(known)) {
      const finisherPgms = new Set(race.results.map((r) => r.programNumber).filter((p) => p != null));
      for (const entry of known) {
        if (entry.programNumber != null && !finisherPgms.has(entry.programNumber)) {
          race.scratches.push({ programNumber: entry.programNumber, horseName: entry.horseName ?? null });
        }
      }
    }
  }
  if (races.length === 0) {
    warnings.push({ type: 'no_races', blocking: true, message: 'No races could be built from this file.' });
  }

  return { track, date, races, warnings };
}

// WIRED TO A REAL SAVE PATH (D195/D196, `docs/requirements/
// apify-equibase-ingest.md`). `result_charts.source_kind`'s CHECK constraint
// (migration 033) now admits `'equibase_apify'`. There is deliberately NO
// `toPayload`-style adapter export here, unlike the entries side: this
// parser's output already matches `saveResults`'s own `p` shape exactly (no
// reshaping was ever the blocker, only the schema was - see this file's own
// header), and results ingestion has no parser registry to satisfy an
// adapter-interface contract for (`chart-parser.js` doesn't export one
// either). `server/equibase-apify-results.js`'s preview route calls
// `parseApifyResultsDataset` directly and attaches `sourceKind:
// 'equibase_apify'` inline, the same shape every other results preview
// route already uses.
