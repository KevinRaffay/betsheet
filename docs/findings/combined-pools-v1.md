# Combined model, pool tickets v1 — Daily Double / Pick 3-5 backtest

**Status: LIVE.** Builder: `shared/parlay-builder.js` `buildPoolTickets` at D442. Model: `shared/race-consensus.js` with D434's unfitted `DEFAULT_WEIGHTS`, the same as `combined-parlay-v1.md`. Corpus: every non-deleted day with results on 2026-09-26.

**Run cited throughout:** `npm run backtest-race-consensus -- --db C:/repos/betsheet/data/betsheet.sqlite --json docs/findings/combined-pools-v1.run.json`, `generatedAt 2026-09-26T16:41:59.923Z` (09:41 PT). Section 5 of that output is the pool backtest. Sections 1-4 reproduce `combined-parlay-v1.md` unchanged: combined vs market log-loss −0.0133, n=361.

## Method

- **Days:** 37 graded days.
- **One ticket per day and setting:** the builder's single best candidate (`limit: 1`) for each pool, and for `any` pool, at budgets of $6, $12 and $24. The pool must be offered by the starting race's printed menu, at the menu's base or a labelled fallback.
- **Legs:** a greedy spread that adds the horse buying the most log-coverage per log-cost, until the budget is reached.
- **Grading:** against the chart's own payoff row on the settling race, through `gradeTicket`.
- **Ungradable tickets:** a ticket whose chart has **no row for that pool** is left out and counted, never scored as a loss. At most 2 days per setting (Pick 4 at Kentucky Downs 2026-09-07 races 11-14, and Gulfstream 2026-09-11 races 2-5): the menus offer those pools, but the stored charts carry no payoff for them.

## What it found

The `any` rows are what a user gets from the modal with every pool ticked. There are 37 days per row, and each row is a separate one-ticket-per-day series.

| selection | budget | hits / n | hit rate | mean predicted P(hit) | ROI |
| --- | --- | --- | --- | --- | --- |
| market | $6 | 14 / 37 | 37.8% | 31.9% | −17.5% |
| combined | $6 | 17 / 37 | 45.9% | 36.7% | +8.0% |
| market | $12 | 19 / 37 | 51.4% | 47.8% | −33.2% |
| combined | $12 | 21 / 37 | 56.8% | 52.9% | −31.8% |
| market | $24 | 27 / 37 | 73.0% | 67.6% | −22.5% |
| combined | $24 | 28 / 37 | 75.7% | 71.3% | −23.4% |

- **Spreading buys hit rate, not money.** Going from $6 to $24 took the combined hit rate from 45.9% to 75.7%, and ROI stayed negative at every budget above $6. A wider spread covers the favourites a pool pays least for.
- **Daily Double P(hit) is roughly calibrated.**
  - Combined: 51.7% predicted vs 51.4% observed at $12, and 70.1% vs 73.0% at $24.
  - Market: 46.6% vs 48.6%, and 66.1% vs 70.3%.
- **The combined selection's Pick 3 P(hit) is overstated at larger spends.**
  - Combined: 35.4% predicted vs 29.7% observed at $12, and 48.5% vs 37.8% at $24.
  - This has the same shape as the show-probability overstatement in `combined-parlay-v1.md`, compounded across three legs.
  - The market selection does NOT show it consistently: 29.7% predicted vs 37.8% observed at $12 (understated), and 43.0% vs 35.1% at $24 (overstated).
  - So the direction depends on the setting, and on 37 days neither selection's Pick 3 calibration is settled.
- **Pick 4 / Pick 5 hit MORE often than predicted.** For example, market Pick 5 at $6 predicted 1.5% and hit 3 of 36. **That is the charts, not the model:** several stored Pick N payoffs name many winners in a leg (`4/7/8-5-3/4-1/2/5/13/14`, `1/3/6-ALL-4-5`, from off-the-turf "all" legs and scratch substitutions), and the grader correctly counts any named horse as a hit. The model assumes one winner per leg, so those days are easier than it thinks. Every Pick 4/5 hit count here is 3-8, so none of those rows can say anything.
- **Combined vs market ROI:** combined was ahead in 10 of the 15 paired (pool, budget) rows. The rows share days and often share tickets, so that is not 15 tests. The one positive `any` row (combined, $6, +8.0%) is 17 hits in 37.

## What is NOT concluded

- **That any pool setting has positive expectation.** Every positive row rests on n=37 days, and the large ones (Pick 5 at $6, +93%) on 3 hits. Those come from a corpus whose Pick N charts include multi-winner legs, which make hits easier than the model assumes. Which of those 3 hits, if any, rode such a leg was not isolated.
- **That the combined selection beats the market's.** The 10-5 row count is correlated, and on the corpus's own forecast the difference is 1.5 SE (`combined-parlay-v1.md`).
- **Anything about the budgets.** $6 / $12 / $24 are illustrations, not optimised.

## The estimate the builder shows

`BET.estimates.poolFactor` is **measured, not tuned**: the interquartile range of what each pool actually paid per base, divided by the winners' morning-line odds chained, over every stored payoff.

| pool | n | median |
| --- | --- | --- |
| DD | 316 | 0.567 |
| Pick 3 | 276 | 0.443 |
| Pick 4 | 73 | 0.317 |
| Pick 5 | 66 | 0.235 |

**Pick 6 is not built** (n=16, median 0.003): its jackpot and carryover pools pay mostly consolations, so no band describes a full hit.

## The question the next corpus must answer (pre-registered 2026-09-26)

On days recorded **after 2026-09-26**, with these weights and this builder frozen:

