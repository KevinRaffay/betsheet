# Multi-parser, multi-track/day entries ingestion

**Status: SPECIFIED, NOT SCHEDULED.** No deliverable IDs are claimed here —
they get claimed when the work is picked up, not before. Filed 2026-09-09
from an externally-drafted scope. **The internal `D1`–`D5` labels the
incoming scope used are renamed `M-1`–`M-5` below** — this repo's own
convention (see `docs/requirements/card-source-model.md`'s `S-1..S-3`) is
that a requirements doc never mints something that reads like a real
deliverable ID before the work is picked up, precisely so a stray `D1` here
is never confused with an actual ledger row.

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

---

## Suggested shape, renumbered from the incoming scope

**M-1** (was D1) — parser registry + `--parser` flag on
`batch-import-equibase-entries.js`. Registry module `shared/parsers/
registry.js` exporting `{ id -> { module, label, isDefault, sourceKind,
costModel } }`, `equibase-html` (today's `equibase-entries.js`, `isDefault:
true`) as the sole real entry until an a11y-tree adapter is built and
verified per finding 7. Unknown `--parser` value is a hard error naming valid
ids, never a silent fallback to default (mirrors finding 8's own lesson).
**Done when**: the existing Del Mar HTML fixture runs through
`--parser equibase-html` unchanged, and the report JSON names the parser
used.

**M-2** (was D2) — `pull-race-day.js` orchestration + `ingest_runs` ledger.
Resolves which tracks race on a date from Equibase's entries index page,
pulls each independently through its own parser + fetch method, and never
lets one track's failure abort the run — matching the non-fatal philosophy
`batch-import-equibase-entries.js` already applies per-file. **This
orchestration layer is itself a new outbound fetch** (the index page, plus
whatever each per-track source needs) that invariant 6 does not currently
have a home for: every existing ingest path in this codebase takes a file a
person already saved, and `server/source-audit.js`'s own note is that
"nothing in this codebase fetches anything automatically any more... because
there is no fetcher to need [robots.txt/timeout/UA guards]." If M-2
introduces the first automated fetch since D113 deleted the crawler, it
inherits invariant 6's stated fallback rule in full — robots.txt checked
before every request, manual paste as the fallback for a resisting source —
and that guard needs to be built, not assumed absent because nothing nearby
has one today.

**M-3** (was D3) — parser comparison, against the HTML parser as baseline
(never symmetric peer comparison), on the same "label everything, conclude
nothing until n is stated" discipline `docs/decisions/
2026-09-05-simulator-pivot.md` already states for this codebase. Depends on
M-1 (≥2 registered parsers) and M-2's `ingest_runs` ledger.

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
2. **Does M-2's per-track, per-day auto-discovery fetch belong in this
   local-only, invariant-6 app at all**, or should "which tracks are racing
   today" stay a manually-supplied `--tracks` list forever, keeping the
   whole scope inside the existing "a person handed BetSheet a file" posture?
   The scope's own `--tracks` flag already makes the manual-list path
   available; the open question is only whether the auto-discovery default
   should exist, given it is the one piece of this scope that doesn't fit
   any ingest path in the codebase today.
3. **Where do Apify credentials live** if M-4's `cost_source: "apify_api"`
   path is ever exercised — this doc, like the incoming scope, treats that
   as its own small prerequisite task, not something to improvise here.

## What this doc does not cover

Same exclusions the incoming scope stated: no live Apify wiring beyond the
flag M-4 defines, no odds re-pulls near post time, no UI for parser
provenance or cost (M-5 is data-model only), no auto-switching the default
parser under any condition, and no retroactive re-parsing of already-
ingested days.
