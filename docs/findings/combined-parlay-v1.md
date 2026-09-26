# Combined per-race model, v1 — backtest over the stored corpus

**Status: LIVE.** Model `shared/race-consensus.js` at D434, weights `DEFAULT_WEIGHTS`
(`tipTop 0.20, tipNamed 0.08, llmPrimary 0.20, llmBacked 0.08, otrWin 0.20,
otrShow 0.08, maxBump 0.8`). Corpus: every non-deleted day with results on
2026-09-26.

**Run cited throughout:** `npm run backtest-race-consensus -- --db
C:/repos/betsheet/data/betsheet.sqlite --json docs/findings/combined-parlay-v1.run.json`,
`generatedAt 2026-09-26T15:53:14.809Z` (08:53 PT). The full output is committed beside
this file as `combined-parlay-v1.run.json`, and every number below is read from it.

## The corpus

- **37 graded days, 361 races** (2 races skipped for no result).
- Signal coverage:
  - 355 races carry at least one source signal.
  - Tip sheets: 158 races. LLM cards: 302. OTR: 352.
  - 69 races are priced off a typed live board. The other 292 are priced off the morning line.
- **19 LLM card-races were excluded as post-result** (notes entered after results, `notes_post_result`), under the loader's leakage rule.
- **The weights were stated before this run and were not fitted to it.** Nothing below re-tunes them.

## 1. Does the combination forecast the winner better than the market it starts from?

Paired against the market on the same races. A negative Δ is better. ±SE is the
standard error of the mean paired difference.

| variant | n races | log-loss | Δ vs market | ±SE | top pick won |
| --- | --- | --- | --- | --- | --- |
| market (weights 0) | 361 | 1.8302 | — | — | 34.3% |
| combined | 361 | 1.8169 | −0.0133 | 0.0091 | 33.2% |
| tip sheets only | 361 | 1.8210 | −0.0092 | 0.0043 | 33.8% |
| LLM only | 361 | 1.8275 | −0.0028 | 0.0047 | 31.6% |
| OTR only | 361 | 1.8237 | −0.0066 | 0.0038 | 35.2% |

- **Combined** is 1.5 SE better than the market. That is not a difference.
- **Tip sheets alone** is the only reading past 2 SE (2.1 SE), and the only source-alone result worth taking into the next corpus.
- **The LLM vote carries nothing measurable** (0.6 SE). On the 148 races with both tip sheets and an LLM card, LLM-only is +0.0035 ±0.0077, slightly *worse* than the market. That is consistent with the LLM seeing the tip sheets and OTR in its prompt (D179) and adding no independent information. It is not proof of that.
- **The top-pick win rate got worse under combined**, 33.2% against 34.3% (n=361). The nudge improves the probabilities a little and the first choice not at all.
- **On the 69 live-board races, combined is worse** than the market: +0.0074 ±0.0256. That is noise at this n. But it is the right direction to worry about: a typed board already carries the crowd's late opinion, so the sources may be double-counting it.

**The close dwarfs all of it.** On the 248 races whose chart carries post-time odds:
- the closing market's log-loss is **1.6269**
- the morning-line/board market's is 1.8124
- combined's is 1.8064

The sources recover 0.006 of a 0.186 gap. Getting closer to the late board is worth about 30 times more than the sources are.

## 2. Are the place/show probabilities calibrated?

These are runner level, under the combined model. Win and place track closely. **Show is overconfident at the top, as Harville was expected to be:**

| predicted show | n | observed |
| --- | --- | --- |
| 50–60% | 274 | 50.0% |
| 60–70% | 226 | 60.6% |
| 70–80% | 165 | 71.5% |
| 80–90% | 76 | 77.6% |
| 90–100% | 27 | 88.9% |

That is 3–7 points of overstatement on exactly the horses a "high probability" parlay picks. The overstatement then compounds across legs.

## 3. "Most likely to cash" parlays

**Method:**
- One $2 parlay per day: the legs with the highest predicted P(all hit), optionally subject to an estimated payout floor.
- The floor uses the estimate `(1 − 0.17) / q_market`, which is a heuristic.
- Every parlay is graded at the chart's real prices through `gradeTicket`.
- **n = 37 days per row, and the rows are not independent**: they share days and often share legs. So the 36 rows in the run file are not 36 tests.

| selection | kind | legs | floor | hits / n | hit rate | mean predicted P | ROI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| market | place | 2 | none | 23 / 37 | 62.2% | 39.1% | +3.4% |
| combined | place | 2 | none | 19 / 37 | 51.4% | 47.7% | −9.2% |
| market | show | 2 | none | 21 / 37 | 56.8% | 64.9% | −29.5% |
| combined | show | 2 | none | 20 / 37 | 54.1% | 72.9% | −30.7% |
| market | win | 2 | none | 10 / 37 | 27.0% | 13.1% | −11.8% |
| combined | win | 2 | none | 8 / 37 | 21.6% | 17.5% | −24.6% |

- **Combined against market selection is a coin flip.** Across the 18 paired (kind, legs, floor) rows, combined had the better ROI in **9 of 18**:
  - 0 of 3 of the no-floor 2-leg rows shown above
  - 3 of 6 of the 2-leg rows with a floor
  - 6 of 9 of the 3-leg rows
  
  No selection method is favoured by this corpus.
- **Combined 2-leg show parlays predicted 72.9% and hit 54.1%** (20/37). The calibration gap in section 2, compounded over two legs, is visible in money.
- **Every show-parlay row lost 29–78%.** Near-even-money legs pay back less than the take removes, which is exactly the trade-off the plan warned about.

## What is NOT concluded

- **That the combined model beats the market.** It is 1.5 SE, on one corpus, with no out-of-sample check.
- **That any parlay configuration has positive expectation.** The one positive row (market place, 2 legs, +3.4%) is 23 hits in 37, one row out of 36 correlated rows, and sits well inside noise.
- **Anything about the weights.** They were not fitted, and on 37 days they must not be.
- **That the LLM adds nothing.** The measured effect is zero at this n, and the LLM's inputs overlap the other sources by construction.

## What this means for the next deliverables (DB / DC)

- **A builder must not show raw Harville show probabilities as "P(hit)".** Either shrink them against this calibration table or label them as model estimates. Otherwise the UI states 73% for something that lands 54% of the time.
- **Surface the market-only selection beside the combined one.** On this corpus it is at least as good: a better top pick, parlay ROI tied 9-9, and a log-loss difference within noise. A reader deserves to see that.
- **The typed live board is the most valuable input found here.** Capturing it on more races is a better investment than adding sources.

## The question the next corpus must answer (pre-registered 2026-09-26)

On races from days recorded **after 2026-09-26**, with these exact weights, frozen:

1. **Tip sheets.** Is tip-sheets-only Δ log-loss vs market below zero by more than 2 SE? It was −0.0092 ±0.0043 here.
2. **Combined.** Is combined Δ below zero by more than 2 SE?
3. **Show calibration.** Does combined show calibration still overstate the 60–90% bins by 3 or more points?

If (1) fails, the tip-sheet weight has no support. If (2) fails, a builder should select legs from the market alone and use the sources only as labels.
