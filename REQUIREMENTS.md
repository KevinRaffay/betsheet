# Requirements → deliverables

Every requirement maps to the deliverable ID(s) in
[DELIVERABLES.md](DELIVERABLES.md) that cover it, so coverage is traceable.
When a requirement's coverage changes (split PRs, resequencing), update this
map in the same PR.

> **Read the section banners first.** The 2026-09-05 simulator pivot retired
> whole sections of this map, and P-1 (D110-D113) has now executed those
> removals. A section marked **RETIRED** describes what the system used to do:
> the requirements were met, the code that met them is deleted, and the rows
> are kept because the stored corpus was produced under them and cannot be
> read without knowing what they were. Nothing marked RETIRED is a gap to be
> filled. The live map is the pivot section and the one after it.

## Platform & foundations

| Requirement | Deliverables |
| --- | --- |
| Same stack/architecture/styling/conventions as life-swipe | D01 |
| Desktop web primary platform; data-dense wide layouts | D01, D06, D11, D14, D16 |
| Local-only app, server binds loopback | D01 |
| SQLite storage; full schema (incl. Phase 2–4 tables) up front | D03 |
| Structured JSON logging, rolling/compressed/retained files, configurable | D02 |
| Correlation IDs across a card session's whole history | D02, D07, D10, D15, D22 |
| Delivery ledger + granular PR workflow | D01 (seeded), every PR (maintained) |

## Program ingest (workflow step 1)

**RETIRED except the first row (D113).** Del Mar program-PDF parsing, the
Bottom Line extraction and the ML-sheet merge are deleted. The pasted-entries
parser (D04) survives and is currently the only way to create a race day; it
retires when the Equibase entries HTML ingest is wired. The parse-preview rule
(invariant 9) is not retired at all - it binds every ingest path that remains.

| Requirement | Deliverables |
| --- | --- |
| Pasted entries text parsed per race/horse (all program fields) | D04 |
| Program PDF parsing: jumbled columns via post-position sequence, index validation | D05 |
| Handicapper analysis (e.g. DRF Bottom Line) → rankings + Best Bet flag | D05 (the pasted entries format carries no analysis section; the program PDF does) |
| Parse preview (read-only) confirmed before saving; corrections at the source + re-parse | D06, D14 |

## Consensus (workflow step 2)

**RETIRED IN FULL (D110, D112).** There is no consensus subsystem: no
fetchers, no registry, no classification, no picks parser, no consensus panel.
The last row is the exception and is *strengthened* rather than retired - "no
Equibase scraping" is now structural, because D113 left no HTTP client to
scrape with. Every stored `consensus_picks` row, and every UNANIMOUS / SPLIT /
CHAOS value on a historical race, stays readable; these rows are what they
mean.

| Requirement | Deliverables |
| --- | --- |
| Automated fetch on card creation; day-of re-fetch/refresh | D07 |
| Track picks page / At The Races / algorithmic sites fetchers with fixtures | D08c (built). D08a closed — the dmtc picks page is a directory; the track handicapper's picks are D05's Bottom Line extraction. D08b closed — ATR is bot-protected; entered via D07 manual paste, or (D69) a same-day "print to PDF" of ATR's racecard page uploaded and parsed for the whole day at once. **D110 removed the ATR path entirely** (simulator pivot); the captured data survives in the frozen archive |
| Track+date verification; discard mismatches | D07 |
| Manual paste/upload fallback into the same consensus structure | D07 |
| Fetch audit log; failed/stale sources visible in UI | D02, D07, D53 (every attempt auditable from the log alone: url, status, sitemap, candidate slug, entries scanned, nearest slug; a discovery miss is `not_published`, never a failure) |
| Missing consensus never blocks generation; per-race source labeling | D09, D10, D11 |
| Consensus table; UNANIMOUS/SPLIT/CHAOS classification; source-count cap | D09; D74 (verified no 2-source cap exists - classifyDay already counts every contributing source; with 3+ external sources UNANIMOUS still means all agree by default, CHAOS means no PAIR agrees rather than "3+ distinct picks" - the two read identically for every input reachable before a 3rd external source existed, so no prior day is reclassified; a per-race `agreement` count is now stored; a `CLASSIFY_UNANIMOUS='majority'` config exists for comparison but is off by default and flipping it is an `ENGINE_VERSION`-bumping engine change, not a side effect of a source landing) |
| Contrarian flags (algo fading favorite; corroborated longshots) | D09; D74 (a box-only algorithmic source with no ranked order - Equibase OTR's 4-horse exacta box - fades the favorite when it's absent from the box entirely, a "partial order" variant of the ranked rule; corroborated_longshot already counted any source's pick generically, so OTR's needed no code change) |
| No Equibase scraping; robots.txt respected, back off resistant sources | D07 (framework rule), D12/D13 (results via paste/PDF) |

## Card generation (workflow step 3)

**RETIRED IN FULL (D111).** The lean engine is deleted. Nothing generates a
card from rules any more - the three producers that remain (Equibase OTR
upload, LLM generation, human entry) each take tickets as given. These rows
describe how every `lean-*` card in the corpus was built, which is why they are
kept rather than deleted, and they are the reasons a future generator would
have to honour invariants 1, 2 and 5.

