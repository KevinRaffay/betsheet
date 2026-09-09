# Equibase results ingest via Apify

**Status: PARTIALLY SCHEDULED.** Finding A's scratch-derivation question is
RESOLVED (2026-09-09, user decision: assume scratched) - see below. The
parser itself (`shared/parsers/equibase-apify-results.js`) is delivered as
**D193** (D192 is a different, unrelated deliverable that claimed that ID
concurrently the same day - see DELIVERABLES.md), built and verified
standalone against the real sample. Wiring a
save path and finding E's `result_charts.source_kind` migration remain NOT
SCHEDULED - deliberately, per finding E's own recommendation. Filed
2026-09-09 from a real sample the
user supplied directly (`dataset_equibase-scraper_2026-09-09_18-11-18-089.json`,
Del Mar 2026-09-07, 106 finisher rows across 11 races - never fetched by this
codebase, invariant 6 untouched). **Identified by field shape, not filename**:
an earlier file from the same `equibase-scraper` export naming convention,
supplied the same session, turned out to carry only race-conditions/horse/
program-number fields with no finish order or payoffs at all - an entries
extraction, not results, despite being asked about as "results data." This
file is different: every row carries `rowType: "result"`, `finishPosition`,
and payoff fields. Do not assume the naming convention alone identifies what
a future export of this kind contains; check the fields.

## Purpose

Results ingestion today has exactly one source of record: pasted or
PDF-extracted Equibase chart text, through `shared/chart-parser.js`
(invariant 6 - no scripted fetching, ever). This scope adds a second results
source, read the same manual-upload way every source in this codebase is: a
JSON export from an Apify actor in the same family already registered on the
entries side (`equibase-apify-parseforge`, D190). Unlike the entries side,
results ingestion has no pluggable-parser registry to extend - `server/
results.js`'s `saveResults` just takes whichever shape a preview endpoint
produced. This scope is about producing that shape from this new source, not
about building a second registry.

## What was checked

**1. Full field inventory, confirmed by grepping every one of the 106 rows,
not sampling.** Every row carries: `trackCode, trackName, country, raceDate,
raceNumber, raceType, isStakes, isClaiming, purse, distance, distanceYards,
surface, trackCondition, postTime, finalTime, conditions, ageRestriction,
sexRestriction, rowType, finishPosition, horse, resultUrl, scrapedAt,
programNumber, horseUrl, horseRefNumber`. `winPayoff`/`placePayoff`/
`showPayoff`/`exoticWagers` appear only on the payout-eligible rows (win on
the winner, place on the top two, show on the top three, `exoticWagers` once
per race, attached to the winner's row - confirmed programmatically across
all 11 races: exactly one row per race carries it).

**2. Compared field-by-field against what `saveResults` (`server/
results.js:36`) actually persists**, not against everything `shared/
chart-parser.js` happens to also extract. `race_results` takes
`{programNumber, horseName, finishPosition, winCents, placeCents,
showCents}` per finisher; `exotic_payoffs` takes `{betType, baseCents,
combination, payoutCents}`; `result_scratches` takes `{programNumber?,
horseName}`. Chart-parser also extracts jockey, weight and win odds per
finisher, but **none of those are persisted columns** - so their absence
from this file is not a gap against what the database needs, only against
what the chart parser happens to also carry.

**3. Payout convention checked against `shared/chart-parser.js`'s own
`money()`.** `winPayoff`/`placePayoff`/`showPayoff` are plain decimal
dollars-per-$2 mutuel prices (e.g. `11.4`), the same convention `money()`
already normalizes with a bare `× 100`. No unit-mismatch trap like D190
found on the entries side (`morningLineDecimal` there was European decimal
odds, a different convention entirely) - this source's payout figures use
the same convention this codebase already assumes.

**4. `trackCode` ("DMR") is Equibase's own track id** - the exact key
`shared/track-codes.js`'s registry is keyed on - available directly, where
the chart parser has to derive a track from a free-text header line instead
(`cleanTrack`, stripping stray logo glyphs).

## Findings

**A. No scratch data of any kind - the one finding that can silently corrupt
a grade.** `shared/grading.js`'s refund policy (documented at the top of the
file) runs entirely off a `scratchedPgms` set passed in per race; a horse
that never finished and is never named as a scratch is indistinguishable,
from this source alone, from a horse that never existed. Fed to `saveResults`
as-is, a ticket on a horse this source doesn't mention would grade as a plain
`loss`, not the `refund` invariant 1's own worked example requires (win money
on a longshot that never ran is a refund, not a loss).

