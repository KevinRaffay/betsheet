# Apify Equibase ingestion: entries + results, minimum friction

**Status: PARTIALLY SCHEDULED.** Reconciled 2026-09-09 against an
externally-drafted scope doc (`apify-equibase-ingest-scope.md`, written
without repo access) and against this repo's own same-day prior art (D188-
D193). **Phase 1 is delivered as D195, Phase 2 as D196, Phase 3 as D197** -
both parsers can now genuinely save data, and BetSheet can now call
Apify's own API on demand. Phases 4-5 (CLI scripts, further verification)
remain not scheduled; deliverable IDs get claimed when picked up.
**Explicitly out of scope, per user instruction**: scheduling, backfilling,
backtesting, and anything touching the `legacy` branch (the D43/D44 PDF
backfill pipeline for DMR-2026-summer etc.). **User framing that governs
every decision below**: the stored corpus is a sandbox and is obsolete -
schema changes fail forward rather than band-aiding around it, and the goal
is the entries -> results workflow with the least friction, not the most
cautious path.

## The incoming scope doc's premise was already half-obsolete

It was drafted without the repo checked out (its own §5 says so), the same
day this repo built and merged D190/D192 (`equibase-apify-parseforge.js`,
two real entries-mode samples) and D193 (`equibase-apify-results.js`, one
real results-mode sample). What follows is a reconciliation, not a fresh
plan - most of the incoming doc's §5 "archaeology gate" and §2 actor
comparison are answered by code and real data that already exists.

### 1. Actor choice: stay on `parseforge/equibase-scraper`, not `getascraper`

The incoming doc recommends `getascraper` from a **vendor comparison table**,
reasoning about shape-fit in the abstract. This repo has since built the
opposite evidence: **three real captured samples, all from `parseforge/
equibase-scraper`**, each with a working, golden-diffed parser -
`equibase-apify-parseforge.js` (two real entries-mode shapes, one with
`rowType`/`trackCode`/`isScratched`/`medication`, one leaner capture without
any of them) and `equibase-apify-results.js` (one real results-mode sample,
`rowType: 'result'`). Real, load-bearing bugs were found and fixed against
this actor specifically (the `morningLineDecimal` European-odds trap;
scratch inference from a missing program number). **Zero samples of
`getascraper`'s actual output exist anywhere in this repo** - the incoming
doc's own table entries for it are vendor claims, not verified fields, and
this codebase has an explicit standing rule against building an adapter
without a captured real sample (the reason no accessibility-tree entries
adapter was ever built, per `multi-parser-entries-ingest.md` finding 7).
Switching actors now would mean discarding three verified integrations to
chase an unverified one. **Recommendation: parseforge stays the actor.**
Revisit only if a real `getascraper` sample is obtained and its shape is
checked the same way.

The incoming doc's own "up to 3 API calls" mapping (§3: entries, results,
optional combined-backfill) is independently corroborated by what's already
been captured: real entries-mode and real results-mode samples both exist,
matching `resultType: entries | results`. The third mode (`horses` -
pedigree/connections/profile data) has no real sample and no consumer
anywhere in this codebase's prompt/card/grading paths - **out of scope**,
matching the "minimum friction for entries/results" goal stated by the user.

### 2. The real gap isn't parsing - it's that nothing can save yet

Both parsers already produce correct output against real data. Both refuse
to save, **on purpose**:

- `equibase-apify-parseforge.js`'s `toPayload` throws unconditionally -
  `race_days.entries_source`'s CHECK constraint (migration 024) allows only
  `'program' | 'ml_sheet' | 'both' | 'equibase_html'`.
- `equibase-apify-results.js`'s `apifyResultsToPayload` throws
  unconditionally - `result_charts.source_kind`'s CHECK constraint
  (migration 010) allows only `'equibase_paste' | 'equibase_pdf' |
  'dmtc_html'`.

**A second, worse bug sits right beside the first one**: `server/
ingest.js`'s `ENTRIES_SOURCES` array is a SECOND, independent gate, and an
unlisted value is **silently coerced to `'program'`** rather than refused
(`server/ingest.js:131-132` - the exact danger the parsers' own throws exist
to prevent, previously flagged as "finding 8" and never fixed). This must be
fixed to an explicit refusal in the same pass that adds the Apify value,
not left as a live foot-gun beside a hardened one.

