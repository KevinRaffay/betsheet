# Post-time odds vs the morning line: can the LLM find an edge as odds move?

**Status: EVALUATED, NOT SCHEDULED.** No deliverable number is claimed - the
convention `docs/requirements/pick-source-scoring.md` follows, where each phase
claims its own with `npm run allocate-deliverable` when it is picked up.
Written 2026-09-11 from a user thesis:

> Over a corpus of entries and results, the LLM bets generated at post time are
> better than the bets placed with the M/L. The post-time odds would be updated
> prior to generating. The goal is to see if the LLM creates an edge as odds
> move. All inputs would be the same, the thing that changes is the odds fed to
> the LLM.

**Provenance of every number below.** This evaluation was written in a cloud
session with no access to `data/betsheet.sqlite`, so *nothing here was queried
live*. Every structural claim is cited to a file and line in this repository and
was re-read rather than recalled. Every corpus figure is quoted from a document
that DID query the live corpus on the date it names - `docs/requirements/pick-source-scoring.md`
(2026-09-10) and the D221 ledger row's own read-only corpus run (2026-09-10) -
and is attributed as such. Re-run those reads before acting on any of it.

---

## The verdict, up front

The thesis is **well-posed, worth testing, and not testable today** - and the
three reasons are independent, so fixing one does not unblock the others.

1. **The input does not exist.** Post-time odds are absent from every table and
   every live ingestion path in this codebase. Not thin, not stale - zero rows.
   Section 1.
2. **The headline metric the thesis implies cannot be powered.** At the corpus's
   ~99 LLM races with results, the smallest ROI difference detectable at 80%
   power is about **68 percentage points**. Getting to 5 points needs on the
   order of **18,000 races**. Section 3.
3. **The comparison as stated is confounded in the direction of a false
   positive.** Post-time odds are strictly more informative than a morning line,
   so the post-time arm should win on any hit-rate measure *whether or not the
   model added anything*. Section 2.

None of that kills it. What survives is a **smaller, cheaper, better-posed
question that the existing corpus can almost answer**, and a data-collection
step that is the real prerequisite for the full version. Section 4 proposes five
phases; PT-0 and PT-1 are worth doing regardless of whether the rest ever is.

---

## 1. What was checked: the data

### 1.1 Post-time odds are nowhere in the corpus

Four separate paths, all empty or dropping the field:

- **`entries.live_odds` / `live_odds_decimal` exist and are empty.** The columns
  were added by migration 024 and survive the 032 rebuild
  (`server/migrations/032-entries-program-number-nullable.sql:56-57`).
  `shared/tip-staking.js:18-20` records the measurement: *populated on 0 of
  13,710 rows across 0 of 169 race days*. `shared/pick-scoring.js:112-114` and
  the D220 ledger row both cite the same finding as the reason the
  morning-line favorite - not the post-time favorite - is this project's only
  honest market baseline.
- **The Equibase entries page cannot fill them.** `shared/parsers/equibase-entries.js`
  reads a `LiveOdds` column when one is present, but
  `docs/requirements/equibase-entries-ingest.md:67` records that the column was
  **empty in all 113 entries** of the verified capture - an entries page saved
  before wagering opened - and open question 2 (line 182) says a capture taken
  close to post has never been made. `scripts/check-equibase-entries.js:123`
  asserts live odds are null on every fixture entry, so the branch has never been
  exercised against real data.
- **The Apify entries actor never provides them.**
  `shared/parsers/equibase-apify-parseforge.js:235-236` sets `liveOdds` and
  `liveOddsDecimal` to `null` unconditionally, and the registry declares them in
  `fieldsNotProvided` (`shared/parsers/registry.js:150`). This matters more than
  it looks: Apify is the low-friction ingestion path this project actually uses
  now (D197/D198/D202), so the default route to new race days is structurally
  incapable of carrying odds.
- **The Apify results actor never provides them either.**
  `shared/parsers/equibase-apify-results.js:42-43`: *"jockey, trainer, weight and
  win odds per finisher are never present."* So D206's one-click results pull
  cannot backfill them.

### 1.2 The chart parser already extracts them; the schema throws them away

This is the one genuinely cheap opening.

