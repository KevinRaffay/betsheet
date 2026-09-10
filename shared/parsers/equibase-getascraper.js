// The third registered entries parser (`shared/parsers/registry.js`), reading
// an Apify dataset export from the `getascraper/equibase-us-horse-racing-
// scraper` actor.
//
// WHY THIS SOURCE EXISTS ALONGSIDE parseforge: post times. Measured against
// the real fixtures, `parseforge` carries NO post time on any row - its own
// registry entry lists `postTime` under `fieldsNotProvided`, and all 11 races
// of `parseforge-dmr-2026-09-07.expected.json` come back `postTime: null`.
// `server/race-calendar.js` routes any race without a parseable post time into
// `unplaceable`, so every day ingested from parseforge is entirely INVISIBLE on
// the D209-D211 race-day calendar - not degraded, blank. This source prints one
// per race, which is the whole reason it was added.
//
// Pure and browser-safe (no `node:` import), matching every other parser under
// `shared/parsers/`. `JSON.parse` on malformed input throws inside a try/catch
// here and never escapes - the "never throws" contract every parser here holds.
//
// STRUCTURE: a flat array where entries and results are SEPARATE ROWS sharing a
// `raceId` - an entries row carries `entries` (a real array of horse objects)
// and `resultsAvailable: false`; a results row carries `finishOrder`/payouts and
// `entriesCount: 0`. That split is exactly the "entries in the morning, results
// at night" workflow (user, 2026-09-10). This parser reads the ENTRIES rows only
// and ignores results rows entirely - the results half of this source is NOT
// wired to anything, deliberately: its win/place/show payouts are the WINNER's
// three numbers alone (verified monotonic across all 22 races of two real
// captures; Del Mar R1 settles it - a 4/5 winner paid $2.80 win / $2.20 place
// while the 2nd-place horse was 12/1, and a 12/1 horse cannot place for $2.20).
// `shared/grading.js:66-67` returns `('loss', 0)` for a horse that finished in
// the money with no price on file, so ingesting them would record real winnings
// as losses in P/L - see DELIVERABLES.md D219 for the full reasoning.
//
// LOAD-BEARING, do not "simplify" away - TWO of them:
//
// 1. THE POST TIME'S TIMEZONE SUFFIX MUST BE STRIPPED. This source prints
//    "11:30 AM ET", and `postTimeMinutes` (shared/staleness.js) returns NULL for
//    that exact string - measured, not assumed. Stored verbatim, every race would
//    land in `unplaceable` and this parser would fail at the one job it was added
//    for, with a populated-looking `post_time` column hiding it. The suffix is
//    stripped to "11:30 AM", matching what the HTML parser already stores
//    ("1:30 PM"), and is CROSS-CHECKED against the track registry's own IANA zone
//    rather than discarded - a disagreement is a real signal (a track's zone is
//    wrong, or the row belongs to another track) and warns.
//
// 2. THERE IS NO `programNumber` FIELD, ANYWHERE. Only `postPosition`. The
//    program number is what `shared/grading.js` grades on, so one is DERIVED from
//    the post position and every derivation is named in one summary warning. This
//    is sound for an ordinary field - verified against this source's own results
//    rows, whose exotic `combination` values resolve exactly through post
//    position (exacta "1-7" -> the 1st and 2nd finishers, trifecta "1-7-6" ->
//    1st/2nd/3rd) - but it DIVERGES on coupled entries (1/1A) and field horses,
//    where several posts share one program number. No sample on file contains
//    either, so the warning is the honest way to carry that forward.
//
// fieldsNotProvided (declared on the registry entry, since the gap is structural
// to the SOURCE rather than to any one day): this source's entries rows carry no
// distance, surface, track condition, wager menu, conditions, medication, age/sex,
// claiming price, live odds, also-eligible status or scratch flag. `distance` and
// `surface` are a real REGRESSION against both existing entries parsers and are
// the price of the post times.

import { morningLineToDecimal } from '../betmath.js';
import { canonicalizeTrack } from '../track-codes.js';