**Given the user's own framing - the corpus is a disposable sandbox** - the
usual caution CLAUDE.md gives `race_days` rebuilds (verify against a
`VACUUM INTO` copy of the *real* corpus) is a should-do-well, not a
should-be-terrified-of. The rebuild pattern itself already preserves
existing rows (migration 010's own CASE-mapped copy is the template); the
corpus being disposable means there's no reason to slow-walk this further.

The incoming doc's §4.6 open question ("does a source/provenance column
already exist?") is already answered: yes, both do, and this is exactly the
gap.

### 3. Orchestration actively refuses the Apify path today

`scripts/pull-race-day.js` hard-exits if the run's default parser's
`sourceKind` isn't `'html'`, and fails any per-track override the same way
(`pull-race-day.js:103-106`, `:225-228`). So even once `toPayload` is wired,
the existing batch/pull tooling still can't reach it without changes.

**There is no results-side CLI or batch path at all.** `saveResults` is
called from exactly one place in the whole repo: the UI's paste/PDF preview
-> confirm route. Building the results half of "minimum friction" is not an
extension of an existing script - it's new.

### 4. Bucket/source classification - already correct, nothing to add

The incoming doc's §4.6 is right that this is a data source, not a picker
bucket, and needs no new bucket. Confirmed: no bucket/`consensus_completeness`
change is implied by anything here.

### 5. Live Apify API calls - resolved, with a real invariant consequence

The incoming doc's §4.1/4.2 (`shared/apifyClient.js`, `apify-client` SDK, an
`APIFY_TOKEN`, BetSheet's own code triggering actor runs on demand) is a
genuine reversal of this codebase's manual-file-only posture - every
existing ingestion path, without exception, takes a file a person already
has, and invariant 6's own text ("no automated fetch, ever") was reaffirmed
for a similar-looking question hours before this doc was written (M-2,
`pull-race-day.js`: the user chose "no live fetching, ever - files only"
when asked whether the tool should resolve which tracks are racing
automatically). **Asked directly, and decided**: BetSheet calls Apify's API
directly, on demand, no scheduling - the user's stated goal (minimum
friction) outweighs the manual-file consistency this time, and Apify calling
Equibase is a materially different thing from BetSheet calling Equibase
directly (invariant 6's own stated reason is Equibase's bot protection,
which this path never touches). **This is a second, deliberate, documented
exception to invariant 6**, the same way the mobile static-Pages surface got
one (CLAUDE.md's opening section) - implementation must add a matching note
there, not leave the exception implicit. **No scheduling of any kind** - a
cron, a recurring task, or an automatic day-of re-fetch are all explicitly
out of scope; every call is a person running a command right now.

## What this doc does NOT cover, on instruction

Scheduling (a cron, a recurring re-fetch, "day-of refresh"), backfilling or
backtesting of any kind, and anything that would touch or coordinate with
the `legacy` branch's D43/D44 PDF backfill pipeline (DMR-2026-summer /
2025-summer / 2025-fall). The incoming doc's own open question 3 ("does this
replace or run alongside the legacy backfill pipeline?") is therefore
explicitly not decided here - out of scope, not merely deferred.

---

## Coding plan