`shared/chart-parser.js:57-68` - the parser for pasted Equibase chart text -
already finds the odds token on every finisher line and returns
`odds: Number(...)` plus `favorite: <bool>` for the asterisked chalk. Those are
the **real post-time odds, per starter**, which is exactly the quantity the
thesis needs.

They are then discarded. `race_results` has no odds column
(`server/migrations/001-initial.sql`, and no later migration adds one - `grep
odds server/migrations/*.sql` hits only `tickets.odds_at_bet`, the entries-side
columns, and `tip_picks`), and `saveResults` inserts eight columns that do not
include it (`server/results.js:64-67`). The same comment in the Apify results
parser notes this explicitly: *"this is not a gap against what `race_results`
persists, since none of those are stored columns; chart-parser.js only extracts
them in passing."*

**So a migration plus a passthrough in one INSERT recovers a per-starter
post-time odds board for every day ingested through the paste/PDF chart route.**
That is the smallest useful change in this whole evaluation.

Two caveats, both real:

- **It only helps on re-ingest.** `result_charts` stores `raw_digest`, not the
  raw text (`server/migrations/001-initial.sql:161-168`), and nothing archives
  chart pastes to disk - `BETSHEET_RAW_DIR` survives only in
  `scripts/check-dmtc-results.js` and the OTR PDF archive
  (`server/equibase-otr.js:127-136`). Already-stored days must have their charts
  re-pasted; the charts are still on Equibase, so this is manual work, not lost
  data.
- **It does not help the Apify-sourced days at all** (1.1, fourth bullet).
  Whatever fraction of the live corpus came in through D196/D206 needs a
  different source for odds.

### 1.3 Corpus size is the binding constraint

From `docs/requirements/pick-source-scoring.md`'s live read (2026-09-10),
deduplicated to one row per (day, race, source) - its own table triples if you
count per card:

| source | races with tickets | races with results |
| --- | --- | --- |
| claude-fable-5-1 | 89 | 45 |
| claude-sonnet-5 | 65 | 33 |
| claude-opus-5 | 35 | 21 |
| **LLM total** | **189** | **99** |
| EQB_OTR | 120 | 65 |
| HUMAN | 12 | 7 |

*"Results coverage, not code, is the gate: 7 of 17 live race days have results."*

**~99 LLM races with results, across 7 race days, is the ceiling on anything
retrospective.** Every power figure in section 3 is read against that number.
Note also that 7 days is far too few clusters for day-level inference: races on
one card share a track, a surface, a takeout and a day's weather, so the
effective independent sample is nearer 7 than 99 for anything that varies by
day.

### 1.4 What the LLM's picks currently do

From the D221 ledger row's read-only corpus run (2026-09-10), win hit rate of
the *primary* pick (the largest-staked win ticket) against the morning-line
favorite on the same races:

| group | primary win | ML favorite, same races |
| --- | --- | --- |
| claude-fable-5-1 [none] | 9/39 (23%) | 15/39 (38%) |
| claude-sonnet-5 [none] | 12/33 (36%) | 12/34 (35%) |
| claude-opus-5 [none] | 5/18 (28%) | 7/22 (32%) |