| Requirement | Deliverables |
| --- | --- |
| Confidence-based allocation (heavy UNANIMOUS/thesis, min on debut races, mid on CHAOS) | D10 |
| Cut hedges keep stacks; fade favorite price; longshots on top; mid-price coverage | D10 |
| MANDATORY place-money rule (win ≥8-1 carries matching place) | D10 |
| Parlays / daily doubles / Pick 3s costed against budget | D10 |
| Track wager menu + minimums respected | D10 |
| Allocations sum exactly to bankroll; warn (not block) on overrun | D10, D11 |
| Full decision trace for every card, shipped with the engine | D10 (schema: D02; export: D17) |
| Known-failure-mode warnings encoded on the sheet | D10, D11 |
| 2+-source flagged horses get small coverage even in lean mode | D10 |
| An LLM can generate a card manually, race by race, from entries and already-fetched consensus (no search); stored in its own LLM_GENERATED bucket, compared against lean and human via the existing standing/P&L machinery, never pooled | D63 |
| An LLM card's generation calls record what they CONSUMED (rendered prompt, raw response, notes, model, sampling params, prompt template id/version), not just what they produced - so two differently-noted generations of the same race day (e.g. cards 180/181) can be diffed and reproduced, and a regeneration under a new correlation id is traced (`race_regenerated`) rather than only reconstructable by diffing `ticket_added` timestamps against the final ticket set. Exported at `card-trace-export` schemaVersion 3 as a top-level `llmInputs` block, `null` for a non-LLM card or one that predates this capture; a `--omit-llm-inputs`/`?omitLlmInputs=1` form keeps only hashes/chars for sharing | D149 |

## Card presentation (workflow step 4)

| Requirement | Deliverables |
| --- | --- |
| Desktop card view: per-race bet tables, teller-call column, est. payouts | D11 |
| Race headers (class, allocation, thesis, trackside adjustment triggers) | D11 |
| Footer: totals, sources used/unavailable, scratches, responsible-gambling line | D11 |
| PDF export, landscape | D21 |
| here.now publish: self-contained HTML, anon/permanent modes, QR/copy, re-publish, audit log | D22 |
| Mobile at-track view: teller calls large/bold, check-offs, scratches, actual stakes | D23 |

## Backtesting with historical data (addendum)

**RETIRED (D111, D113).** The simulator, the strategy templates and the batch
backfill runner are deleted. Bucket isolation (invariant 13) is NOT retired: it
still governs every P/L and Distributions aggregate, now across HUMAN,
LLM_GENERATED and EQB_OTR.

| Requirement | Deliverables |
| --- | --- |
| Every card records consensus_completeness (FULL / PARTIAL / PROGRAM_ONLY) from sources actually used | D25 (schema, migration 003), D10 (computed + written at generation) |
| All P/L, simulation and distribution reporting buckets by completeness; program-only backfill never pools with full-consensus in one aggregate | D16, D19, D20 (rule: invariant 12) |
| Wayback Machine fetcher (web.archive.org) retrieves archived versions of each consensus source for historical dates; outcomes audited like any source | D08d (on the D07 framework) |
| Simulator evaluates structure-layer rules (place-money, hedge cuts, exotic construction, allocation curves) independently of race classification, so historical cards benchmark bet construction even without signal data | D18 (layer split), D19 (evaluation), D48 (the templates that fire on PROGRAM_ONLY days), D49 (exotic construction isolated: split box vs mid-price straight exacta) |
| Equibase's Off to the Races sheet ingests as a picker with its printed tickets verbatim, in its own EQB_OTR bucket, manual upload only (no Equibase fetch), archived and re-parseable | D71, D72 (upload panel, batch CLI, extraction fix verified against the full archive), D74 (...and feeds D09 classification, contrarian flags and the LLM generator as a third, independent algorithmic consensus source - show pick top, win pick second, its two unranked box mentions a new `also` pick type; `--consensus-only` backfills the source onto the 16 already-archived days without new picker cards) |

## Results, grading & simulation (workflow step 5)

| Requirement | Deliverables |
| --- | --- |
| Equibase chart parsing: pasted text; WPS + all exotic payoffs, scratches, "Also ran" | D12 |
| Chart PDF ingestion | D13 |
| Results ingest UI linked to the card's race day | D14 |
| Grade every ticket (all bet types, exotics, parlays, scratch/refund rules) | D15 |
| P/L per-race, per-day, running; compare sheet variants | D16 |
| Strategy templates as reusable rules | D18 |
| Simulate templates across all stored cards with real payoffs | D19; D51 (compare per meet, vs-lean deltas, paired day counts) |
| Distributions: % losing days, max drawdown, single-ticket dependence (>80%) | D20 |
| Decision traces joined with graded results, exportable for LLM analysis | D17 |
| Discipline tracker (planned vs. actual, house-money warnings) | D24 (schema in D03) |
| A human's pasted tickets become a first-class card (same tables, same grader), in a `HUMAN` completeness bucket that never pools with an engine bucket; no card generation or grading change | D54 |
| A human can play any stored day blind, race by race, and is compared against lean on the same day; blindness (pre-commit / sequential / non-blind) is recorded from timestamps and never pooled | D54, D55 |