**RESOLVED 2026-09-09 (user decision): assume scratched.** Any program number
present in the day's saved `entries` for a race but absent from this source's
finisher list for that race is treated as scratched - there is no
"unaccounted for, not scratched" state. This is safe specifically **because
entries are always ingested before results** for every race day this
codebase handles (invariant of the workflow itself, not just this source):
the diff has a real, already-saved entries list to run against, never a
guess. This does NOT need a database at parse time - the pure parser takes
the day's known entry program numbers per race as a `context` input (the
caller already has them, from whichever entries path populated the day) and
computes each race's `scratchedPgms` as `entries minus finishers`, the same
way `context.trackCode` already lets a caller supply what the source itself
can't. A day whose entries were never ingested is out of scope for this
source - it cannot run standalone, by design.

**B. `finalTime` is absent for exactly 2 of the day's 11 races** (races 3 and
7 - checked: every row in each of those two races lacks the field, not a
partial or random gap within them). `finalTime` is not a persisted
`race_results` column and nothing grades on it, so this is informational
rather than a blocker - but a future adapter should report it as a
per-race warning rather than silently rendering a blank, the same
`fieldsNotProvided` discipline `equibase-apify-parseforge.js` already
follows for its own source's structural gaps.

**C. Exotic combination annotations need the same stripping logic
chart-parser already has.** A `winningNumbers` value like
`"12-4-4-1/2/5/6/8 (4 correct)"` carries a trailing `(N correct)` annotation
the same way raw chart text does; `parseExotic`'s existing regex for this is
directly reusable rather than needing a second implementation.

**D. `wagerType` strings need normalizing against the existing `BET_TYPES`
map**, e.g. `"$1 Exacta"` -> base `100` cents + type `exacta`, `"$0.50 Pick
3"` -> base `50` cents + type `pick3`. This is a strictly easier parse than
the chart's own, since base/type/combination/payout already arrive as four
separate fields instead of one line to split positionally at the first `$`.

**E. `result_charts.source_kind` is CHECK-constrained and has no value for
this source** (`server/migrations/010-result-sources.sql:15` - `CHECK
(source_kind IN ('equibase_paste', 'equibase_pdf', 'dmtc_html'))`) -
**the exact same class of gap D190 found on the entries side**
(`entries_source`'s CHECK constraint has no Apify value either). Unlike
`race_days`, `result_charts` is not CLAUDE.md's named riskiest-rebuild table,
but adding a value is still a schema-rebuild migration (a CHECK cannot be
ALTERed; migration 010 itself already rebuilt this exact table once for the
same reason). Per D190's own precedent, a parser for this source should be
built and verified standalone first, with its save-side adapter refusing
outright (the same deliberate throw `equibase-apify-parseforge.js`'s
`toPayload` uses) until the migration is a separate, deliberate decision -
never smuggled in as a side effect of "just wiring up a new source."

## Suggested shape

A new pure parser, `shared/parsers/equibase-apify-results.js`, following
`equibase-apify-parseforge.js`'s conventions (browser-safe, never throws,
`context.trackCode`/date selection with a named refusal on ambiguity - the
one real sample is already single-track/single-day, so this is precautionary
rather than exercised), producing `{track, date, races}` in `saveResults`'s
own shape rather than inventing a new one. Per finding A's resolution, the
parser takes the day's known entry program numbers per race as a `context`
input and derives `scratchedPgms` itself (`entries minus finishers`) -
stays pure, no database access, the caller (which already loaded the day's
entries to build the request) supplies the one thing the source itself
can't provide. A new preview route (e.g. `POST /api/parse/results-apify-json`)
would return the
same preview shape the paste/PDF/dmtc paths already return, keeping
invariant 9 (preview first, confirm to save) intact; `saveResults` itself
needs no change beyond `SOURCE_KINDS` gaining an entry once finding E's
migration exists.

## Decisions the operator owns

1. **RESOLVED 2026-09-09**: assume scratched. A program number in the day's
   entries but absent from this source's finishers is scratched, no other
   state exists - safe because entries are always ingested before results,
   never a guess. The parser takes the entries program numbers as a
   `context` input and derives `scratchedPgms` itself, keeping the "no DB
   access" contract every `shared/parsers/*` file holds (`context.trackCode`
   already established the same pattern: the caller supplies what the
   source can't).
2. **When does the `result_charts.source_kind` migration happen?** Finding E
   means this parser can be built and verified with `toPayload`-style refusal
   before any save path exists, the same order D190 followed for entries.
   Building the parser and deciding to extend the schema are two separate
   deliverables unless there's a reason to combine them.
3. **Is a second real sample worth getting before building?** One sample
   (11 races, one day, one track) confirms the shape but not its edges - a
   dead heat, a race with no exotic wagers taken, a stakes race with a
   different payoff-tier count. The entries-side parser (D190) shipped
   against one sample too and found its bugs from careful reading rather
   than a second file, so this isn't a hard blocker - just a call about how
   much confidence one sample buys before real ingestion depends on it.

## What this doc does not cover

No live Apify wiring, no automated re-fetch of results after a race, no UI
for a results source picker (results ingestion still auto-detects by
whichever preview endpoint was called, matching every existing source), and
no retroactive re-parsing of already-saved results.