At these n's none of those gaps is significant, and the scope doc says so
(*"The three LLM models at 21 to 45 races each will not separate from one
another"*). But the direction matters for the thesis: **the LLM's win pick is
not currently naming winners more often than the cheapest possible market
proxy.** That is the starting point any odds arm has to improve on, and it is
the reason section 2's confound is not academic.

---

## 2. Three things that would make the answer a lie

### 2.1 Post-time odds are better information, so the post-time arm wins by construction

The morning line is one person's pre-entry guess. Post-time odds are the
aggregated money of everyone betting the race, after scratches, after the paddock,
after the late money. On any measure of *naming winners*, the post-time arm
should improve even if the model contributes nothing at all - it is being handed
a better prior and copying it.

So **a hit-rate win by the post-time arm is not evidence of edge.** It is
evidence that the market beats the morning line, which is already known and has
nothing to do with the LLM.

Edge means beating the price you are paid at. The only metrics that can show it:

- **ROI at real chart payouts.** Correct, and unpowerable here (section 3).
- **Beat-the-close**: for every horse backed, compare the outcome against the
  win probability its own post-time odds imply. `sum(1{won} - q)` over backed
  horses, where `q` is the takeout-normalised implied probability. Zero means
  "you are the market". This is the standard closing-line test, it needs the
  same backfill as ROI, and it strips the payoff magnitude out of the variance.

Both need baselines computed on **the same races**: the post-time favorite, the
morning-line favorite (`shared/pick-scoring.js`'s `favoriteBaseline` already
computes the second), and the random 1/field rate. The project's own rule already
demands this - *"A source at 35% win is not a finding until it is read against
what the favorite did on the SAME races"* (`pick-source-scoring.md:122`).

### 2.2 Final odds are not odds you could have bet into

Pari-mutuel is unusually kind to this thesis: you are paid the FINAL price
whatever time you bet, so a decision made on final odds is not the fantasy it
would be in fixed-odds betting. But it is still optimistic. Nobody can wager at
0 MTP, and the last flash moves prices - hardest on longshots, where late money
routinely takes a 10-1 morning board price to 7-1 after the gate opens.

**So a backfilled post-time arm is biased upward, in one direction, by an
unknown amount.** That is tolerable for a first read as long as it is labelled,
and it is the one thing only a live capture (PT-4) can size: capture the board at
2 MTP as well as reading the chart's final, and the gap between them IS the bias.

### 2.3 The most likely real effect is "more chalk", which loses slower rather than winning

Handed the market's opinion, a language model is likely to move toward it. In
pari-mutuel, agreeing with the market is a systematically losing strategy after
15-20% takeout - favorites are the least-bad bet, not a good one. A plausible
outcome of the whole experiment is that the post-time arm picks more winners and
makes less money, which is the opposite of what the thesis predicts and is worth
pre-registering as the alternative hypothesis before any call is paid for.

**This is why the interesting arm is the third one.** The user's own framing is
*"as odds move"* - the signal is the DRIFT between the morning line and the
post-time board (the steamed horse, the drifter), not the level of either. An
arm that sees only post-time odds cannot see drift; it has nothing to compare
against. Section 4's Arm C shows the model both and is the arm that actually
tests the stated thesis.

---

## 3. Power: what n each metric needs

Paired by race (same race, same model, same prompt, different odds), two-sided,
alpha 0.05, 80% power, so `n = 7.85 x sigma_d^2 / delta^2`. Assumptions are
stated so each row is checkable and arguable:

| metric | per-bet SD | paired SD (rho) | n for 5pp | n for 10pp | MDE at n=99 |
| --- | --- | --- | --- | --- | --- |
| ROI, $1 win bet | ~2.2 | 2.41 (0.4) | ~18,200 | ~4,600 | **~68 pp** |
| win hit rate, primary pick | 0.458 | 0.458 (0.5) | ~660 | ~165 | **~13 pp** |
| beat-the-close, `1{won} - q` | ~0.43 | 0.43 (0.5) | ~590 | ~147 | **~12 pp** |

ROI SD is from a 29%-strike primary pick at an average winning payoff near 5-for-1
(`Var = 25 x 0.29 x 0.71 = 5.15`); the 29% is D221's measured LLM primary rate
(1.4). **Exotics are far worse** - a trifecta's per-ticket return SD is an order of
magnitude larger again - so a card-level ROI that pools win bets with boxes has
*less* power than the ROI row above, not more.

Three things fall out of that table:

- **ROI is out.** 68 percentage points is not a measurement, and 18,000 races is
  roughly 1,500 race days. Any claim of the form "the post-time arm made more
  money" on this corpus would be noise with a number attached, which is the exact
  failure the findings discipline's *"no P&L figure without its n"* rule exists
  to prevent - and which the pivot's own motivating anecdote (1 card, 3 graded
  tickets) already demonstrated once.
- **Beat-the-close is not much lower variance than hit rate.** Its advantage is
  that it removes the 2.1 confound, not that it buys power. Worth being precise
  about, because the reverse is easy to assume. Against ROI, though, it is a
  ~36x reduction in variance, which is the difference between 18,000 races and
  590.
- **A one-sample question is already almost powered.** "Does the ML-only LLM beat
  the close?" is a single-arm test needing no second generation at all: at n=99
  it detects a ~12 pp gap between how often the picks won and how often their own
  prices said they would. Section 1.4's numbers make a gap that size entirely
  plausible. **This is the cheapest real result available and it costs zero API
  calls** - see PT-1.