## Backtest hygiene (addendum 2, 2026-09-02)

**SUPERSEDED, not simply retired (2026-09-05 pivot).** Pre-registration
relaxed from "a hypothesis before any engine change" to **"label everything,
conclude nothing until n is stated"**. The old rule guarded an engine that no
longer exists; the new one guards the analyzer replacing it. The findings
convention and its files stand as history - see
[docs/findings/README.md](docs/findings/README.md).

| Requirement | Deliverables |
| --- | --- |
| Every card records the engine version that built it; regeneration is append-only and graded results are immutable per (card, engine_version) - improvement is measured by comparing versions (invariant 14) | D34 (schema, recipe, trace, P/L version filter), D28 (append-only generation), every engine PR (bumps the version) |
| P/L buckets never pool across engine versions unless the user explicitly chooses all versions | D34 |
| Canonical track codes: every ingest path normalizes the track at save; the one-day-per-track+date rule and the chart mismatch refusal key on the code | D35 |
| Allocation integrity: a race's tickets land on its allocation - mandatory place money is carved out of the allocation, never added on top; the balancer's remainder is spread, never parked | D36 (carve-out), D30 (remainder spread) |
| Every race in every program fixture parses a well-formed distance; an unparsed distance is a preview warning, never `?` | D37, D32 (grammar) |
| The card footer lists program-time AND chart scratches after grading, labeled by source | D38 |
| Effective wagered (wagered − refunds) and effective ROI reported beside nominal at card, day and bucket level; refunds visible | D39 |
| Historical simulation can apply chart scratches before generation (at-the-window baseline), both modes reported | D50 (the D19 run option; compare groups by template AND mode, never pooled) |
| Single-ticket dependence reported gross and net; the flag driven by net | D20 |
| Structure-layer findings are recorded per engine version with run IDs before any engine change is proposed: one file per (engine version, bucket, corpus) under docs/findings/, both scratch modes, all meets and per meet, paired day counts, what is not concluded, the next corpus's question; never edited after the version is superseded | D52 (the first: lean-1.1 / PROGRAM_ONLY / DMR 2025-2026), CLAUDE.md "Findings" |

## Morning-line sheet (addendum 3, 2026-09-02)

**RETIRED IN FULL (D113).** The ML-sheet parser, its fetcher and the
program/ML merge are deleted, and the ODDS_ONLY completeness tier is
unreachable - it was decided by the engine's own `completeness_decided` event.
Stored ODDS_ONLY cards still report; nothing new can enter the tier.

| Requirement | Deliverables |
| --- | --- |
| The track's ML/changes PDF parses into the entries structure and is the entries source of record; the program PDF is analysis-only and cross-validated against it, the sheet winning every disagreement with a warning | D40 |
| Ingest accepts the ML sheet alone (ODDS_ONLY completeness, below PROGRAM_ONLY), the program alone, or both (preferred) | D40 |
| The ML sheet is fetched from the track at its predictable URL when robots allow, audited like every fetch; past dates feed backfill | D40 (on the D07 framework) |

## Historical backfill (addendum 4, 2026-09-01)

**RETIRED IN FULL (D111, D113).** The dmtc.com crawler, the raw archive, the
meet-dates probe, the batch runner and the Backfill queue are all deleted. The
corpus they produced is frozen in `archive/` (D107) and its per-meet reports
remain in `docs/backfill/` as the record of how it was built.

| Requirement | Deliverables |
| --- | --- |
| Backfill from the track's own archive: calendar-indexed, robots-respecting, polite, conditional requests, raw artifacts archived with a manifest; parsers run from the archive, never the network | D41 (on the D07 framework) |
| Results from the track's results page as a second results source of record, cross-validated against Equibase charts: identical returned cents per ticket from either source | D42, D15 (grader) |
| Batch ingestion policy A: a day saves automatically only with zero blocking warnings; anything blocking goes to a review queue in the UI - the documented batch exception to invariant 9 | D43 |
| Per-meet fixtures and golden checkpoints: the runner halts at each meet's first race day until its golden is audited | D43 (the D32 pattern) |
| `meet` on race_days (DMR-<year>-summer / -fall), with P/L and distribution grouping by meet | D43 (schema + runner), D16 / D20 (grouping), D51 (simulation compare by meet) |
| Every backfilled card carries the engine version it was generated under; D34 precedes any backfill run | D34, D43 |
| The corpus itself is a deliverable: one row per meet, with preconditions, acceptance, a committed report (docs/backfill/<meet>.md), and the golden + queue decisions recorded | D44, D45, D46 |
| No later meet starts until the earlier meet's report is reviewed (D44 -> D45 -> D46) | D44, D45, D46 |
| Index source, in order: the track calendar when it carries race counts; else a committed meet-dates table built once by a bounded, audited probe of the publicly published meet window. Blind enumeration outside a published window is prohibited. Without a calendar count, sheet + program + results must agree on the race count (blocking) | D47 (D41 + D43 rule) |

