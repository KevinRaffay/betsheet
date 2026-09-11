# Pick-source scoring: which sources name winners, with no money involved

**Status: ALL THREE PHASES DELIVERED - PS-1 (D220, #290), PS-2 (D221, #291), PS-3 (D222).** Each
phase claims its own with `npm run allocate-deliverable` when it is picked up,
the way `race-day-calendar.md` and `multi-parser-entries-ingest.md` were
worked. Written 2026-09-10 from a user question ("Does TrackMaster pick a lot
of winners? How many LLM-generated picks have horses that WPS?"). **Every
number below comes from a read-only query of the live corpus on that date,
non-deleted days only**, and every structural claim was checked against the
code rather than read off a plan.

## The question this serves

P/L already says whether a source MAKES MONEY. It cannot say whether a source
is LOOKING AT THE RIGHT HORSES, because a dollar figure folds the pick, the
bet type, the stake and the price into one number: a source that names the
winner in every race and prices it badly reads the same as a source that never
names it. The question here is the one underneath P/L, and it is answered
without money: for each source, how often does the horse it backed to win
actually win; to place, finish top two; to show, finish top three; and how much
of the real top three did it name anywhere on the ticket.

D170 already answers exactly this for tip sheets. This doc is about extending
the same measurement to every source that produces picks, and about the three
things that make a bare hit rate a lie.

## What was checked

### Already exists: D170 is this measurement, for one bucket

- `shared/tip-scoring.js` is pure, rank-based and money-free. `scoreTipRace`
  reports `win`/`place`/`show` for the top LIVE pick, `anyPickWon`,
  `top3Overlap` against `top3Possible`, scratches excluded from hit/miss, and a
  program number the result has never heard of surfaced as `unknownPicks`
  rather than scored as a loss. `aggregateTipScores` carries `n` and returns
  NULL, never 0, when there is nothing to divide by. `byTipSource` is the only
  total it produces; there is no pooled figure by construction.
- `server/tip-scoring.js` reads `tip_picks` against `race_results` and
  `result_scratches` DIRECTLY. It never touches a grade set or an
  `engine_version`, which is why it works on ungraded days.
- `GET /api/tip-scoring` (corpus-wide, per source, `?source=`/`?meet=`) exists
  and **no client code reads it**. The only UI is the per-day fetch in
  `RaceDayView.jsx` (`getTipScoring(dayId)`), rendered beside each race's
  tip sheets.

So "does TrackMaster pick winners" is built. What it has to work with:

| tip source | races on file | races with results |
| --- | --- | --- |
| trackmaster | 53 | 2 |
| numberfire | 52 | 2 |

Six of the eight tip-sheet days are 2026-09-10 (CD, IND, RP, TDN, WO, DEL),
all without results. Since D206 that is one "Pull results from Apify" click
per day.

### The other three buckets have tickets, not picks

`cards` carries no pick object for HUMAN, LLM_GENERATED or EQB_OTR. What it
carries is `tickets.selections`, stored as `{"races":[N],"legs":[["7"],["4"]]}`:
program numbers per leg, one leg per position for a straight exotic, one leg
holding the whole set for a box. `race_results` is keyed by
`(race_day_id, race_number, program_number)`. So a pick can be DERIVED from a
ticket by bet type, and scored against results the same way D170 does, with no
grading, no grade set and no engine version involved.

Per source, what the tickets say:

- **EQB_OTR** is structurally role-based, not ranked. `server/equibase-otr.js`
  writes a `show` ticket on the sheet's show pick, a `win` ticket on its win
  pick, and `exacta_box` tickets on its 4-horse and 3-horse boxes (lines
  194-206). There is no printed rank ORDER between the win pick and the show
  pick; the sheet names two horses for two purposes. D112 removed the
  `consensus_picks` rows this sheet used to write, so the tickets are the only
  live record of its picks.
- **LLM_GENERATED** is free-form. Across the 293 (card, race) pairs with a
  `win` ticket, **168 carry more than one win ticket** on the same race. A
  source that backs three horses to win and is scored "any win-backed horse
  won" is flattered against one that backs one.
- **HUMAN** has 7 races with results. **Included, user decision 2026-09-10**;
  it will not support a conclusion at that n, and the page says so by
  printing the n.

### Variant cards duplicate the same picks

| bucket | variants | cards | days |
| --- | --- | --- | --- |
| EQB_OTR | `some-reward`, `higher-reward`, `both` | 36 | 12 |
| TIPSHEET | `win-only`, `across-the-board`, `exacta-box-top2` | 48 | 8 |

Each OTR day is three cards carrying the same picks; each staked tip source is
three cards carrying the same `tip_picks` row. **Counting per card triples the
denominator** and is the same trap D175 fixed in the TIPSHEET P/L total. Deduped
to one row per (day, race, source), the real sample is:

| source | races with tickets | races with results |
| --- | --- | --- |
| EQB_OTR | 120 | 65 |
| claude-fable-5-1 | 89 | 45 |
| claude-sonnet-5 | 65 | 33 |
| claude-opus-5 | 35 | 21 |
| HUMAN | 12 | 7 |
| trackmaster (tip_picks) | 53 | 2 |
| numberfire (tip_picks) | 52 | 2 |

Results coverage, not code, is the gate: 7 of 17 live race days have results.

### LLM picks are derivative since D179

The LLM prompt now carries the day's OTR tickets and tip-sheet ranks
(`server/llm-prompt.js`, the block ending at line 405). In the stored requests,
**137 of 356 prompts included the OTR block and 9 included a tip sheet**.
Agreement between an LLM and OTR on those races is partly by construction, so
an LLM hit rate that is not labelled by what its prompt carried compares two
different experiments as one. The prompt text is stored verbatim in
`llm_card_requests.prompt_text` (D149), so the label is recoverable per request
without a migration: grep for the OTR line and the tip-sheet lines the prompt
builder emits.

### A baseline is free

Favorites win roughly a third of North American races. A source at 35% win is
not a finding until it is read against what the favorite did on the SAME races.
`entries.morning_line` is populated on 823 of 857 entries on days with results,
and `entries.morning_line_decimal` plus `shared/betmath.js`'s
`morningLineToDecimal` already exist. `entries.live_odds` cannot serve: D171
measured it filled on 0 of 13,710 rows, so the post-time favorite is
unavailable and the MORNING-LINE favorite is the only honest control. Field
size, from live entries in `entries` minus `result_scratches`, gives the random
baseline (1/field for win, 3/field for named-in-top-three).

## Decisions

Proposed here and confirmed by the user on 2026-09-10, including the two that
were asked rather than assumed (the primary pick, and HUMAN's inclusion).

1. **The unit is (race day, race number, source), never a card.** Source
   identity is `consensus_completeness` for OTR and HUMAN, `cards.llm_model`
   for LLM cards (a model is a source; D76's `byModel` breakdown already treats
   it that way), and `tip_picks.source_label` for tip sheets. Variant cards
   collapse to one row. **TIPSHEET cards are never scored; `tip_picks` rows
   are** (they carry ranks the cards flatten, and they exist on days that were
   never staked).
2. **Roles, not ranks.** Every source is reduced to the same shape per race:
   `winBacked`, `placeBacked`, `showBacked` (program-number sets, from `win`/
   `place`/`show` tickets) and `named` (every program number on any ticket for
   that race, boxes and straight exotics included). A `tip_picks` row maps rank
   1 to `winBacked` and ranks 1-3 to `named`; D170's `top3Overlap` is the same
   figure as `named ∩ real top three` for that source. OTR maps its win ticket,
   show ticket and box members directly. Ranks are not invented for sources
   that have none.
3. **Primary and any, side by side.** `winBacked` scores twice: the PRIMARY
   pick (the win ticket with the largest `stake_cents`; ties broken by lowest
   `sequence`) and ANY win-backed horse. The mean size of `winBacked` is
   reported next to both so a reader can see how much "any" is buying.
   **User decision 2026-09-10: largest stake is the primary pick**, because
   it is what the source put its money behind; first-written was the
   alternative and was not taken.
4. **Scratches follow D170.** A backed horse that scratched is excluded from
   hit/miss for that role, never counted a miss; a race whose every backed
   horse scratched scores NULL. A backed program number absent from both the
   result and the scratch list is surfaced, never scored.
5. **Two baselines on every source's rows, computed on that source's own
   scored races**: morning-line favorite (lowest `morning_line_decimal` among
   live entries; a tie counts a hit if any tied horse won) win/place/show, and
   the random rate from field size. A source's rate is only ever printed next
   to its baselines.
6. **LLM rows carry an inputs label**: `otr`, `tipsheet`, `both`, `none`,
   derived from the stored prompt text. The page groups by model AND label;
   there is no by-model total that pools labels.
7. **Sources never pool** (invariant 13's shape, as `byTipSource` already
   enforces). `n` rides on every rate; NULL, never 0, when n is 0.
8. **No money anywhere in it.** P/L exists; this is the measurement P/L cannot
   make. A stake is read only to pick the primary horse.
9. **Not a grade, not versioned.** Scores are recomputed on every read from
   `race_results`, exactly as tip scoring is. Nothing is stored, so a result
   correction or a re-pull changes the answer with no regrade step.

## The deliverable shape

Three phases, each its own PR and ledger row, each independently useful.

### PS-1: the pure adapter and scorer

- New `shared/pick-scoring.js`, pure and browser-safe like `tip-scoring.js`:
  `rolesFromTickets(tickets)` (one race's tickets to the role sets, decision
  2), `rolesFromTipPicks(picks)`, `scorePickRace({roles, finishers,
  scratched, entries})` returning the same fields D170 does plus `primary`,
  `any`, `winBackedCount`, `namedTop3`, and the two baselines from `entries`,
  and `aggregatePickScores`/`bySource` mirroring D170's aggregate and
  no-pooling shape. `scoreTipRace` is left untouched; the tip adapter proves
  the two agree on the rows they share.
- **Verification**: new `scripts/check-pick-scoring.js`, pure, hand-built
  races: an OTR-shaped ticket set, an LLM race with three win tickets (primary
  vs any differ), a box-only race (`winBacked` empty, `named` full), a
  scratched primary promoting nothing (NULL), a program number in no result,
  the favorite baseline with a tied morning line, and `rolesFromTipPicks`
  reproducing D170's `top3Overlap` on a real `tip_picks` row. A negative
  control: reverting the dedupe or the NULL-at-n=0 rule fails named
  assertions.

### PS-2: the read-only endpoint

- New `server/pick-scoring.js`, modelled on `server/tip-scoring.js` and
  `server/distribution.js`: `GET /api/pick-scoring[?meet=&track=]` returning
  `{bySource: [...], races: [...]}` where each race row names its day, race,
  source, inputs label, roles, hits and baselines, so every rate above it is
  re-derivable by hand. One query per bucket; `deleted_at IS NULL` on every
  one (invariant 12). Reads `tip_picks` for tip sources and `tickets` joined
  through `cards` for the rest; never reads a TIPSHEET card.
- **Verification**: extend the check script with a real-server section on a
  seeded temp DB, the way `check-race-calendar.js` does: one day carrying an
  OTR card in all three variants (asserted to produce ONE row per race), two
  LLM cards on different models with one prompt carrying the OTR block, a
  staked tip source (asserted to come from `tip_picks`, not its three cards),
  a soft-deleted day excluded and restored, and a day with no results
  contributing to `unscored` only. Then a run over the real corpus with the
  per-source `n` pasted into the ledger row.

### PS-3: the page

- New `/sources` route (`client/src/routes.js`, `App.jsx`, a button beside
  P/L and Distributions on `RaceDayList.jsx`) and
  `client/src/components/PickSourcesView.jsx` reading `getPickScoring()` from
  `api.js`. One table per source group, rows ordered by `n`, every rate cell
  printed as `hits/n (rate)` with the favorite and random baselines in
  adjacent columns, NULL rendered as a dash. A footer names the days with
  picks but no results, since that list is the thing that actually moves the
  numbers. Present the `/api/tip-scoring` figures here too rather than leaving
  that endpoint unread.
- **Verification**: presentation-only, `npm run build` and
  `check-module-bindings`, browser-verified in the agent's `dev:preview` stack
  against a seeded throwaway DB (never the human's), including that the
  variant dedupe shows one OTR row per race on screen.

## What the first real run will and will not say

- OTR at n=65 supports a rough read against the morning-line favorite on the
  same 65 races. That is the only comparison in the corpus today with enough
  rows to be worth a sentence.
- The three LLM models at 21 to 45 races each will not separate from one
  another, and the inputs label will split them further.
- TrackMaster and NumberFire say nothing at n=2. Pulling results for the six
  2026-09-10 days moves them to roughly 50 each.
- HUMAN at n=7 is a row, not a finding.

Per the findings discipline: label everything, conclude nothing until n is
stated. No findings file is written by this work; a findings file follows a
corpus, not a tool.

## What this deliberately does not do

- **No money.** No P/L, no ROI-at-a-price, no "what if you had bet the
  favorite". P/L views already own money, bucketed by completeness.
- **No exotic hit rates beyond "named".** Whether an exacta box hit is a
  grading question and `graded_tickets` already answers it; scoring it again
  here would re-derive a grade under a different name.
- **No live odds.** `entries.live_odds` is empty corpus-wide (D171); the
  favorite baseline is the morning-line favorite and is labelled as such.
- **No stored scores, no schema change.** Nothing in `cards`, `tickets` or
  `tip_picks` changes; no migration; no new bucket.
- **No pooled "all sources" figure**, and no ranking of sources against each
  other on different race sets. Two sources are only comparable on the races
  they both scored, and the page shows the overlap count rather than
  implying one.
- **Nothing on the soft-deleted lean-era corpus.** Those cards were produced
  by the deleted engine under buckets this measurement does not read.