---

## 4. What is actually checkable, in order

### PT-0 - Does the model even agree with itself? (pilot, ~$2)

`DEFAULT_REQUEST_PARAMS` is `{maxTokens: 4000, temperature: 1}`
(`server/anthropic-client.js:47`), and **temperature cannot be pinned to 0**:
D166 found that newer models answer a 400 to `temperature: 0`, and the gotcha in
CLAUDE.md records it. Generation is irreducibly stochastic.

So before any A/B, measure the within-arm noise: generate the SAME race from the
SAME prompt k=5 times, on ~20 races, and report how often the primary pick
changes. **If the model disagrees with itself on half the races, a
one-generation-per-arm A/B at n=99 is measuring sampling noise and nothing else**,
and every later phase needs k replicates per arm (which multiplies its cost by k
and its effective n by rather less).

Cost: 100 Sonnet calls. At the measured prompt size - `SYSTEM_PROMPT` is 8,894
chars, ~2,300 tokens, plus ~300 for a race's entries and menu - and with adaptive
thinking billed as output, a call is roughly 2,600 in / 1,500 out: about $0.02 on
`claude-sonnet-5` ($2/$10 per Mtok), $0.05 on `claude-opus-5`, $0.10 on
`claude-fable-5-1`. Ceiling at `maxTokens: 4000` is $0.045 on Sonnet.

This phase needs no odds, no backfill and no schema change. It can be run today.

### PT-1 - Does the EXISTING corpus beat the close? (no API calls)

Backfill post-time odds (1.2: a migration adding `race_results.post_time_odds`
and `favorite`, plus the passthrough in `saveResults`, plus re-pasting charts for
the 7 days that have results), then compute beat-the-close over the ~99 stored
LLM races, alongside the post-time favorite and the morning-line favorite on the
same races.

This is a pure extension of `shared/pick-scoring.js` - the module already scores
picks against results with no money, no grade set and no engine version, and
already computes a favorite baseline. It reports a rate with its own `n` or NULL,
never 0, which is the shape this answer needs.

**PT-1 is the decision point.** If the ML-only LLM is already at or above the
close, there is edge to sharpen and PT-2 onward are worth paying for. If it is
well below - which 1.4's direction suggests - then feeding it the market's own
opinion is more likely to make it a more expensive index fund than to create an
edge, and that is worth knowing for the cost of a migration.

### PT-2 - Deepen the corpus (the real prerequisite)

Section 3 says the odds A/B wants several hundred races with results, against 99
today. Two levers:

- **Pull results for the 10 live days that lack them.** D206 made this one click
  per day. Cheapest available n.
- **Add days.** Each needs BOTH halves: entries (for the morning line, which no
  chart prints) and a chart (for results and, post-1.2, odds). Neither Apify path
  carries odds (1.1), so chart days must come through the paste route until that
  changes.

Getting to ~300 races is roughly 25 days with results; to ~600, roughly 50. State
the target before starting, and re-read section 3's table against it rather than
deciding afterwards what the n supports.

### PT-3 - The three-arm generation, once PT-0 and PT-2 allow it

Same races, same model, same template version, k replicates each:

- **Arm A - morning line only.** The status quo prompt, byte-identical.
- **Arm B - post-time odds replace the morning line.** Isolates "a better price
  estimate".
- **Arm C - both shown, labelled.** The model can see the drift. **This is the
  arm that tests the stated thesis**; B vs A cannot distinguish "better prior"
  from "movement is informative", and C vs B isolates the drift itself.

Four things must be held fixed or the arms differ by more than the odds:

1. **The per-race bankroll must be frozen.** `perRaceBankrollCents` is
   `(bankroll - spent so far) / races remaining`, recomputed per call
   (`server/llm-cards.js:154`, and `docs/prompts/llm-card-v1.md` deviation 2), so
   race N's budget depends on what arm A or C happened to spend on races 1..N-1.
   **That makes the arms diverge on a second axis.** Use a flat
   `bankroll / raceCount` for the experiment and say so.
