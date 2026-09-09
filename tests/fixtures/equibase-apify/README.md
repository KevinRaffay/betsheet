# Apify dataset fixtures

`parseforge-ind-kd-2026-09-09.json` — a real Apify dataset export the user
supplied directly (not fetched by this codebase — invariant 6). Identified
as the `parseforge/equibase-scraper` actor's output from its own filename
convention (`dataset_<actor-name>_<timestamp>.json`, Apify's default export
name) and corroborated by content: it carries scratches, medication and
claiming price, which the inherited scope named as `parseforge`-only fields
among the three actors evaluated.

100 rows, 11 races across two tracks (Horseshoe Indianapolis `IND`, races
1-9; Kentucky Downs `KD`, races 1-2) for 2026-09-09. `scripts/
check-equibase-apify-parseforge.js` hand-counts every real value this file
carries (per-race entry/scratch counts, the three genuine `weight: 1137`
data-quality glitches in the source, the morning-line-decimal recomputation)
so regenerating or re-deriving anything from this file cannot silently bless
a regression. **Never regenerate this file** — there is no way to
re-request it (it was a one-time paid actor run), so it is the only sample
this codebase has of this source's real shape.
