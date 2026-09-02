# Requirements → deliverables

Every requirement maps to the deliverable ID(s) in
[DELIVERABLES.md](DELIVERABLES.md) that cover it, so coverage is traceable.
When a requirement's coverage changes (split PRs, resequencing), update this
map in the same PR.

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

| Requirement | Deliverables |
| --- | --- |
| Pasted entries text parsed per race/horse (all program fields) | D04 |
| Program PDF parsing: jumbled columns via post-position sequence, index validation | D05 |
| Handicapper analysis (e.g. DRF Bottom Line) → rankings + Best Bet flag | D05 (the pasted entries format carries no analysis section; the program PDF does) |
| Parse preview (read-only) confirmed before saving; corrections at the source + re-parse | D06, D14 |

## Consensus (workflow step 2)

| Requirement | Deliverables |
| --- | --- |
| Automated fetch on card creation; day-of re-fetch/refresh | D07 |
| Track picks page / At The Races / algorithmic sites fetchers with fixtures | D08c (built). D08a closed — the dmtc picks page is a directory; the track handicapper's picks are D05's Bottom Line extraction. D08b closed — ATR is bot-protected; entered via D07 manual paste |
| Track+date verification; discard mismatches | D07 |
| Manual paste/upload fallback into the same consensus structure | D07 |
| Fetch audit log; failed/stale sources visible in UI | D02, D07 |
| Missing consensus never blocks generation; per-race source labeling | D09, D10, D11 |
| Consensus table; UNANIMOUS/SPLIT/CHAOS classification; source-count cap | D09 |
| Contrarian flags (algo fading favorite; corroborated longshots) | D09 |
| No Equibase scraping; robots.txt respected, back off resistant sources | D07 (framework rule), D12/D13 (results via paste/PDF) |

## Card generation (workflow step 3)

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

| Requirement | Deliverables |
| --- | --- |
| Every card records consensus_completeness (FULL / PARTIAL / PROGRAM_ONLY) from sources actually used | D25 (schema, migration 003), D10 (computed + written at generation) |
| All P/L, simulation and distribution reporting buckets by completeness; program-only backfill never pools with full-consensus in one aggregate | D16, D19, D20 (rule: invariant 12) |
| Wayback Machine fetcher (web.archive.org) retrieves archived versions of each consensus source for historical dates; outcomes audited like any source | D08d (on the D07 framework) |
| Simulator evaluates structure-layer rules (place-money, hedge cuts, exotic construction, allocation curves) independently of race classification, so historical cards benchmark bet construction even without signal data | D18 (layer split), D19 (evaluation) |

## Results, grading & simulation (workflow step 5)

| Requirement | Deliverables |
| --- | --- |
| Equibase chart parsing: pasted text; WPS + all exotic payoffs, scratches, "Also ran" | D12 |
| Chart PDF ingestion | D13 |
| Results ingest UI linked to the card's race day | D14 |
| Grade every ticket (all bet types, exotics, parlays, scratch/refund rules) | D15 |
| P/L per-race, per-day, running; compare sheet variants | D16 |
| Strategy templates as reusable rules | D18 |
| Simulate templates across all stored cards with real payoffs | D19 |
| Distributions: % losing days, max drawdown, single-ticket dependence (>80%) | D20 |
| Decision traces joined with graded results, exportable for LLM analysis | D17 |
| Discipline tracker (planned vs. actual, house-money warnings) | D24 (schema in D03) |

## Backtest hygiene (addendum 2, 2026-09-02)

| Requirement | Deliverables |
| --- | --- |
| Every card records the engine version that built it; regeneration is append-only and graded results are immutable per (card, engine_version) - improvement is measured by comparing versions (invariant 14) | D34 (schema, recipe, trace, P/L version filter), D28 (append-only generation), every engine PR (bumps the version) |
| P/L buckets never pool across engine versions unless the user explicitly chooses all versions | D34 |
| Canonical track codes: every ingest path normalizes the track at save; the one-day-per-track+date rule and the chart mismatch refusal key on the code | D35 |
| Allocation integrity: a race's tickets land on its allocation - mandatory place money is carved out of the allocation, never added on top; the balancer's remainder is spread, never parked | D36 (carve-out), D30 (remainder spread) |
| Every race in every program fixture parses a well-formed distance; an unparsed distance is a preview warning, never `?` | D37, D32 (grammar) |
| The card footer lists program-time AND chart scratches after grading, labeled by source | D38 |
| Effective wagered (wagered − refunds) and effective ROI reported beside nominal at card, day and bucket level; refunds visible | D39 |
| Historical simulation can apply chart scratches before generation (at-the-window baseline), both modes reported | D19 (option) |
| Single-ticket dependence reported gross and net; the flag driven by net | D20 |

## Morning-line sheet (addendum 3, 2026-09-02)

| Requirement | Deliverables |
| --- | --- |
| The track's ML/changes PDF parses into the entries structure and is the entries source of record; the program PDF is analysis-only and cross-validated against it, the sheet winning every disagreement with a warning | D40 |
| Ingest accepts the ML sheet alone (ODDS_ONLY completeness, below PROGRAM_ONLY), the program alone, or both (preferred) | D40 |
| The ML sheet is fetched from the track at its predictable URL when robots allow, audited like every fetch; past dates feed backfill | D40 (on the D07 framework) |

## Historical backfill (addendum 4, 2026-09-01)

| Requirement | Deliverables |
| --- | --- |
| Backfill from the track's own archive: calendar-indexed, robots-respecting, polite, conditional requests, raw artifacts archived with a manifest; parsers run from the archive, never the network | D41 (on the D07 framework) |
| Results from the track's results page as a second results source of record, cross-validated against Equibase charts: identical returned cents per ticket from either source | D42, D15 (grader) |
| Batch ingestion policy A: a day saves automatically only with zero blocking warnings; anything blocking goes to a review queue in the UI - the documented batch exception to invariant 9 | D43 |
| Per-meet fixtures and golden checkpoints: the runner halts at each meet's first race day until its golden is audited | D43 (the D32 pattern) |
| `meet` on race_days (DMR-<year>-summer / -fall), with P/L and distribution grouping by meet | D43 (schema + runner), D16 / D20 (grouping) |
| Every backfilled card carries the engine version it was generated under; D34 precedes any backfill run | D34, D43 |