## The pivot to simulator + analyzer (2026-09-05)

BetSheet's direction changed on 2026-09-05: it becomes a betting simulator and strategy
analyzer rather than a consensus card generator. The decision, what was verified before
taking it, and the sequencing it requires are recorded in
[docs/decisions/2026-09-05-simulator-pivot.md](docs/decisions/2026-09-05-simulator-pivot.md).
**Requirements above that describe consensus fetching, classification or engine card
generation are superseded by it** and will be marked retired as each removal lands.

| Requirement | Deliverables |
| --- | --- |
| Ingest a race day cheaply for any track from Equibase entries HTML | D104 (parser); wiring not scheduled |
| Capture cards from OTR / LLM / HUMAN with clean labels and grade them against uploaded results | - (not scheduled) |
| Analyze graded cards by source, model, human source label, track, bet type, race type, field size and cross-card agreement, never printing a P&L figure without its `n` | - (not scheduled) |
| Archive the corpus and prove the grader reproduces archived summaries BEFORE any removal or reset | D107 (archive), D108 (fixtures), D120 (the grader proof - 9/9 summaries and 386/386 per-ticket outcomes) |
| A retired LLM model stops being offered but keeps its label, so cards already generated under it stay correctly displayed | D105 |

## Manual entries ingest, no automated feed (addendum 5, 2026-09-05)

Full specification, with the verified page structure and the rejected PDF route:
[docs/requirements/equibase-entries-ingest.md](docs/requirements/equibase-entries-ingest.md).
Specified but NOT scheduled - deliverable IDs get claimed when the work is picked up.

| Requirement | Deliverables |
| --- | --- |
| Generate a live card at a track with no automated entries feed (first target Kentucky Downs) from a manually saved copy of Equibase's entries page | - (not scheduled) |
| The parser takes an HTML STRING and never fetches - invariant 6 stands, Equibase is never scraped; the same manual-upload posture as D69 (ATR racecard) and D71 (OTR sheet) | - (not scheduled) |
| Parsed against Equibase's page template rather than one track, so a new track on the same template needs no code - untested until a second track's page is parsed | - (not scheduled) |
| Live odds preferred over morning line when present, M/L as fallback; both stored, neither overwriting the other; one `odds_captured_at` for the whole card. NOTE the reference capture has live odds empty in all 116 rows, so only the fallback path is exercised by it | - (not scheduled) |
| Entry columns are mapped from each race's own header row, never a fixed index - a claiming race carries an extra `Claim $` column (12 columns, not 11) | - (not scheduled) |
| Scratched horses retained and flagged, excluded from the active count, detected by row SHAPE (a scratch row carries 6 cells, not 11) | - (not scheduled) |
| Entries land through the day-creation path, so one upload populates every race for the LLM modal, ticket builder, card sheet and Replay alike | - (not scheduled) |
| Warnings-first read-only preview before anything is written (invariant 9), as every other ingest path does | - (not scheduled) |
| Per-card `track` + `entries_source = EQB_MANUAL_UPLOAD` for grading-dashboard hygiene, so these cards never blend into the Del Mar engine corpus (invariant 13) | - (not scheduled) |
| Per-race staleness shown as "entries as of X, post Y", non-blocking | - (not scheduled) |
| The PDF route is rejected on evidence, not preference: the sample print-to-PDF has no text layer at all (zero embedded fonts; pdftotext 14 bytes; pdfjs 0 chars) | - (rejected) |

## Card source model (pivot Phase 3, scoped 2026-09-06)

Full specification, with what checking it against the code and the live 108-card corpus
found: [docs/requirements/card-source-model.md](docs/requirements/card-source-model.md).
Specified but NOT scheduled - deliverable IDs get claimed when the work is picked up.

| Requirement | Deliverables |
| --- | --- |
| Every card carries a source (OTR / LLM / HUMAN) visible in every list and dashboard view - DERIVED from `engine_version`, never a fourth stored column, because `engine_version`, `template` and `consensus_completeness` already agree 1:1 on it across all 108 stored cards | - (not scheduled) |
| A card created without naming its completeness bucket is REFUSED, not silently filed as `PROGRAM_ONLY` - the column's current default is a retired engine bucket nothing can legitimately enter | - (not scheduled) |
| A HUMAN card records WHOSE picks it holds (`source_label` from a seeded vocabulary, free text kept separately in `source_label_other` so grouping stays clean), frozen at creation the way `llm_model` is | - (not scheduled) |
| Several HUMAN cards coexist on one race day, each an independent bankroll grading and reporting separately - the database already allows this (day 27 has two); the constraint is a UI resume rule | - (not scheduled) |
| Blindness is `null` for a card that is not the operator's own picks, and for one that is it derives from the DAY's reveals rather than from card ordering - the current "not the first human card of the day" rule reads three side-by-side labelled cards as NON_BLIND, which is false | - (not scheduled) |
| `llm_model` recorded for every LLM card; 2 of 12 stored cards predate the column, one exactly recoverable from its request rows and one only by inference | - (not scheduled) |

