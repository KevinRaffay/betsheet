# Apify Equibase ingestion: entries + results, minimum friction

**Status: SPECIFIED, NOT SCHEDULED.** Reconciled 2026-09-09 against an
externally-drafted scope doc (`apify-equibase-ingest-scope.md`, written
without repo access) and against this repo's own same-day prior art (D188-
D193). Deliverable IDs get claimed when a phase below is picked up.
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

**Phase 1 - schema: real provenance values, fail forward.**
Schema-rebuild migrations (CHECK constraints can't be ALTERed) adding
`'equibase_apify'` to both `race_days.entries_source` (migration 024's
successor) and `result_charts.source_kind` (migration 010's successor),
following migration 010's own rebuild-and-copy template. In the same pass,
fix `server/ingest.js`'s `ENTRIES_SOURCES` gate from silent-coercion-to-
`'program'` to an explicit 422 refusal naming the invalid value - the
`getParser(id)`-style "refuse and name every valid option" convention
already used elsewhere in this codebase, never applied here until now.
Verified against a `VACUUM INTO` copy of the corpus per the usual rebuild
discipline, without the extra caution the "real corpus" framing would
otherwise demand.

**Phase 2 - wire the two already-verified parsers to real saves.**
`apifyParseforgeToPayload` stops throwing and produces `insertRaceDay`'s
payload with `entriesSource: 'equibase_apify'` (mirroring
`equibaseHtmlToPayload`'s existing shape). `apifyResultsToPayload` stops
throwing and returns `saveResults`'s own `p` shape directly (it already
matches - no reshaping was ever the blocker, only the schema was). A new
results preview/confirm route pair, mirroring the OTR upload's
preview-then-confirm shape (invariant 9), wraps `equibase-apify-results.js`
+ `saveResults`. No change to either parser's own `parse()` function - both
are already golden-verified and untouched by this phase.

**Phase 3 - live Apify client, on-demand only.**
`shared/apifyClient.js`: a thin singleton wrapping `apify-client`,
initialized from `process.env.APIFY_TOKEN`, failing fast with a clear error
if unset rather than surfacing an opaque 401 later. `shared/apifyEquibase.js`:
`fetchEntries({raceDate, trackCodes})` / `fetchResults({raceDate,
trackCodes})`, each calling the actor with the matching `resultType` and
returning the run's raw dataset items - no reshaping inside this file, kept
a thin swappable actor-calling layer per the incoming doc's own §4.2
reasoning (still correct advice, independent of which actor). The
existing parse functions take a raw JSON string and call `JSON.parse`
internally; the live-fetch callers `JSON.stringify` the dataset items before
handing them to `parseApifyParseforgeDataset`/`parseApifyResultsDataset`
unchanged - preserves both functions' golden-tested contract exactly, at
the cost of one redundant stringify/parse round-trip, which is the safer
trade against touching verified code.

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