2. **Baseline inputs must be held constant.** D179 puts the day's OTR tickets and
   tip-sheet ranks in the prompt, and *137 of 356 stored prompts carried the OTR
   block* (`pick-source-scoring.md:112`). D221 already treats the inputs label as
   part of the group key. Fix it - the cleanest choice is `none` for every arm.
3. **Notes must stay off.** `persistLlmRace` already fails closed here: a
   non-interactive caller with notes present is refused 409 rather than silently
   dropped (`server/llm-cards.js:162-167`). A batch runner inherits that for free;
   do not defeat it.
4. **Do not compare against the stored 293-race corpus.** LLM cards have no
   version axis - `engine_version` is the literal string `'llm'` for all of them -
   so any prompt change silently makes new cards incomparable with old ones, as
   `server/llm-prompt.js`'s own D112/D125 comments record. All three arms must be
   generated fresh, in one run, under one `PROMPT_TEMPLATE_VERSION` (today
   `d77fc1f078fa`, a hash of `SYSTEM_PROMPT` - D149, so it labels itself).

There is no batch generation harness: the only route is
`POST /api/race-days/:id/llm-cards/preview`, one race per call
(`server/llm-cards.js:516`). One is needed, and the `interactive` flag's own
comment says a future one was anticipated.

Cost at 99 races x 3 arms x 3 replicates = 891 calls: ~$18 on `claude-sonnet-5`,
~$45 on `claude-opus-5`, ~$90 on `claude-fable-5-1` ($40 worst case on Sonnet if
every call runs to `maxTokens`). **Money is not the constraint here - n is.**

### PT-4 - Live capture, to size the 2.2 bias and to make it real

A capture of the Equibase board near post fills `entries.live_odds` - the column
has existed since migration 024 and has never held a row - and
`race_days.odds_captured_at` plus D117's staleness indicator already exist to
label how stale each race's capture is. Capturing at ~2 MTP *and* reading the
chart's final gives the size of 2.2's optimism directly, and is the only version
of this thesis that is a strategy rather than a study.

Invariant 6 governs how: BetSheet fetches nothing itself, so this is either a
saved page a person uploads or the D197-style Apify exception, explicitly
triggered, never scheduled.

---

## 5. Open questions for whoever schedules this

1. **Is PT-1's answer on its own enough to stop?** It costs a migration and some
   chart re-pasting and no API calls. If the ML-only LLM is well below the close,
   is that a stop, or does the thesis survive it on the argument that the model
   was never given the information needed to beat a price it could not see?
2. **Which model?** Section 1.3's corpus splits three ways, and a three-model
   sweep triples PT-3. One model held fixed is the powered choice; `claude-sonnet-5`
   is the cheapest and has the corpus's best current showing (12/33 vs a 12/34
   favorite), but that is 33 races and not a reason.
3. **Win bets only, or the whole card?** Section 3's ROI row is already hopeless
   and exotics make it worse. Restricting the measured quantity to win tickets
   keeps beat-the-close computable; the model may still WRITE exotics.
4. **What n is the target before PT-3 is paid for?** Naming it up front is the
   difference between a finding and a number.

---

## 6. What this deliberately does not do

- **No claim about which arm wins.** Nothing has been generated and nothing has
  been measured. Section 2.3 states the alternative hypothesis precisely so it
  cannot be quietly dropped if the result goes that way.
- **No new findings file.** A findings file follows a corpus, not a plan - the
  same rule `pick-source-scoring.md` closes on.
- **No live query.** Every corpus figure here is quoted with its source and its
  date (see the provenance note at the top) and should be re-read before use.
- **No change to grading or P/L.** `shared/grading.js` already grades against the
  chart's real payouts, so ROI is correctly measured whatever odds the prompt
  carried; only its VARIANCE is the problem. Note in passing that
  `estimateTicketPayouts` reads `morning_line_decimal`
  (`docs/requirements/equibase-entries-ingest.md:126-129`), so a post-time arm's
  stored payout ESTIMATES would still be morning-line-based - cosmetic, not a
  grading defect, but it would look wrong on a card sheet.
- **No relaxation of invariant 13.** Anything generated by PT-3 is
  `LLM_GENERATED` and pools with no engine bucket; the arm is a label on the run,
  not a new completeness tier.