const emptyResult = (warnings) => ({ track: null, date: null, races: [], warnings });

/** Collapse the runs of spaces this source prints inside names ("J   Thomas"). */
const squash = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() || null : null);

/**
 * "11:30 AM ET" -> { time: "11:30 AM", zoneAbbrev: "ET" }.
 * A bare "1:30 PM" keeps its whole value and reports no abbreviation.
 */
function splitPostTime(raw) {
  const s = squash(raw);
  if (!s) return { time: null, zoneAbbrev: null };
  const m = s.match(/^(.*?)\s+([A-Z]{2,4})$/);
  // AM/PM is a meridiem, not a zone. Without this guard a bare "11:30 AM" -
  // which is the shape both other parsers store - is read as time "11:30" plus
  // zone "AM", silently destroying the meridiem and misplacing the race by 12
  // hours. Found by testing, not by reading.
  if (!m || m[2] === 'AM' || m[2] === 'PM') return { time: s, zoneAbbrev: null };
  return { time: m[1].trim() || null, zoneAbbrev: m[2] };
}

/** "EDT"/"EST" both mean the Eastern zone for a cross-check's purposes. */
const zoneFamily = (abbrev) => (abbrev ? abbrev.replace(/^([A-Z])[SD](T)$/, '$1$2') : null);

/** The short zone name a real IANA zone shows on a given date, e.g. "EDT". */
function abbrevForZone(ianaZone, dateStr) {
  if (!ianaZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: ianaZone, timeZoneName: 'short' })
      .formatToParts(new Date(`${dateStr}T18:00:00.000Z`));
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * `rawInput` is the dataset export as a STRING (the same contract every other
 * Apify parser here takes, so a live caller `JSON.stringify`s the actor's items
 * straight back in). `context.trackCode` selects one track when the file holds
 * several; with more than one present and no code given, this refuses rather
 * than guessing which the caller meant.
 */