## A day's entries as one zip upload (requested 2026-09-06)

Full specification, with the blocker it must not be built on top of:
[docs/requirements/zip-entries-upload.md](docs/requirements/zip-entries-upload.md).
Specified but NOT scheduled - deliverable IDs get claimed when the work is picked up.

| Requirement | Deliverables |
| --- | --- |
| One upload creates every race day for a date, from a zip of saved Equibase entries pages - so a full board is ready without ~20 manual uploads | - (not scheduled) |
| **Prerequisite**: re-ingesting a race day that already carries cards must not silently destroy them. Replace today hard-deletes the day, and cards/tickets/human_race_state/llm_card_requests cascade with it - proven on a scratch database | - (not scheduled) |
| The zip is read server-side from a raw `application/zip` body: a day's raw HTML is 15-17MB against a 10mb JSON body limit, while the zip is ~2MB - the same raw-body convention D69/D71 chose over multipart | - (not scheduled) |
| The zip reader is bounded against decompression bombs (entry count, per-entry and total decompressed bytes, enforced during inflation) and refuses what it cannot support - encrypted, zip64, unknown method - rather than importing part of an archive | - (not scheduled) |
| Nothing from the archive is ever written to disk, so path traversal ("zip slip") stays structurally impossible rather than guarded against | - (not scheduled) |
| Warnings-first read-only preview of every day in the zip before anything is written (invariant 9), then batch save under D43's policy A - zero blocking warnings saves, anything blocking is left for review | - (not scheduled) |
| A capture that is not an entries page - the race-card index, or an Equibase bot-challenge or error page an automated collector will sometimes catch - is named as such, never reported as "no races" (the D121 pattern) | - (not scheduled) |
| Invariant 6 is untouched: BetSheet still receives only a file it was handed and has no HTTP client: how the zip was produced is outside it | - (not scheduled) |
| Each day keeps its own `odds_captured_at` from its zip entry's timestamp, rather than one time for the whole upload, since D117's staleness indicator reads that field | - (not scheduled) |

## Static Pages target: build HUMAN cards at the track (requested 2026-09-07)

A build-only deploy of a **card construction surface** - not an instance of the
application. Workflow: create the race day at home -> generate OTR/LLM cards at
home -> build the payload and deploy -> build HUMAN cards on a phone at the
track -> carry the export files home -> import, upload results, grade.