1. **Pick 3 calibration.** Does the Pick 3 P(hit) overstatement at $12-$24 persist? That is, is predicted minus observed still above 5 points?
2. **Daily Double calibration.** Does the Daily Double stay within 5 points?
3. **ROI.** Is `any`-pool ROI at $6 still at or above the $12 and $24 ROI? That is the "spreading buys hit rate, not money" claim, restated so it can fail.

## Correction, 2026-09-26 (D444): the builder misread some pool bases

**What was wrong.** D442's `menuPools` could not read an amount separated from its pool by a qualifier word. Examples: `$3 PRIME PICK 3`, `$3 Late Pick 3`, `$5 Late Double`, `50c Early Pick 5`, `$.50 Cent Pick 4`. It fell back to `BET.minimums`, sometimes BELOW the real minimum. `$3 Late Pick 3` was read as 50c, which is an unbuyable ticket. It also read only a pool's first mention on a menu, so a non-consecutive special printed first hid the real pool. D444 fixes both. Some tickets above were therefore built at the wrong base.

**The effect, isolated.** Both runs are on the SAME corpus, now 38 days: the 37 above plus Santa Anita 2026-09-26, graded today.

| run | code | file | generatedAt |
| --- | --- | --- | --- |
| baseline | `main` before the fix | `combined-pools-v1.d444-baseline.run.json` | `2026-09-27T03:48:08Z` (2026-09-26 20:48 PT) |
| fixed | D444 | `combined-pools-v1.d444.run.json` | `2026-09-27T03:47:52Z` (20:47 PT) |

- **12 of the 30 pool rows are identical**: **every `any` row and every Daily Double row**. The headline table above is therefore not changed by the fix.
- **The six Pick 5 rows** differ only in mean predicted P(hit), by under 0.03 points. Their hits, cost and ROI are identical.
- The `any` rows do differ from the 37-day numbers above, by the new day alone. For example, combined $6 goes from 17/37 to 17/38, and $24 from 28/37 to 29/38.
- **Pick 3 rows** move by at most one hit.
  - Combined $12: 11/38 becomes 10/38. Mean predicted P(hit) 35.3% becomes 33.1%.
  - Combined $24: 14/38 becomes 13/38. Mean predicted 48.4% becomes 45.5%.
  - So the combined Pick 3 overstatement at $12-$24 holds under the corrected bases: 33.1% predicted vs 26.3% observed at $12, and 45.5% vs 34.2% at $24.
- **Pick 4 ROI swings widely** on 5-8 hits:
  - combined $12: −56.5% becomes −2.8%
  - combined $24: +10.7% becomes −16.3%
  - market $12: −71.6% becomes −17.8%
  
  That volatility is the finding: a single hit's payout moves a Pick 4 row by tens of points of ROI, which is why none of those rows was read above and none should be now.

**The pre-registered test** runs under the D444 reading. A misread base is a bug, not a builder rule anyone chose, and the test is about calibration and the $6-vs-larger ROI ordering, neither of which the fix moved. Santa Anita 2026-09-26 is NOT "after 2026-09-26", so it stays outside that test.

## Correction, 2026-09-26 (D446): unpriced pools priced from chart history

**What changed.**
1. **A pool the menu names with NO price** now takes the highest base that pool has charted at that track on EARLIER days (`poolBaseHistory`), rather than the fixed `BET.minimums` fallback. The fallback was below the real minimum where the same unpriced text is two different pools: Churchill Downs' 50c rolling Pick 3s and its $3 late Pick 3 are both printed "Pick 3 (Races 8-9-10)".
2. **A price printed at the start of a parenthetical** is now read: Santa Anita's "Late Pick 3($3 -15% takeout)".
3. **"Leg 2 of … Pick 3" / "3rd Leg of …" mentions** are no longer read as pools starting on that race.

**Measured before building.** Of the unpriced offers on live days that have a chart row for the same day. These counts cover Daily Double and Pick 3; every Pick 4/5 fallback was already at or above the real minimum, and Pick 6 is never built.

| | fallback below the real minimum (unbuyable) |
| --- | --- |
| before D446 | 7 |
| after D446 | 1 (Churchill 2026-09-10, the first Churchill day on file, with no earlier chart to learn from) |

Every chart-history base is at or above its day's real minimum.

**The cost of that safety is visible.** Churchill's rolling Pick 3s are now bet at $3 a combination, not 50c, so a budget buys less spread.

**The effect, isolated.** Both runs are on the same 38-day corpus:

| run | code | file | generatedAt |
| --- | --- | --- | --- |
| baseline | `main` at D444 | `combined-pools-v1.d446-baseline.run.json` | `2026-09-27T04:21:08Z` (2026-09-26 21:21 PT) |
| fixed | D446 | `combined-pools-v1.d446.run.json` | `2026-09-27T04:21:07Z` |

- **All 30 rows move this time, in both directions.** Where a track has only ever charted a $1 Daily Double, the $2 fallback drops to $1 (cheaper, more spread, higher predicted P). Where an unpriced Pick 3 might be the $3 one, it rises (dearer, less spread, lower predicted P).
- **The `any`-pool ordering holds:**

  | selection | $6 | $12 | $24 |
  | --- | --- | --- | --- |
  | combined | +7.7% (18/38) | −19.6% (21/38) | −33.5% (29/38) |
  | market | −7.9% | −34.4% | −41.8% |

  "Spreading buys hit rate, not money" survives the fix.
- **The combined Pick 3 overstatement holds, and widens:**
  - $12: 29.4% predicted vs 21.1% observed (8/38)
  - $24: 40.8% vs 34.2% (13/38)
- **Daily Double stays within about 3 points**, e.g. combined $12: 54.4% predicted vs 52.6% observed (20/38), and $24: 73.9% vs 76.3% (29/38).

**The pre-registered test** runs under the D446 reading, for the same reason as D444's: an unbuyable base is a bug, not a rule anyone chose.
