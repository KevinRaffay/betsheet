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

`parseforge-dmr-2026-09-07.json` — a SECOND real sample the user supplied
the same way, for Del Mar on 2026-09-07 (123 rows, 11 races, one track).
Same actor (same filename convention, and the same class of data-quality
glitch — an occasional weight with an extra digit, 1175/1165 here — as the
first file), but a LEANER capture: no `rowType`, no `trackCode`, no
`isScratched`, no `medication` anywhere. This is what made
`equibase-apify-parseforge.js` handle both shapes: deriving a track code
from `trackName` when `trackCode` is absent, and inferring scratch status
from a missing `programNumber` (reported via a `scratch_status_inferred`
warning naming every horse it applied to, never silent) when `isScratched`
is absent. **Never regenerate either file** — neither can be re-requested.

`apify-results-dmr-2026-09-07.json` — a real Apify dataset export the user
supplied directly (not fetched — invariant 6), from the same `equibase-
scraper` naming family but scraped in a RESULTS mode: every row carries
`rowType: "result"`, `finishPosition` and payoff fields, unlike the entries
mode above. A prior file from the identical naming convention, supplied the
same session, turned out to carry no results at all (see docs/requirements/
equibase-apify-results-ingest.md's header) — the naming convention alone
does not identify what an export of this kind contains; the fields do.

106 finisher rows, 11 races, one track (Del Mar `DMR`) for 2026-09-07 — the
same day as `parseforge-dmr-2026-09-07.json` above, but this file is the
RESULTS side of that day, from a separate scrape. `scripts/
check-equibase-apify-results.js` hand-counts the same way: per-race
finisher counts, the two races (3 and 7) missing `finalTime` entirely, the
`exoticWagers` array's one-row-per-race placement (the winner's row only),
and the payout/wager-type conversions, re-derived independently from the raw
file rather than trusted from the parser's own output. **Never regenerate
this file** — same reasoning as the file above.
