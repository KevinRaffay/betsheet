# Multi-parser, multi-track/day entries ingestion

**Status: PARTIALLY SCHEDULED.** M-1 is delivered as **D188** (`shared/
parsers/registry.js` + `--parser` on the batch harness). M-2 is delivered as
**D189** (`scripts/pull-race-day.js`) — **with no live fetching at all**, a
user decision made explicitly before building it (2026-09-09): see finding 9
below. **M-3 was ON HOLD, and now has what it was waiting for**: **D190**
(2026-09-09) registered a real second parser, `equibase-apify-parseforge`
(finding 10 below) — the user supplied a real Apify dataset export directly
and asked for a parser built against it. **M-3's dependency is now met, but
M-3 ITSELF IS STILL NOT SCHEDULED** - registering a second parser was its own
deliverable, picked up because a real sample existed to build against, not
an implicit decision to also build the comparison harness. M-4 and M-5
remain specified but not scheduled. No deliverable ID is claimed for M-3
through M-5 until each is separately picked up. Filed 2026-09-09 from an
externally-drafted scope.
**The internal `D1`–`D5` labels the incoming scope used are renamed
`M-1`–`M-5` below** — this repo's own convention (see `docs/requirements/
card-source-model.md`'s `S-1..S-3`) is that a requirements doc never mints
something that reads like a real deliverable ID before the work is picked
up, precisely so a stray `D1` here is never confused with an actual ledger
row.

## Purpose

Entries ingestion today hardcodes one parser
(`shared/parsers/equibase-entries.js`, HTML/view-source) called once per
track/day (`scripts/batch-import-equibase-entries.js <directory>`). This
scope makes the parser a pluggable, per-run choice; adds orchestration for
pulling a full day's slate across however many tracks are racing; and adds
the accounting to eventually decide, with evidence, whether a challenger
parser should replace the HTML one as default. The HTML parser stays default
for all real ingestion until a comparison process says otherwise — nothing
here changes that on its own.

---

## What was checked

**1. The proposed canonical payload shape already matches what
`insertRaceDay` consumes**, field for field. `server/ingest.js:126` reads
`payload.track`, `payload.date`, and per-race `number/postTime/distance/
surface/raceType/conditions/claimingPriceCents/wagerMenu`, and per-entry
`programNumber/postPosition/horseName/morningLine/morningLineDecimal/jockey/
trainer/weight/scratched/liveOdds/liveOddsDecimal/medication/ageSex/
claimPrice/alsoEligible` — exactly the shape the scope's adapter contract
describes. `parseEquibaseEntriesHtml` today returns `{ track, date,
printedDate, races, warnings }` (`shared/parsers/equibase-entries.js:482`) —
no `fieldsNotProvided`, no `droppedFields` as a distinct field from
`warnings`. Adding that distinction is genuinely new work, not something to
discover already half-built.

**2. No registry, no `--parser` flag, no `ingest_runs`/`parser_comparisons`/
`parser_costs` ledger and no Apify integration exist anywhere in this repo.**
Grepped `server/migrations/` and the whole tree for `ingest_runs`,
`parser_comparisons`, `parser_costs`, `jungle_synthesizer`, `parseforge`,
`getascraper`, and `apify` (any case) — zero hits outside this new doc. This
scope is being built from nothing, not extended from a partial start.

**3. `batch-import-equibase-entries.js` hardcodes the one parser and one
writer already, and is the right script to extend rather than replace.** It
already does temp-DB isolation, read-back verification, and per-file warning/
skip reporting (`scripts/batch-import-equibase-entries.js:1-60`) — M-1's
`--parser` flag is a small addition to an existing, working harness, not a
rewrite.

**4. The registry-of-adapters shape has a direct precedent in this
codebase**: `shared/track-codes.js` already keys a lookup table on an
external system's own id (Equibase's track id) so a new entry is "a registry
entry, never a call-site special case" (CLAUDE.md's own words for it). The
proposed `shared/parsers/registry.js` should follow that file's shape rather
than invent a new one — same file, same review muscle.

### Corrections to the incoming scope

**5. The "prior evaluation" this scope cites for the three Apify actors does
not exist in this repository, at all.** No file, commit, or doc mentions
`jungle_synthesizer`, `parseforge`, or `getascraper`, and the specific
figures the scope states as fact — `parseforge` costing "~$0.675–$0.891...
for one full card," `getascraper`'s "$4.60/1,000" advertised rate, "only
`parseforge` currently reports scratches, medication, and claiming price" —
are not independently checkable from anything in this checkout. They may be
accurate (they read like real numbers from a real trial run in a different
session), but per this codebase's own discipline ("written from run IDs
never from memory," CLAUDE.md's Findings section) they must not be repeated
as established fact until whoever ran that evaluation either commits its
output here or re-runs it once M-1's registry exists to hold the adapters
being evaluated. **M-3's baseline-parser assumption is unaffected** — it
compares against the HTML parser regardless of what the Apify actors turn
out to cost or cover.

**Partial correction, 2026-09-09 (D190):** the "only `parseforge` currently
reports scratches, medication, and claiming price" claim is now independently
CHECKABLE, not just cited - the user supplied a real `parseforge/
equibase-scraper` dataset export (identified from its own filename and
corroborated by content; see `equibase-apify-parseforge.js`'s header), and
that real sample does carry all three. This confirms one specific factual
claim from the uncommitted evaluation; it does NOT confirm the dollar
figures, which remain unverified and still must not be repeated as fact.

**6. The cited `D-scope-race-day-notes-entry.md` does not exist under that
name (or any name) in `docs/requirements/`.** The closest real analogue —
"compare different producers against the same fixed input before trusting a
single anecdotal run" — is what `docs/requirements/llm-baseline-inputs.md`
and the shipped D149 (LLM input capture) actually do, and what
`docs/decisions/2026-09-05-simulator-pivot.md` states as the pivot's general
rule ("label everything, conclude nothing until n is stated"). M-3 below
cites that decision doc instead.

**7. The `equibase-daily-entries` skill's exact accessibility-tree output
format was not verified against a real sample from this checkout** — the
skill isn't vendored into this repository, and no a11y-tree fixture exists
under `tests/fixtures/` the way the HTML parser's Del Mar sample does. M-1's
"done when" below is scoped to the HTML parser only for that reason; treat
the a11y-tree adapter's exact field-anchoring approach (horse-profile links,
`Jockey:`/`Trainer:`/`Age:`/`Post Position:` labels) as a starting hypothesis
to verify against a captured sample before writing its golden, the same way
`equibase-entries-ingest.md` rejected the print-to-PDF route only after
measuring a real file.

**8. `insertRaceDay`'s `ENTRIES_SOURCES` allowlist is a second, independent
gate that a new parser's provenance must clear.** `server/ingest.js:126-132`
coerces any `entriesSource` value missing from its hardcoded array
(`['program', 'ml_sheet', 'both', 'equibase_html']`) silently to `'program'`
— the exact silent-mislabeling failure mode CLAUDE.md's architecture map
already calls out for this file. M-1/M-5 must add each new parser's
provenance value to that array (and, if it needs its own `race_days` column
value distinct from `entries_source`, decide whether `source_parser_id`
(M-5) subsumes or duplicates `entries_source` — they answer overlapping
questions today and should not silently drift into two ways of saying "which
parser wrote this").

**9. M-2, read literally, asks for exactly what invariant 6 forbids.** The
incoming scope's `pull-race-day.js` "resolves which tracks are racing on a
given day" from "the Equibase entries index page's 'Today' column" and then
"pulls" each track "through whichever parser + fetch method that parser
needs." That is an automated fetch — of the index page at minimum, and of
each track's own page if a parser's "fetch method" means going and getting
it. This codebase's invariant 6 is unambiguous and repeated in CLAUDE.md's
Gotchas verbatim: *"Equibase blocks scripted fetching. Confirmed. Don't
retry cleverly; the paste/PDF path is the design, not a fallback."* D113
deleted every fetcher, HTTP client and robots.txt checker that existed for
this reason. **Asked before building, not decided unilaterally**: the user
chose "no live fetching — files only," matching every other ingest path's
manual-upload posture. `pull-race-day.js` therefore takes a `--dir` flag (not
in the incoming scope at all — it exists only because live fetching does
not) pointing at a directory of already-saved per-track pages, the same way
`batch-import-equibase-entries.js` already works; "which tracks are racing"
is answered by which files are present for the requested date, never a
network request. The `equibase-daily-entries` skill (browser automation, not
a scripted HTTP client — a person's own browser session, the same posture
every other manual-capture path in this codebase already has) remains the
way such a directory gets populated; this script does not populate one
itself.

**10. The second parser (D190) surfaced a real, load-bearing bug this scope
never anticipated: the source's OWN `morningLineDecimal` uses a DIFFERENT
convention than this codebase's `morningLineToDecimal`.** The real Apify
sample's row for a "7/5" morning line carries `morningLineDecimal: 2.4` —
European "decimal odds" (fraction + 1). `shared/betmath.js`'s
`morningLineToDecimal('7/5')` returns `1.4` — the fractional ratio ALONE,
which D171's own ledger entry already proved is this codebase's convention
("the fractional RATIO, `winPayout`'s `stake * (ml + 1)` proves it").
Trusting the source's own decimal field directly - the obvious, "free"
choice, since it looks like exactly the field this codebase wants - would
have silently double-counted the `+1` on every payout estimate and every
grade built from a card sourced this way, corrupting figures rather than
refusing anything. `equibase-apify-parseforge.js` always discards the
source's `morningLineDecimal` and recomputes from `morningLineOdds` through
the shared function instead. **This is exactly the class of finding
building a second real parser was for** — the incoming scope's own D3/M-3
goal ("accumulate evidence before ever changing the default") assumed the
risk was in FIELD COVERAGE (does the challenger have scratches, medication,
claiming price); this one was in a field BOTH parsers appear to provide,
disagreeing silently. A pure per-value diff (M-3, still not built) would
have caught this immediately once both parsers existed on the same race —
which is the strongest concrete case yet for eventually building M-3, not a
reason it needed to be built before this parser could be.

**11. The source scrapes multiple tracks into ONE file; the HTML parser's
contract assumes one file is always one track.** The real sample holds
Horseshoe Indianapolis and Kentucky Downs together. `parse(rawInput,
context)`'s `context` parameter (already part of the architecture decision
above, and already used by the HTML parser for optional track/date hints)
is what absorbs this: `context.trackCode` selects which track's rows to
extract, and the parser refuses - a blocking warning naming every track
actually present, never a silent pick - when the file holds more than one
track and no `trackCode` is given. **`batch-import-equibase-entries.js` and
`pull-race-day.js` do not call `parse()` with a `context` object today**,
and both already refuse a non-`html` `sourceKind` outright (`pull-race-day.js`)
or would simply never discover a `.json` file at all (`batch-import`'s file
search is `.html`/`.htm` only) - so this parser is real and independently
verified, but not yet reachable through either orchestration script.
Extending them to discover non-HTML files and pass a `trackCode` per file is
real, additional work this deliverable deliberately did not also do.

**12. `insertRaceDay`'s `entries_source` CHECK constraint has no value for
an Apify-sourced day, and adding one is a schema-rebuild migration against
`race_days` - the table CLAUDE.md itself calls the riskiest to rebuild.**
Finding 8 already named this gap; this parser makes it concrete rather than
hypothetical. `equibase-apify-parseforge.js`'s `toPayload` therefore THROWS
unconditionally rather than emitting a payload with an `entriesSource` value
the allowlist doesn't recognize, which `insertRaceDay` would otherwise
silently coerce to `'program'` (finding 8's exact danger) - a loud, certain
failure was chosen over a schema change scoped, and risked, without being
asked for. **This parser's `parse()` is real and fully verified against
real data; its `toPayload` is deliberately inert until that migration
exists** - which is M-5's scope, not this one's.

---

## Suggested shape, renumbered from the incoming scope

**M-1** (was D1) — *Delivered as D188.* Parser registry + `--parser` flag on
`batch-import-equibase-entries.js`. Registry module `shared/parsers/
registry.js` exporting `{ id -> { label, isDefault, sourceKind, costModel,
fieldsNotProvided, parse, toPayload } }`, `equibase-html` (today's
`equibase-entries.js`) as the sole real entry, `isDefault: true`. Unknown
`--parser` value is a hard error naming valid ids, never a silent fallback to
default (mirrors finding 8's own lesson). **Deliberately still only one real
entry** — finding 7 stands: no a11y-tree fixture exists to verify that
adapter against, so it was not built to pad this deliverable out. **Done
when**: the existing Del Mar HTML fixture runs through `--parser
equibase-html` unchanged, and the report JSON names the parser used. Both
confirmed — see DELIVERABLES.md D188.

**M-2** (was D2) — *Delivered as D189, with no live fetching (finding 9;
user decision 2026-09-09).* `scripts/pull-race-day.js <date> --dir
<directory> [--tracks CODE1,CODE2] [--parser id] [--per-track-parser
CODE=id,...] [--write-report path.json]`. Every file under `--dir` is
parsed to learn its own track and date; a file whose date doesn't match is
out of scope for that run, not an error. Omitting `--tracks` pulls every
track the directory holds for the requested date — the closest this
codebase can honestly get to "every track racing that day" without an
index-page fetch. One track's failure (no file found, a blocking warning, a
`--per-track-parser` id whose `sourceKind` isn't `html` — file discovery here
only scans HTML pages, since only one parser exists) never aborts the run.
Writes to a brand-new throwaway temp-directory SQLite database, same
SAFE-BY-CONSTRUCTION posture as `batch-import-equibase-entries.js`; a
lightweight read-back check (day + race count) catches a broken run.
`ingest_runs` is a JSON-lines ledger at `data/ingest_runs.jsonl` (gitignored,
local operational data), not a table — a table would live inside the
per-run throwaway DB and be deleted with it, defeating the entire point of
"the substrate M-3 and M-4 both read from," which needs to persist ACROSS
runs. **Done when**: `pull-race-day.js 2026-09-09` with no other flags pulls
every track the directory holds for that date through the default parser
and appends one `ingest_runs` row per track; `--tracks` limits the run to
named tracks, reporting a requested-but-absent one as `failed` rather than
silently omitting it. Both confirmed against the real 5-file fixture
directory — see DELIVERABLES.md D189.

**M-3** (was D3) — *ON HOLD, user decision 2026-09-09.* Parser comparison,
against the HTML parser as baseline (never symmetric peer comparison), on
the same "label everything, conclude nothing until n is stated" discipline
`docs/decisions/2026-09-05-simulator-pivot.md` already states for this
codebase. Depends on M-1 (≥2 registered parsers) and M-2's `ingest_runs`
ledger. **The dependency is not met**: M-1 deliberately registered exactly
one parser (finding 7 - no a11y-tree or Apify adapter has a verified sample
to build against), so there is nothing real for M-3 to compare against yet,
and the incoming scope's own done-when ("correctly identifies the known
getascraper name-spacing bug," "correctly lists claimingPrice/medication/
scratched as parseforge-only fields") cannot be satisfied without those
adapters existing. Asked before building anything (a comparison harness that
can only ever compare the baseline against itself would prove nothing);
the user chose to hold M-3 entirely rather than build unproven infrastructure
or a rushed second parser just to have something to diff against. **M-3
also inherits M-2's fetch question** - its own spec says it "fetches (or
reuses cached raw input for) the same track/date" - so whenever M-3 is
picked up, it needs a `--dir`-style input the same way `pull-race-day.js`
does, not a live request, unless a future decision says otherwise.
Revisit once a second parser is registered with a real, verified sample.

**M-4** (was D4) — cost tracking per `ingest_runs` row, real Apify-billed
amounts pulled from the actor's own run-details API rather than its
advertised rate (finding 5 is exactly why this matters here, not just for
`parseforge`). Depends on M-2's ledger.

**M-5** (was D5) — `source_parser_id` provenance column, backfilled
`equibase-html` for every existing row; resolve against finding 8 rather
than adding a fourth column that answers the same question `entries_source`
already does. Can land any time after M-1.

---

## Decisions the operator owns

1. **Is the "prior evaluation" real and where does its evidence live?** If
   it exists, it should be committed (or at minimum cited by a checkable
   URL/run id) before M-3/M-4 treat its numbers as a baseline rather than a
   fresh measurement — the exact discipline this file's own Findings section
   already enforces on every stored corpus figure.
2. **RESOLVED 2026-09-09**: no live fetching, ever — see finding 9 and
   M-2's delivered shape above. `pull-race-day.js` orchestrates over a
   `--dir` of already-saved files; "which tracks are racing" is answered by
   which files are present for the date, never a network request.
3. **Where do Apify credentials live** if M-4's `cost_source: "apify_api"`
   path is ever exercised — this doc, like the incoming scope, treats that
   as its own small prerequisite task, not something to improvise here.
4. **RESOLVED 2026-09-09**: M-3 is on hold until a second real parser is
   registered — see M-3's shape above. Asked before building an unproven
   comparison harness or rushing a second parser just to exercise it; the
   user chose to hold rather than either. Whichever parser gets registered
   next (a11y-tree, per finding 7, or an Apify actor, per decision #1 above)
   is what un-blocks M-3, not a separate decision of its own.

## What this doc does not cover

Same exclusions the incoming scope stated: no live Apify wiring beyond the
flag M-4 defines, no odds re-pulls near post time, no UI for parser
provenance or cost (M-5 is data-model only), no auto-switching the default
parser under any condition, and no retroactive re-parsing of already-
ingested days.