export function parseGetascraperDataset(rawInput, context = {}) {
  let rows;
  try {
    rows = JSON.parse(rawInput);
  } catch (err) {
    return emptyResult([{ type: 'invalid_json', blocking: true, message: String(err?.message ?? err) }]);
  }
  if (!Array.isArray(rows)) {
    return emptyResult([{
      type: 'not_an_array',
      blocking: true,
      message: 'This file is not a JSON array of rows - is this a getascraper/equibase-us-horse-racing-scraper dataset export?',
    }]);
  }

  // This actor emits more than one output shape depending on its run input. The
  // supported one is camelCase with a real `entries` ARRAY. An older shape uses
  // snake_case keys and packs entries into a single pipe-delimited STRING
  // ("1|Howie's Law (KY)|E Jaramillo|..."); it is REFUSED by name rather than
  // half-parsed, because silently reading one shape's fields out of the other is
  // how a whole card comes back plausible and wrong.
  const usable = rows.filter((r) => r && typeof r === 'object');
  if (usable.length && !usable.some((r) => r.raceNumber !== undefined)
    && usable.some((r) => r.race_number !== undefined)) {
    return emptyResult([{
      type: 'unsupported_output_shape',
      blocking: true,
      message: 'This is the actor\'s older snake_case output (entries packed into one pipe-delimited string). Re-run it in the mode that returns camelCase rows with an "entries" array.',
    }]);
  }

  const entryRows = usable.filter((r) => Array.isArray(r.entries) && r.entries.length > 0);
  if (entryRows.length === 0) {
    const resultsOnly = usable.some((r) => r.resultsAvailable === true);
    return emptyResult([{
      type: 'no_races',
      blocking: true,
      message: resultsOnly
        ? 'This file holds results rows only, with no entries on any race - pull the entries mode of this actor for a race day.'
        : 'No rows in this file carry an "entries" array.',
    }]);
  }

  const codeOf = (r) => r.trackCode ?? (r.trackName ? canonicalizeTrack(r.trackName).code : null);
  const tracksPresent = [...new Set(entryRows.map(codeOf).filter(Boolean))];
  let trackCode = context.trackCode ?? null;
  if (trackCode) {
    if (!tracksPresent.includes(trackCode)) {
      return emptyResult([{
        type: 'track_not_in_file',
        blocking: true,
        requested: trackCode,
        available: tracksPresent,
        message: `Track ${trackCode} is not present in this file. Tracks found: ${tracksPresent.join(', ') || '(none)'}.`,
      }]);
    }
  } else if (tracksPresent.length === 1) {
    [trackCode] = tracksPresent;
  } else {
    return emptyResult([{
      type: 'multiple_tracks_in_file',
      blocking: true,
      tracks: tracksPresent,
      message: `This file holds multiple tracks (${tracksPresent.join(', ')}) - specify which one before saving.`,
    }]);
  }

  const trackRows = entryRows.filter((r) => codeOf(r) === trackCode);
  const datesPresent = [...new Set(trackRows.map((r) => r.raceDate).filter(Boolean))];
  if (datesPresent.length === 0) {
    return emptyResult([{
      type: 'no_date',
      blocking: true,
      trackCode,
      message: `No race date found on any ${trackCode} row in this file.`,
    }]);
  }
  if (datesPresent.length > 1) {
    return emptyResult([{
      type: 'multiple_dates_in_file',
      blocking: true,
      dates: datesPresent,
      trackCode,
      message: `${trackCode} has rows for multiple dates in this file (${datesPresent.join(', ')}) - expected exactly one.`,
    }]);
  }
  const [date] = datesPresent;
  const track = squash(trackRows[0].trackName) || trackCode;
  const registryZone = canonicalizeTrack(track).timezone;

  const warnings = [];
  const byRace = new Map();
  const derivedPrograms = [];
  const zoneMismatches = [];

  for (const row of trackRows) {
    const number = row.raceNumber;
    if (!Number.isInteger(number)) {
      warnings.push({
        type: 'row_missing_race_number',
        blocking: false,
        message: `A row carrying ${row.entries.length} entr${row.entries.length === 1 ? 'y' : 'ies'} had no race number and was skipped.`,
      });
      continue;
    }
    if (byRace.has(number)) {
      warnings.push({
        type: 'duplicate_race_row',
        blocking: false,
        race: number,
        message: `Race ${number}: more than one entries row for this race - the first was kept.`,
      });
      continue;
    }

    const { time: postTime, zoneAbbrev } = splitPostTime(row.postTime);
    if (row.postTime && !postTime) {
      warnings.push({
        type: 'unparsed_post_time',
        blocking: false,
        race: number,
        raw: row.postTime,
        message: `Race ${number}: post time "${row.postTime}" could not be read, so this race will not appear on the calendar.`,
      });
    }
    // The printed suffix is dropped for storage (postTimeMinutes cannot read
    // it), so this is the only chance to notice it disagreeing with the zone the
    // calendar will actually use for this track.
    if (zoneAbbrev && registryZone) {
      const expected = zoneFamily(abbrevForZone(registryZone, date));
      if (expected && zoneFamily(zoneAbbrev) !== expected) {
        zoneMismatches.push({ race: number, printed: zoneAbbrev, expected });
      }
    }

    const race = {
      number,
      postTime,
      distance: null, // fieldsNotProvided
      surface: null, // fieldsNotProvided
      raceType: squash(row.raceType),
      wagerMenu: null, // fieldsNotProvided
      conditions: null, // fieldsNotProvided
      claimingPriceCents: null, // fieldsNotProvided
      entries: [],
    };

    for (const e of row.entries) {
      if (!e || typeof e !== 'object') continue;
      const horseName = squash(e.horseName);
      if (!horseName) {
        warnings.push({
          type: 'entry_missing_horse_name',
          blocking: false,
          race: number,
          message: `Race ${number}: an entry carried no horse name.`,
        });
      }

      // No programNumber exists on this source at any level - see the header.
      const postPosition = Number.isInteger(e.postPosition) ? e.postPosition : null;
      let programNumber = null;
      if (postPosition != null) {
        programNumber = String(postPosition);
        derivedPrograms.push(number);
      } else {
        warnings.push({
          type: 'entry_missing_post_position',
          blocking: false,
          race: number,
          horse: horseName,
          message: `Race ${number}: ${horseName ?? 'a horse'} has no post position, so it has no program number either.`,
        });
      }

      const morningLine = squash(e.morningLineOdds);
      const weight = Number.isFinite(e.weight) ? e.weight : null;
      if (weight != null && (weight < 80 || weight > 200)) {
        warnings.push({
          type: 'implausible_weight',
          blocking: false,
          race: number,
          horse: horseName,
          weight,
          message: `Race ${number}: ${horseName ?? 'a horse'} shows an implausible weight (${weight}).`,
        });
      }

      race.entries.push({
        programNumber,
        postPosition,
        horseName,
        morningLine,
        morningLineDecimal: morningLine ? morningLineToDecimal(morningLine) : null,
        jockey: squash(e.jockey),
        trainer: squash(e.trainer),
        weight,
        scratched: false, // fieldsNotProvided - this source lists live runners only
        liveOdds: null, // fieldsNotProvided
        liveOddsDecimal: null, // fieldsNotProvided
        medication: null, // fieldsNotProvided
        ageSex: null, // fieldsNotProvided
        claimPrice: null, // fieldsNotProvided
        alsoEligible: false, // fieldsNotProvided
      });
    }

    if (Number.isInteger(row.entriesCount) && row.entriesCount !== race.entries.length) {
      warnings.push({
        type: 'entries_count_mismatch',
        blocking: false,
        race: number,
        stated: row.entriesCount,
        found: race.entries.length,
        message: `Race ${number}: the row states ${row.entriesCount} entries but ${race.entries.length} were read.`,
      });
    }

    byRace.set(number, race);
  }

  const races = [...byRace.values()].sort((a, b) => a.number - b.number);
  if (races.length === 0) {
    warnings.push({ type: 'no_races', blocking: true, message: 'No races could be built from this file.' });
  }

  if (derivedPrograms.length) {
    const raceList = [...new Set(derivedPrograms)].sort((a, b) => a - b);
    warnings.push({
      type: 'program_number_derived_from_post_position',
      blocking: false,
      races: raceList,
      entries: derivedPrograms.length,
      message: `This source prints no program numbers, so one was derived from each horse's post position for all ${derivedPrograms.length} entries (races ${raceList.join(', ')}). That matches for an ordinary field but NOT for coupled entries (1/1A) or a field horse - check those against the program before betting them.`,
    });
  }

  if (zoneMismatches.length) {
    warnings.push({
      type: 'post_time_zone_mismatch',
      blocking: false,
      races: zoneMismatches,
      message: `Post times are printed in ${zoneMismatches[0].printed} but ${track} is registered as ${zoneMismatches[0].expected} (${zoneMismatches.length} race(s)). Times are stored as printed, so the calendar will place them in the registered zone - one of the two is wrong.`,
    });
  }

  const withoutPostTime = races.filter((r) => !r.postTime).map((r) => r.number);
  if (withoutPostTime.length) {
    warnings.push({
      type: 'races_without_post_time',
      blocking: false,
      races: withoutPostTime,
      message: `${withoutPostTime.length} race(s) have no post time (${withoutPostTime.join(', ')}) and will not appear on the race-day calendar.`,
    });
  }

  return { track, date, races, warnings };
}

/**
 * `parse()`'s output already matches `insertRaceDay`'s consumed shape
 * field-for-field, so this adds only the two facts the parse itself cannot know:
 * which provenance value this is, and when the capture was taken.
 */
export function getascraperToPayload(parsed, capturedAt) {
  return {
    track: parsed.track,
    date: parsed.date,
    entriesSource: 'equibase_getascraper',
    oddsCapturedAt: capturedAt,
    races: parsed.races,
  };
}