**This is the one deliberate exception to "benchmark first, bet later"** (user
decision 2026-09-07, recorded in CLAUDE.md's opening rule): it is a Phase 4
mobile surface built ahead of the sequencing, allowed because it only ADDS
HUMAN cards to the corpus and nothing in Phases 1-3 depends on it.

| Requirement | Deliverables |
| --- | --- |
| One race day leaves home as a self-contained JSON payload - identity, per-race entries, morning lines, wager menus - with no Equibase HTML and no parser input of any kind, so parsing stays a home-side job | D150 |
| A payload built twice from an unchanged race day hashes identically, so the home side can later prove the entries a ticket was built against have not moved | D150 |
| The day's OTR and LLM cards can optionally ride along, kept behind an explicit reveal, and revealing STAMPS the card being built - a HUMAN card built while reading the LLM card is not an independent source, and the stamp turns that contamination into labelled data rather than an unknown | D150 (payload + `sawReferenceCards`), D151 (the reveal), D153 (`cards.saw_reference_cards`) |
| A ticket builder in the browser with the desktop's ticket types and validation - achieved by REUSING the desktop components and the shared parser, not by mirroring them, so the two cannot drift | D151 |
| No server, no SQLite in the browser, no network call to Equibase, no LLM or OTR generation, no grading - and the generation exclusion is proven against the BUILT bundle rather than asserted | D151 (structural exclusion + `check-static-app`), D154 (the same check as a deploy gate) |
| A partially built card survives a hard refresh mid-build with every ticket intact | D151 |
| Storage that cannot keep a card refuses to start rather than accepting work into a store that evaporates; a refused durable-storage grant is visible, never silent | D151 |
| An `unexported` count is always on screen, with a warning on leaving the page while it is non-zero | D151 |
| Export and restore are a PAIR: a full browser data wipe followed by a restore-from-file recovers every completed card | D152 |
| Card ids are namespaced per device, so two phones building the same day never collide | D152 (minting), D153 (`cards.external_id`) |
| A rolling backup fires after every completed race, which is free because import dedupes by card id | D152, D153 |
| Restoring a file for a different race day is refused with a reason naming both days | D152 |
| The same export file imported three times produces one set of cards - keyed on card id, reporting "already present" rather than duplicating into the graded corpus | D153 |
| Import refuses, each failure naming the specific check: a card that is not HUMAN, an unknown or soft-deleted race day, a payload hash that no longer reproduces, and ticket text that will not re-parse | D153 |
| Imported cards merge into the ordinary HUMAN bucket - `builtOn` is recorded as fact and nothing buckets on it, so provenance stays answerable without splitting the corpus | D153 |
| Invariant 9 survives the machine boundary: the home import re-parses the ticket text itself and refuses on any blocking warning, never trusting the device's own parse | D153 |
| Invariant 15 survives it too: the device's real lock times are what `human_race_state` records, so a genuinely pre-committed day still computes as PRE_COMMIT | D153 |
| Deploy is per race day - publishing a new payload replaces the deployed one - over hash routing, so no SPA 404 fallback is needed | D154 (pipeline), D151 (hash routing) |
| The app loads and a card can be built fully offline after one online visit, and a redeployed race day is never served stale from cache | D155 |
| **Deferred, not built**: a scoped write-capable PAT in the browser committing cards to a branch. A write token on a phone carried around a racetrack is a materially different security posture than a page that can touch nothing | - (deferred by the spec) |
| **Out of scope by the spec**: any read path against the corpus, consensus classification, chart parsing, automatic sync home, and authentication of any kind | - (non-goals) |
| **Dropped from scope, user decision 2026-09-07**: a named source per HUMAN card (`emubets`/`drf`/`keeneland-tipsheet`). Archaeology found no such field exists - it is unscheduled requirement P-3.2 under "Card source model" above, and the only label a card carries is `cards.name` (D137) | - (see Card source model, P-3.2) |

## TIPSHEET screenshot extraction (requested 2026-09-08)

Scope doc: `Scope: TIPSHEET Screenshot Extraction`. Extraction only - the picks a
third-party handicapping app publishes, read off a screenshot into structured rows.
Nothing here stakes money, builds a ticket or grades anything.

| requirement | deliverable |
| --- | --- |
| A screenshot of a third-party tip app becomes a structured, ranked pick list in a new `TIPSHEET` bucket, isolated from OTR/HUMAN/LLM and never pooled without an explicit choice | D166 |
| `tip_picks` carries a ranked `picks` array separate from any eventual ticket, and has NO completeness field - odds are optional, not a completeness signal, and scoring for this bucket is rank-based | D166 |
| Odds are captured in the fraction-string format `morningLineToDecimal` reads (so a tote-printed `9-2` becomes `9/2`), and are OMITTED rather than guessed when the screenshot does not show them | D166 |
| Absence of odds is a normal tipsheet, never an extraction failure; a broken ranking IS a failure, because rank is the only signal this bucket has | D166 |
| The model's unedited response and a hash of the image are kept, so a misread horse number is diagnosable later without re-running a paid call against an image that may be gone | D166 |
| `source_label` is read from the visible UI chrome when possible, falling back to a passed-in hint, and normalized for grouping without refusing an app nobody has met yet | D166 |
| Extraction never writes - persisting is a separate explicit call, so a future preview surface can show exactly what a save would store (invariant 9's shape) | D166 |
| Verification runs against a throwaway SQLite DB and prints extracted picks for eyeball comparison against the source image | D166 |
| **Out of scope by the spec**: staking/ticket construction from extracted picks (`shared/tipStaking.js`), any UI, grading, resolving D09, and auto-writing into the real corpus | - (later deliverables) |
| **Answered by archaeology, nothing to build**: extending the `source_label` enum with `trackmaster`/`numberfire`. No such enum exists in the schema - it is unscheduled P-3.2 under "Card source model" above, the same stale premise D150-D155 met. Implemented as free TEXT plus a normalizing seed list in code | D166 |
| **Flagged, deliberately not solved**: D09's three-source classification now faces a fourth bucket living in a separate table. A `tip_picks` row is not a card and no classifier reads it, so the question is open rather than answered by this schema | - (see D09) |

## One owner for `source_label` (requested 2026-09-08)

Follows D166's own flagged finding. Consolidation, not new capability.

| requirement | deliverable |
| --- | --- |
| "Who said this" is answered by ONE normalizer, shared by every table with a `source_label` column, so `llm_notes` and `tip_picks` cannot drift in the shape of a label | D167 |
| The notes vocabulary is visible to the SERVER, not hard-coded in a client component where only the browser could see it | D167 |
| A note's source label is normalized on write, so grouping by source is exact rather than case-and-spacing dependent - and provably inert for every value already in the corpus | D167 |
| The two catalogues stay separate: a KIND of commentary (`public-handicapper`) and a named publisher (`trackmaster`) are two axes, and `trackmaster` belongs to that kind rather than sitting beside it | D167 |
| The two fallbacks stay separate: a blank note is the user's own, while a tip sheet whose publisher could not be read is nobody's opinion | D167 |
| **Deliberately NOT built**: P-3.2's `cards.source_label` / `source_label_other`. Still unscheduled, and card source remains derivable from three columns that already agree 1:1 - see "Card source model" above | - (P-3.2, still unscheduled) |

## HOUSE RULE: `check-static-app` in worktrees (2026-09-08)

| requirement | deliverable |
| --- | --- |
| `check-static-app` is out of scope inside a git worktree - not run, not worked around, and not treated as a gap in that branch's verification | D168 |
| The static app's import surface, not a forced build, answers "could this change have moved the static bundle?" - and the list is re-derived rather than trusted | D168 |
| A skipped check is stated plainly in the final message; a report never implies the suite ran clean when a script did not run | D168 |

## Review and correct extracted tip picks (requested 2026-09-08)

| requirement | deliverable |
| --- | --- |
| A tip-sheet screenshot can be uploaded, previewed and saved from the race-day page | D169 |
| The preview is READ-ONLY and a save stores verbatim model output - invariant 9 stays literally true, because it governs the parse->save path | D169 |
| The save re-parses the archived model RESPONSE rather than trusting the browser, since re-extracting would be a paid, non-deterministic call | D169 |
| A misread can be corrected on the STORED row - a separate, explicit, recorded act, never an edit of the preview | D169 |
| A correction preserves the model's FIRST extraction forever, so every corrected row is a labelled example of what the extraction got wrong | D169 |
| A hand-typed ranking goes through the same validator the model's output does - a human cannot save a ranking the parser would refuse | D169 |
| An odds box left empty means "the sheet showed no price", and the UI never suggests a price the sheet did not show | D169 |
| **Still out of scope**: staking/ticket construction from tip picks, grading, and resolving D09 | - (later deliverables) |

## TIPSHEET scoring (requested 2026-09-08)

| requirement | deliverable |
| --- | --- |
| Tip picks are scored against saved results, so a source can be judged rather than just stored | D170 |
| Scoring is rank-based and carries no money - nothing stakes a tip sheet, so a P/L figure would be invented | D170 |
| A scratched top pick promotes the next live pick, and the substitution is reported | D170 |
| An unplaced also-ran is a loss; a program number absent from the result is surfaced as a likely extraction misread, never silently scored a loss | D170 |
| Anything unscorable returns NULL rather than zero, and unscored races are reported separately from the rate | D170 |
| Every aggregate carries its `n`, every rate is NULL at n=0, and the UI cannot render a rate without its denominator | D170 |
| Sources are never pooled - there is no combined "tipsheets" total (invariant 13) | D170 |
| A soft-deleted race day leaves every scoring figure and returns on restore (invariant 12) | D170 |
| **Still out of scope**: staking tip picks into a card (`shared/tipStaking.js`), and resolving D09 | - (later deliverables) |

## TIPSHEET staking (requested 2026-09-08)

| requirement | deliverable |
| --- | --- |
| Tip picks become real tickets that the ordinary grader grades, with no special case | D171 |
| Three variants per day, so backtesting picks the bet structure rather than a guess up front | D171 |
| TIPSHEET is its own bucket and pools with nothing (invariant 13) | D171 |
| Stakes are per-race shares of the bankroll, floored to whole dollars, and every stake is payable at a window | D171 |
| A win bet on an 8/1+ pick carries matching place money, funded from the same budget | D171 |
| Staking a source twice appends new cards rather than rewriting graded ones | D171 |
| A preview writes nothing (invariant 9) | D171 |
| **Dropped, with evidence**: the supplied draft's ML-vs-live-odds gap sizing. `entries.live_odds` is populated on 0 of 13,710 rows; the draft produced zero bets on both real tip sheets | - (needs a live-odds capture path first) |

## Fix: the LLM modal blanked the page (reported 2026-09-08)

| requirement | deliverable |
| --- | --- |
| "Generate Card from LLM" opens the modal instead of blanking the page | D172 |
| A module may not use a name it only re-exports - the blank-page class is caught by a check, not by a bug report | D172 |
| That check normalizes CRLF, because this repo stores CRLF and JS `.` will not cross `\r` | D172 |

## Fix: staked cards needed a reload (reported 2026-09-08)

| requirement | deliverable |
| --- | --- |
| Cards written by the tip-staking panel appear in the Betting cards table without a page reload | D173 |
| Every sibling of `CardsPanel` that writes a card carries the `onSaved` wire, and the code says so rather than naming one sibling | D173 |

## One tipsheet card per source (requested 2026-09-08)

| requirement | deliverable |
| --- | --- |
| A tip sheet produces ONE card per variant per day, covering every race that has picks - not a fresh set on every stake | D174 |
| Staking again after another race's picks arrive updates those cards and re-prices every race, because the per-race budget depends on the race count | D174 |
| A different source still gets its own cards - two tip apps are two opinions (invariant 13) | D174 |
| Re-staking a graded card is warned about before it happens, never silently, and never blocked | D174 |
| Duplicates already created are folded by an explicit dry-run script that refuses to delete a graded card | D174 |

## Tipsheet and OTR as a baseline LLM input (scoped 2026-09-08)

Scope and archaeology: `docs/requirements/llm-baseline-inputs.md`.

| requirement | deliverable |
| --- | --- |
| The LLM prompt carries what the day's other sources think, LABELLED per source | D179 |
| Tip sheets render as ranks; OTR renders as printed tickets, because it never claims a ranked 3rd pick | D179 |
| Both sources appear when both exist - no precedence, neither dropped | D179 |
| A race with no baseline produces the byte-identical prompt it always did | D179 |
| A free-text source label cannot forge the ticket markers | D179 |
| **Out of scope by instruction**: any measurement of whether the baseline improves results or grades | - (excluded) |

## TIPSHEET P/L and day-view P/L (requested 2026-09-08)

| requirement | deliverable |
| --- | --- |
| The TIPSHEET bucket total counts one variant per (day, source) - three mutually exclusive alternatives are not one spend | D175 |
| The counted variant is fixed, never the best-performing one, so the headline figure cannot be cherry-picked | D175 |
| The other variants are reported beside it as a breakdown that is never added to the total | D175 |
| A graded card shows its P/L on the day view, from the same grade set /api/pl reports, agreeing to the cent | D175 |
| An ungraded card shows a dash, never $0 - not-graded-yet and broke-even are different facts | D175 |

## Manual tip-pick entry (requested 2026-09-08)

| requirement | deliverable |
| --- | --- |
| Tip picks can be typed per race instead of photographed, with no API call | D176 |
| A horse can be ranked in several tipsheets at once, because real sheets overlap | D176 |
| Typed picks produce the identical payload extraction did - same validator, same writer, same rows | D176 |
| Horse names come from the race day, never the client; no odds are invented from the morning line | D176 |
| Clearing every rank in a column removes that sheet from the race, with no second verb for it | D176 |
| The dialog edits what is already there rather than starting blank | D176 |
| **Split out**: removing the screenshot path entirely | D177 |

## Removing the tip-sheet screenshot path (decided 2026-09-08)

| requirement | deliverable |
| --- | --- |
| Tip picks no longer require a vision call, an image upload, or an archive | D177 |
| The writer, reader, validator and odds normalizer survive - they were never part of the vision half | D177 |
| Columns holding real values from already-extracted rows are kept, not dropped | D177 |
| Scoring, staking and P/L are untouched by the removal | D177 |

## LLM prompt inputs (analysed 2026-09-08)

| requirement | deliverable |
| --- | --- |
| The system prompt describes only inputs that actually arrive - no promise of consensus picks, program rankings or a Bottom Line | D178 |
| Entry lines carry the program number, the horse and the morning line; nothing sourced from the deleted program ingestion | D178 |
| Assertions about removed prompt content are inverted, not deleted, so re-adding a dead field is deliberate | D178 |
| **Rejected on evidence**: stripping program numbers from the prompt. 0.1% error rate over 3,190 references, both failures traced to a data defect, ~2.5% token saving, and it would trade a non-blocking name check for a blocking one | - (analysed, not built) |
| **Found, not fixed**: 150 entries across 15 days carry `SCR`/`SCR-2` as a program number | - (own deliverable) |

## A program-less scratch has no program number (fixed 2026-09-08)

| requirement | deliverable |
| --- | --- |
| A scratched horse whose number Equibase does not print is stored NULL, not a placeholder | D180 |
| Two program-less scratches in one race need no suffix and no parse-order dependence | D180 |
| A ticket cannot name a scratched, numberless horse - the scratch guard keys on the number, so a NULL must be refused earlier | D180 |
| **Corrected**: D178's claim that the placeholder corrupted two LLM generations. Re-measured on the selections column, 0 of 3,156 references were wrong | D180 |

## Multi-parser, multi-track/day entries ingestion (scoped 2026-09-09)

Full specification, with what checking it against the code found - including
that the incoming scope's cited "prior evaluation" of three Apify actors and
its cited `D-scope-race-day-notes-entry.md` do not exist anywhere in this
repository:
[docs/requirements/multi-parser-entries-ingest.md](docs/requirements/multi-parser-entries-ingest.md).
Specified but NOT scheduled - deliverable IDs get claimed when the work is
picked up.

| Requirement | Deliverables |
| --- | --- |
| Entries parsers are pluggable adapters to one canonical payload shape, chosen per run via `--parser`, instead of the one hardcoded HTML parser - the shape already matches what `insertRaceDay` consumes | D188 (M-1) |
| An unknown `--parser` value is a hard error naming valid ids, never a silent fallback to default | D188 (M-1) |
| One command pulls a full day's slate across every track racing, each pulled and parsed independently so one track's failure doesn't abort the run | - (not scheduled) |
| Every ingest run lands in one ledger (`ingest_runs`) that a later comparison and cost report both read from | - (not scheduled) |
| A challenger parser is compared against the HTML parser as the trusted baseline - never symmetric peer comparison - on the "label everything, conclude nothing until n is stated" rule already governing this corpus | - (not scheduled) |
| Every parser's real cost is tracked per run, including the ones that aren't billed in dollars, and an Apify actor's cost comes from its own billed-run API rather than its advertised rate | - (not scheduled) |
| `source_parser_id` provenance is queryable per race day without cross-referencing `ingest_runs` by timestamp | - (not scheduled) |
| Switching the default parser is always a manual decision informed by the comparison evidence, never automatic | - (not scheduled) |
| **Open question, not resolved here**: whether automated per-day track discovery belongs in this local-only, invariant-6 app at all, since it would be the first automated outbound fetch since D113 deleted the crawler | - (undecided) |
