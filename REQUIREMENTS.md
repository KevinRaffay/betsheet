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
| Track picks page / At The Races / algorithmic sites fetchers with fixtures | D08a, D08b, D08c |
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
