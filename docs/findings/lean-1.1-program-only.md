# Findings: engine `lean-1.1`, bucket PROGRAM_ONLY, corpus DMR 2025-2026 (70 days)

Written 2026-09-02 from simulation runs **#27-#50** (D52). This file is
versioned per (engine version, bucket, corpus) and is never edited after
`lean-1.1` is superseded - a later engine gets a new file (CLAUDE.md,
"Findings"). Every number below cites the run it came from; the runs are
append-only rows in `simulation_runs` / `simulation_results` and the tables
are what `GET /api/simulations/compare?meet=` returns for them.

Nothing in this file changes the engine. It records what the structure
layer did on this corpus so that a `lean-1.2` proposal, if one is made, is
argued from run IDs and not from memory.

## 1. Corpus

| item | value | source |
| --- | --- | --- |
| Days | 70, all with dmtc results, all live (the two Breeders' Cup days were dropped under D46) | `race_days` |
| Meets | DMR-2025-summer 31 days (2025-07-18 .. 2025-09-07), DMR-2025-fall 12 days (2025-11-02 .. 2025-11-30), DMR-2026-summer 27 days (2026-07-17 .. 2026-08-30) | D44 / D45 / D46 reports |
| Engine | `lean-1.1` (D36 carve-out); D48 / D49 / D50 / D51 changed no generation, allocation or grading behavior | `ENGINE_VERSION` |
| Bucket | PROGRAM_ONLY on every day: ML sheet + program Bottom Line, no external source (backfilled days never run a consensus fetcher) | invariant 13 |
| Recipe | $200 bankroll, $5 per-race minimum, the day's own recipe on every run | run params |
| Refund share, as generated | $1,107.00 of $14,000.00 wagered (7.9%) across 157 refunded tickets; per meet: 2026-summer $542.00 of $5,400 (10.0%), 2025-summer $453.00 of $6,200 (7.3%), 2025-fall $112.00 of $2,400 (4.7%) | run #27 |
| Refund share, at the window | $0.00 - 599 entries scratched before generation across the 70 days (of 745 chart scratch rows; the rest were already SCRATCHED on the ML sheet) | run #39 |
| Live cross-check | run #27 (lean, as generated) reproduces the three backfill reports' live P/L to the cent: -$185.10 / -$1,247.70 / -$490.70 | D44 / D45 / D46 |

What the structure layer actually built under lean on these 70 days (run
#27 ticket census): 650 win (`split_primary_win`), 649 exacta_box
(`split_exacta_box`), 411 exacta (`mid_price_coverage`), 45 place
(`place_money_rule`). Zero tickets from `fade_favorite_price`,
`unanimous_exacta` / `keep_stacks`, `chaos_trifecta_box`, `longshot_on_top`,
`two_source_coverage`, `consensus_parlay`, `consensus_double`. Every race
classified SPLIT (capped, invariant 4) - there is no UNANIMOUS or CHAOS race
anywhere in the corpus.

## 2. The compare tables

Two modes (D50). **As generated** = the card built on the stored entries,
graded against the chart with refunds for the chart's scratches - what the
backfill cards are. **At the window** = the same day with the chart's
scratches applied before generation, zero refunds - the card a bettor at
the track would have built. The two modes are separate experiments and are
never pooled.

"vs lean" is the P/L delta against the lean run of the same mode and meet;
"paired" is better / worse / tied over the days both runs simulated (D51).
The four D18 templates (spread, no-fade, no-chaos-box, structure-only) tie
lean to the penny in every table - nothing they toggle fires on a
PROGRAM_ONLY day - and are listed once.

### 2.1 All meets, as generated (70 days)

| template | run | losing days | returned | P/L | ROI | max drawdown | vs lean | paired b/w/t |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lean | #27 | 46/70 | $12,076.50 | -$1,923.50 | -13.7% | $2,204.40 (2025-07-18 -> 2026-08-16) | - | - |
| spread / no-fade / no-chaos-box / structure-only | #28-#31 | 46/70 | $12,076.50 | -$1,923.50 | -13.7% | $2,204.40 | $0 | 0/0/70 |
| no-place-money | #32 | 47/70 | $12,086.10 | -$1,913.90 | -13.7% | $2,221.60 | +$9.60 | 7/13/50 |
| exacta-primary | #33 | 48/70 | $11,620.60 | -$2,379.40 | -17.0% | $2,701.20 | -$455.90 | 24/46/0 |
| no-exotics | #34 | 47/70 | $12,627.80 | -$1,372.20 | -9.8% | $1,632.10 | +$551.30 | 43/27/0 |
| box-depth-3 | #35 | 49/70 | $12,078.00 | -$1,922.00 | -13.7% | $1,911.70 | +$1.50 | 37/32/1 |
| best-bet-weighted | #36 | 49/70 | $11,542.80 | -$2,457.20 | -17.6% | $2,579.20 | -$533.70 | 20/50/0 |
| box-only | #37 | 46/70 | $12,215.40 | -$1,784.60 | -12.7% | $2,061.70 | +$138.90 | 53/9/8 |
| straight-only | #38 | 46/70 | $12,573.50 | -$1,426.50 | -10.2% | $1,707.40 | +$497.00 | 43/27/0 |

### 2.2 All meets, at the window (70 days, chart scratches applied)

| template | run | losing days | returned | P/L | ROI | max drawdown | vs lean | paired b/w/t |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lean | #39 | 45/70 | $11,893.20 | -$2,106.80 | -15.0% | $2,247.40 (2025-07-18 -> 2026-08-16) | - | - |
| spread / no-fade / no-chaos-box / structure-only | #40-#43 | 45/70 | $11,893.20 | -$2,106.80 | -15.0% | $2,247.40 | $0 | 0/0/70 |
| no-place-money | #44 | 46/70 | $11,894.60 | -$2,105.40 | -15.0% | $2,278.60 | +$1.40 | 7/11/52 |
| exacta-primary | #45 | 51/70 | $11,445.10 | -$2,554.90 | -18.2% | $2,755.10 | -$448.10 | 26/43/1 |
| no-exotics | #46 | 45/70 | $12,474.70 | -$1,525.30 | -10.9% | $1,676.20 | +$581.50 | 45/24/1 |
| box-depth-3 | #47 | 47/70 | $11,799.10 | -$2,200.90 | -15.7% | $2,197.60 | -$94.10 | 39/30/1 |
| best-bet-weighted | #48 | 47/70 | $11,357.70 | -$2,642.30 | -18.9% | $2,650.40 | -$535.50 | 18/50/2 |
| box-only | #49 | 46/70 | $12,046.00 | -$1,954.00 | -14.0% | $2,103.60 | +$152.80 | 53/9/8 |
| straight-only | #50 | 44/70 | $12,376.40 | -$1,623.60 | -11.6% | $1,779.40 | +$483.20 | 43/26/1 |

Wagered is $14,000.00 on every row of 2.1 and 2.2 (70 days x $200).

### 2.3 Per meet

P/L, vs lean and paired b/w/t per template; "gen" = as generated (runs
#27-#38), "win" = at the window (runs #39-#50).

**DMR-2025-summer, 31 days, $6,200 wagered**

| template | gen P/L | gen vs lean | gen b/w/t | win P/L | win vs lean | win b/w/t |
| --- | --- | --- | --- | --- | --- | --- |
| lean | -$1,247.70 (#27, 22 losing) | - | - | -$1,507.50 (#39, 23 losing) | - | - |
| no-place-money | -$1,303.00 (#32) | -$55.30 | 2/6/23 | -$1,576.30 (#44) | -$68.80 | 2/6/23 |
| exacta-primary | -$1,822.10 (#33) | -$574.40 | 9/22/0 | -$2,315.40 (#45) | -$807.90 | 9/22/0 |
| no-exotics | -$528.10 (#34) | +$719.60 | 22/9/0 | -$605.90 (#46) | +$901.60 | 23/8/0 |
| box-depth-3 | -$1,130.20 (#35) | +$117.50 | 19/11/1 | -$1,399.30 (#47) | +$108.20 | 19/11/1 |
| best-bet-weighted | -$1,254.90 (#36) | -$7.20 | 14/17/0 | -$1,497.30 (#48) | +$10.20 | 12/18/1 |
| box-only | -$1,188.90 (#37) | +$58.80 | 24/4/3 | -$1,460.70 (#49) | +$46.80 | 24/5/2 |
| straight-only | -$512.80 (#38) | +$734.90 | 23/8/0 | -$605.40 (#50) | +$902.10 | 23/8/0 |

**DMR-2025-fall, 12 days, $2,400 wagered**

| template | gen P/L | gen vs lean | gen b/w/t | win P/L | win vs lean | win b/w/t |
| --- | --- | --- | --- | --- | --- | --- |
| lean | -$490.70 (#27, 9 losing) | - | - | -$560.20 (#39, 9 losing) | - | - |
| no-place-money | -$509.10 (#32) | -$18.40 | 1/1/10 | -$578.60 (#44) | -$18.40 | 1/1/10 |
| exacta-primary | -$326.90 (#33) | +$163.80 | 5/7/0 | -$375.60 (#45) | +$184.60 | 7/5/0 |
| no-exotics | -$671.20 (#34) | -$180.50 | 6/6/0 | -$733.20 (#46) | -$173.00 | 6/6/0 |
| box-depth-3 | -$736.80 (#35) | -$246.10 | 5/7/0 | -$821.30 (#47) | -$261.10 | 5/7/0 |
| best-bet-weighted | -$654.00 (#36) | -$163.30 | 2/10/0 | -$723.00 (#48) | -$162.80 | 2/10/0 |
| box-only | -$464.20 (#37) | +$26.50 | 8/3/1 | -$527.70 (#49) | +$32.50 | 8/2/2 |
| straight-only | -$711.20 (#38) | -$220.50 | 6/6/0 | -$780.20 (#50) | -$220.00 | 6/6/0 |

**DMR-2026-summer, 27 days, $5,400 wagered**

| template | gen P/L | gen vs lean | gen b/w/t | win P/L | win vs lean | win b/w/t |
| --- | --- | --- | --- | --- | --- | --- |
| lean | -$185.10 (#27, 15 losing) | - | - | -$39.10 (#39, 13 losing) | - | - |
| no-place-money | -$101.80 (#32) | +$83.30 | 4/6/17 | +$49.50 (#44) | +$88.60 | 4/4/19 |
| exacta-primary | -$230.40 (#33) | -$45.30 | 10/17/0 | +$136.10 (#45) | +$175.20 | 10/16/1 |
| no-exotics | -$172.90 (#34) | +$12.20 | 15/12/0 | -$186.20 (#46) | -$147.10 | 16/10/1 |
| box-depth-3 | -$55.00 (#35) | +$130.10 | 13/14/0 | +$19.70 (#47) | +$58.80 | 15/12/0 |
| best-bet-weighted | -$548.30 (#36) | -$363.20 | 4/23/0 | -$422.00 (#48) | -$382.90 | 4/22/1 |
| box-only | -$131.50 (#37) | +$53.60 | 21/2/4 | +$34.40 (#49) | +$73.50 | 21/2/4 |
| straight-only | -$202.50 (#38) | -$17.40 | 14/13/0 | -$238.00 (#50) | -$198.90 | 14/12/1 |

## 3. The paired day counts, read across

Over all 70 days, in both modes, the templates sort into the same three
groups by paired days against lean:

- **Better on most days**: box-only 53/9/8 (#37, #49) - the most one-sided
  pairing in the corpus and the smallest dollar delta; no-exotics 43/27/0
  (#34) and 45/24/1 (#46); straight-only 43/27/0 (#38) and 43/26/1 (#50).
- **Worse on most days**: best-bet-weighted 20/50/0 (#36) and 18/50/2
  (#48); exacta-primary 24/46/0 (#33) and 26/43/1 (#45).
- **Mostly tied**: no-place-money 7/13/50 (#32) and 7/11/52 (#44) - the
  rule only touched 45 place tickets on 70 days; box-depth-3 37/32/1 (#35)
  and 39/30/1 (#47) - a coin flip day to day.

The ordering of every template against lean is the same in both modes.
The refund noise that motivated the at-the-window mode did not create any
of the findings below; it hid one (section 4.4).

## 4. Findings on this corpus

Each finding is a statement about engine `lean-1.1` on THESE 70
PROGRAM_ONLY days, with the caveats that apply to all of them in section 5.

### 4.1 The exotic leak is the split exacta box, not the $1 mid-price exacta

no-exotics (#34) is +$551.30 against lean on 43 of 70 days. The two
isolation templates split that figure: straight-only (#38, the box off,
the mid-price exacta kept) recovers +$497.00 on the same 43/27/0 day
pattern; box-only (#37, the box kept, the mid-price exacta off) recovers
+$138.90 on 53/9/8. At the window (#50 / #49) the same split holds:
+$483.20 vs +$152.80.

So the 649 exacta boxes (run #27) are where the money went, and the 411
$1 mid-price exactas are a steady bleed rather than a leak: dropping them
wins almost every day by a dollar or two, which is what a $1 ticket that
rarely hits looks like.

The box leak is a **DMR-2025-summer** result: +$734.90 on 23/8/0 there
(#38). In DMR-2025-fall the boxes paid - straight-only is -$220.50 on
6/6/0 (#38) and no-exotics -$180.50 (#34) - and in DMR-2026-summer the
box is a wash: straight-only -$17.40 on 14/13/0 (#38), no-exotics
+$12.20 on 15/12/0 (#34). One meet of 31 days carries the finding; one
meet of 12 days reverses it.

### 4.2 The program Best Bet is a negative allocation signal

best-bet-weighted (#36) moves the heavy weight onto the Bottom Line Best
Bet race and lands -$533.70 against lean on 20/50/0 paired days - worse in
every meet on paired days (14/17/0, 2/10/0, 4/23/0) and worst where the
corpus is otherwise closest to break-even (DMR-2026-summer, -$363.20).
At the window (#48) it is -$535.50 on 18/50/2. On this corpus, weighting
the day toward the handicapper's flagged race costs money in every meet.

### 4.3 Place money and box depth are dead knobs here

no-place-money (#32) is +$9.60 on 7/13/50: the rule wrote 45 place
tickets on 70 days because a program-only card rarely puts a win bet on an
8-1+ horse (the split's better-backed side is usually short). box-depth-3
(#35) is +$1.50 all meets on 37/32/1, with per-meet swings of +$117.50 /
-$246.10 / +$130.10 that cancel - it moves money around without edge in
either direction. Neither knob measures anything on this bucket; neither
result says anything about the rules on a bucket where they fire.

### 4.4 At the window, lean is worse, not better

lean at the window (#39, -$2,106.80) is $183.30 worse than lean as
generated (#27, -$1,923.50). The $1,107.00 that came back as refunds on
the backfill cards was money that, bet on live horses instead, lost more
than it returned - in DMR-2025-summer (-$1,507.50 vs -$1,247.70) and
DMR-2025-fall (-$560.20 vs -$490.70); DMR-2026-summer went the other way
(-$39.10 vs -$185.10). The "dead-money noise" in the backfill P/L was not
flattering the engine's opponents; it was flattering lean.

## 5. What is NOT concluded

- **No change to lean.** Nothing here proposes an engine edit. The split
  exacta box leaked on one 31-day meet, paid on a 12-day meet and washed on
  a 27-day meet; "remove the box" is one meet's answer, not the corpus's.
- **Nothing about the live engine's signal-driven rules.** Every race here
  was a capped SPLIT. `fade_favorite_price`, the unanimous exacta stack,
  `chaos_trifecta_box`, `longshot_on_top`, coverage adds, parlays and
  doubles wrote zero tickets on 70 days (run #27 census). They are
  untested, not vindicated and not indicted. The structure layer exercised
  here is exactly: primary win, split exacta box, mid-price exacta, place
  money.
- **The confidence-allocation question has one negative datapoint, not an
  answer.** best-bet-weighted keys the curve to one handicapper's flag on a
  bucket with no consensus. It says the Best Bet flag is a bad place to
  put the heavy weight; it says nothing about weighting by UNANIMOUS /
  SPLIT / CHAOS, which never varied here.
- **70 days, one track, three meets, one bucket.** The 2025-fall meet is 12
  days. Paired counts of 43/27 read as a lean, not a proof.
- **Nothing about the at-the-window mode as a policy.** Section 4.4 is a
  fact about this corpus's refunds, not a recommendation to bet scratches
  differently (D23's at-track scratch handling is its own deliverable).

## 6. The question the first FULL-consensus days must answer

The fall 2026 meet is the first corpus with a signal layer. The one
question this file hands it, to be answered with paired days at the window
before any exotic-construction change is proposed:

> **On FULL-consensus days built at the window, does `straight-only` still
> beat `lean` day by day - i.e. does the split exacta box still lose to
> the same money on the primary win ticket once the signal layer
> classifies the races, so that only genuine SPLIT races get boxed while
> UNANIMOUS races take the fade / unanimous exacta stack and CHAOS races
> the trifecta box?**

Measured as: the FULL bucket's compare row for straight-only vs lean, mode
chart_scratches_applied, all meets = the fall meet, paired b/w/t and the
P/L delta, with no-exotics and box-only beside it to check that the split
of 4.1 (box, not mid-price exacta) survives. A proposed pre-registered
reading, to be fixed before the days arrive: the finding of 4.1 transfers
only if straight-only is better on a clear majority of paired FULL days
AND the delta is positive over the meet; either alone is a lean. If the
box wins on FULL days, 4.1 was an artifact of boxing every race as a
capped SPLIT and the engine's construction stands.

Secondary: best-bet-weighted vs lean on the same FULL days (4.2 transfers
or not), and whether the place-money rule fires often enough on FULL days
to measure at all (4.3).

## 7. Provenance

- Runs #27-#38: every template, as generated, correlation
  `aaec9306-c6d0-4a82-bcb4-81523868bcb5`; runs #39-#50: every template at
  the window (`applyChartScratchesBeforeGeneration: true`), correlation
  `5bba3334-442e-4bad-abc4-3c3e3e3c94ce`. Both sets 2026-09-02, engine
  `lean-1.1`, each day's own recipe, produced through `runTemplate`
  (server/simulate.js) on the main database; one `simulation_run` trace
  event per run in the main decision trace.
- Tables: `GET /api/simulations/compare` and `?meet=DMR-2025-summer` /
  `DMR-2025-fall` / `DMR-2026-summer` on the same database (D51), read
  2026-09-02. Ticket census and refund figures: `simulation_results.details`
  for the runs named.
- The earlier set #17-#26 (2026-09-02, as generated, before D49-D51)
  agrees with #27-#36 to the cent and is superseded by this file's runs.