**Phase 1 - schema: real provenance values, fail forward. DELIVERED AS D195.**
Migration 033 (`-- betsheet:schema-rebuild`) adds `'equibase_apify'` to both
`race_days.entries_source` and `result_charts.source_kind` in one file - both
rebuilds, both adding the identical value for the identical reason, neither
depending on the other. `server/ingest.js`'s `ENTRIES_SOURCES` gate is fixed
in the same pass: hoisted to module scope (exported, so `insertRaceDay` and
the `/race-days` route's own validation share one list rather than two that
could drift), and changed from silently coercing an unlisted value to
`'program'` to refusing it - an omitted value still defaults to `'program'`
(every pre-D115 ingest path relies on that), but a present, unrecognized one
now throws from `insertRaceDay` (matching `getParser`'s own "refuse and name
every valid option" idiom) and gets a clean 400 from the `/race-days` route's
existing `problems`-array validation, rather than an uncaught 500 - no new
error class needed, matching this file's own style. **Verified against a
freshly-migrated temp database**, not a `VACUUM INTO` of "the real corpus" -
no live corpus file exists in this environment, and per the user's own
framing the corpus is disposable, so the usual extra caution CLAUDE.md
reserves for a `race_days` rebuild is appropriately relaxed to the standard
check-suite discipline rather than skipped. `npm run check-schema` gained
four new assertions (both new CHECK values accepted, both tables' invalid-
value refusal still holds); the full regression sweep (`check-ingest`,
`check-equibase-entries`, `check-equibase-apify-parseforge`,
`check-equibase-apify-results`, `check-entries-zip`, `check-grading`,
`check-module-bindings`, `build`) is green. **A pre-existing, unrelated
failure was found and isolated, not fixed**: `check-pl` has 4 failures
(an LLM-card scenario in its own test setup) that reproduce identically
against the pre-Phase-1 baseline (confirmed via a stashed before/after
run) - not caused by this migration, out of scope for it, flagged
separately.

**Phase 2 - wire the two already-verified parsers to real saves. DELIVERED
AS D196.** `apifyParseforgeToPayload` stops throwing and produces
`insertRaceDay`'s payload with `entriesSource: 'equibase_apify'` (mirroring
`equibaseHtmlToPayload`'s existing shape) - since `parse()`'s output already
matches `insertRaceDay`'s consumed shape field-for-field, the function is
now a two-line wrapper adding only what `parse()` cannot supply itself
(provenance, capture time), not a reshaping adapter.

**One planned piece turned out to be unnecessary once built, and was cut
rather than kept for symmetry**: the plan called for `apifyResultsToPayload`
to "stop throwing and return `saveResults`'s own `p` shape directly." Once
building the real route, that function had no work left to do - `parse()`'s
output already matches `saveResults`'s shape with nothing to add (unlike
the entries side, which needs `entriesSource`/`oddsCapturedAt` bolted on).
`chart-parser.js` doesn't export a `toPayload` either, for the same reason.
Keeping a pass-through function around anyway would have been dead
indirection - it was deleted rather than kept.

A new day-scoped preview route, `server/equibase-apify-results.js`
(`POST /race-days/:id/results-apify/preview`), wraps
`equibase-apify-results.js` and builds `context.entriesByRace` from the
day's already-saved entries in one query. Unlike the plan's original
"preview/confirm route pair," **no new confirm/save route was built** - the
existing `POST /race-days/:id/results` route already accepts exactly the
preview response's shape (the same way chart/dmtc results already work:
preview once, confirm by re-sending the same shape to the existing save
route), so a second save endpoint would have duplicated it for no reason.

**Found and fixed the identical finding-8-class bug on the results side,
not just the entries side.** `server/results.js`'s `SOURCE_KINDS` map had
the exact same silent-fallback shape `ENTRIES_SOURCES` had before Phase 1:
an unrecognized `sourceKind` silently became `'equibase_paste'` rather than
being refused - and simply adding `equibase_apify` to the map without
fixing this would have left a live version of the bug Phase 1 had just
closed on the other table. Fixed identically: a `resolveSourceKind` helper,
an omitted value still defaults to `'equibase_paste'`, a present-but-
unrecognized one throws (and the HTTP route 400s it).

Neither parser's own `parse()` function changed - both are still exactly
the golden-verified functions from D190/D192/D193.

**VERIFIED**: a new `scripts/check-apify-equibase-ingest.js` boots the real
server and runs the full entries -> results flow over HTTP using the two
real fixtures - which happen to be the SAME real day (Del Mar, 2026-09-07),
the first time this codebase has had a genuinely matched real entries+
results pair to wire end to end rather than seed synthetically. Confirms:
the day saves with `entries_source = 'equibase_apify'`; a bogus
`entriesSource` is refused 400 (Phase 1's fix exercised for real, not just
unit-tested); the results preview derives exactly the 4 real scratches in
race 11 (horses with a real program number in the saved entries that don't
appear among that race's finishers - genuinely absent from the file, not a
synthetic case); race 1 (no scratches) derives none; the confirmed preview
saves through the existing, unmodified `/results` route; `result_charts`
records `source_kind = 'equibase_apify'`; a bogus `sourceKind` is refused
400; the day-lifecycle guards (404 on an unknown day, 400 on missing data)
hold. `npm run check-equibase-apify-parseforge` and
`check-equibase-apify-results` both updated (the dead `toPayload`-throw
tests replaced with real-wiring assertions) and green; the full regression
sweep (`check-schema`, `check-ingest`, `check-grading`,
`check-dmtc-results`, `check-charts`, `check-equibase-entries`,
`check-compare-parsers`, `check-module-bindings`, `build`) is green.

**Phase 3 - live Apify client, on-demand only. DELIVERED AS D197.**
`server/apifyClient.js`: a thin singleton wrapping `apify-client`,
initialized from `process.env.APIFY_TOKEN`, failing fast with a clear error
if unset (mirroring `server/anthropic-client.js`'s own pattern exactly)
rather than surfacing an opaque 401 later.

**Corrected on two points once actually built, neither cosmetic.**

1. **File location: `server/`, not `shared/apifyClient.js`/
   `shared/apifyEquibase.js` as originally planned.** The incoming scope
   doc's guessed paths put these under `shared/`, and that plan was carried
   into this doc's own Phase 3 description unchecked. `shared/` is this
   codebase's browser-safe zone - every file under it holds itself to "no
   `node:` import, ever," because the client build reaches it. A file
   holding an Apify API token has no more business there than
   `anthropic-client.js` does, and that file has always lived under
   `server/` for exactly this reason. Caught before merging, not after.

2. **The real input schema, read from the actor's own live Store page
   (2026-09-09) rather than assumed from the incoming scope doc's guessed
   names.** The doc's §3 used `dataMode`/`trackCodes`, which are a
   DIFFERENT actor's parameter names (the comparison table's own jungle_
   synthesizer/getascraper row) mis-attributed to parseforge. The real
   parseforge schema: `resultType` ('entries'|'results'|'horses'), `tracks`
   (not `trackCodes`), `date` (not `raceDate` - `fetchEntries`/
   `fetchResults` keep `raceDate` as their OWN external parameter name,
   translating to the actor's `date` internally, since every real fixture
   and every parser in this codebase already calls the field `raceDate`).
   **One load-bearing finding this reading surfaced that the plan never
   anticipated**: exotic payoffs are an OPT-IN, separately-billed field on
   this actor (`includeWagers`, off by default) - every real results sample
   this codebase's parser was built and verified against necessarily had it
   turned on, so `fetchResults` defaults `includeWagers: true`, overriding
   the actor's own default. Left at the actor's default, a live pull would
   have come back with every race silently missing exotic payoffs - not a
   parser gap, a caller bug, and one this codebase's own grading depends on.

`server/apifyEquibase.js`: `fetchEntries({raceDate, tracks, ...rest})` /
`fetchResults({raceDate, tracks, includeWagers = true, ...rest})`, each
calling the actor with the matching `resultType` and returning the run's
raw dataset items - no reshaping inside this file, kept a thin swappable
actor-calling layer per the incoming doc's own §4.2 reasoning (still
correct advice, independent of which actor or its real parameter names).
Documented filters (`raceNumbers`, `surfaces`, `onlyStakes`, `maxItems`, ...)
pass through via `...rest` rather than being named individually, so a
caller can use any of them without this file needing to know about it. A
non-`SUCCEEDED` run (`FAILED`/`ABORTED`/`TIMED-OUT`) throws, naming the run
id and status, rather than returning an empty dataset silently.

The existing parse functions take a raw JSON STRING and call `JSON.parse`
internally; `fetchEntries`/`fetchResults` return the actor's raw dataset
items (an array), and the CALLER `JSON.stringify`s them back into that
exact string contract before handing them to
`parseApifyParseforgeDataset`/`parseApifyResultsDataset` unchanged -
preserves both functions' golden-tested contract exactly, at the cost of
one redundant stringify/parse round-trip, the safer trade against touching
verified code.

**A related, previously-flagged gap corrected with newly-verified
evidence, in the same pass**: `shared/parsers/registry.js`'s
`equibase-apify-parseforge` entry carried a placeholder `costModel`
because "the prior evaluation's dollar figures are not verifiable
anywhere in this repository" (`multi-parser-entries-ingest.md`, finding
5). Reading the actor's own live Store page for its real input schema
also surfaced its real, current, published pricing - now recorded there
instead of an empty placeholder, sourced and dated. This independently
CONFIRMS the prior evaluation's own cited figure ($0.675 for a default
full card) was accurate all along; it does not retroactively make that
evaluation citable as fact going forward - this page is the source now,
not the memory of a prior session's claim.

**VERIFIED, never with a real billed call**: a real Apify run costs real
money and belongs to a person running a CLI script (Phase 4, not yet
built), never a check script. New `scripts/check-apify-equibase-client.js`
verifies `hasToken()`/`getApifyClient()`'s fail-fast behavior, and injects
a fake client (matching `apify-client`'s own `actor(id).call(input)` /
`dataset(id).listItems()` shape) through the one seam `runActor()` exists
to provide - confirming the real actor id is called, `raceDate`/`tracks`
map to `date`/`tracks` correctly, an omitted `tracks` defaults to `[]`
(every track racing that day) rather than `undefined`, `includeWagers`
defaults to `true` but is overridable, arbitrary filters pass through via
`...rest`, and a non-`SUCCEEDED` run throws naming the run id and status.
Also proves the round trip this file exists for: a fake live-fetched item,
`JSON.stringify`'d back through the real, golden-verified parsers,
produces the identical parse a real file-based fixture would.

**Phase 4 - CLI scripts, one for entries and one for results.**
A new script (not a `pull-race-day.js` retrofit - that script's design is
built around scanning a `--dir` of already-saved files, a fundamentally
different input model from a live API call) takes `--date` and optional
`--tracks`, calls `fetchEntries`, parses, previews, and on confirmation
saves through the now-unblocked `toPayload` path - one command in place of
"run the actor externally, download a file, run a separate ingest command."
A sibling for results does the same against `fetchResults`, additionally
loading the day's already-saved `entries` (per the resolved scratch-
derivation design: entries are always ingested first) to build
`context.entriesByRace` before calling `parseApifyResultsDataset`. Both
follow this repo's preview-then-confirm discipline (invariant 9) even
though the trigger is a CLI, not a UI - a `--yes` flag confirms, its absence
prints the preview and warnings and saves nothing, matching D43's own
policy-A shape rather than inventing a new confirmation convention.

**Phase 5 - verification.**
`scripts/check-apify-equibase-ingest.js`, temp-DB convention (matching
`check-ingest.js`/`check-equibase-otr.js`): parses the three existing real
fixtures through the now-real `toPayload` path (no live API call in the
check - the fixtures already exist and are frozen), verifies `insertRaceDay`
/ `saveResults` accept the `equibase_apify` provenance value, round-trips a
read-back, and asserts the entries-then-results scratch-derivation sequence
end to end (save entries, save results, confirm the right program numbers
land in `result_scratches`). The live API wrapper functions
(`fetchEntries`/`fetchResults`) are verified by mocking the Apify client
boundary, never by making a real billed call from a check script.

## Decisions the operator owns (not resolved here)

1. `APIFY_TOKEN` budget/rate expectations, and where the token lives
   (`.env`, gitignored, matching every other secret in this codebase) -
   the incoming doc's own open question 1, unresolved by this doc since it's
   an account/billing decision, not a code one.
2. Whether Apify ever becomes the DEFAULT entries source, or stays an
   equal, opt-in option alongside the HTML parser - explicitly NOT decided
   by this phase. The existing M-3/M-4/M-5 comparison-harness discipline
   ("no auto-switching the default parser under any condition") already
   governs this and is untouched by adding a live-fetch trigger.
