# Decision-trace schema

The decision-trace stream (`server/logs/decision-trace.jsonl` + rotations)
and the card export document built from it. This is the Phase 3 feed: give
an LLM one export and it can replay "given these inputs, the algorithm
decided X because Y — and it earned Z" for every dollar on the card
(invariant 7).

Versioning: the export document carries `export.schemaVersion` (currently
**1**, `SCHEMA_VERSION` in `server/trace-export.js`). Bump it whenever the
shape of the export or the meaning of an event changes; adding a new event
type is backward-compatible and does not bump it.

## Log-line envelope

Every line in every stream is one JSON object:

| field | meaning |
| --- | --- |
| `ts` | ISO-8601 append time |
| `level` | debug / info / warn / error |
| `stream` | `app`, `fetch-audit`, or `decision-trace` |
| `event` | event name (catalog below) |
| `correlationId` | the card-session id (invariant 8) — one per card, stamped on every event that belongs to it |
| ...fields | event-specific, listed below |

Engine events also carry `seq` — a 0-based, gap-free counter within one
generation run. A gap in `seq` for one correlationId means trace loss,
which is a bug. Server-side wrapping adds `cardId` and `raceDayId` to every
engine event.

## Event catalog

### Card generation (emitted by `shared/card-engine.js`, streamed by `server/cards.js`)

| event | fields | meaning |
| --- | --- | --- |
| `inputs_snapshot` | `engineVersion`, `bankrollCents`, `perRaceMinCents`, `raceCount`, `entries[{race, entries}]`, `sourcesUsed`, `sourcesUnavailable`, `template`, `rules` | everything the run saw, first event (`seq` 0). `template` is the strategy-template name (D18, null for direct engine calls); `rules` is the full resolved rule set after template + explicit overrides. |
| `consensus_table` | `race`, `table` | the per-horse vote table the classification was computed from |
| `race_classified` | `race`, `classification` (UNANIMOUS/SPLIT/CHAOS/GUESS), `externalSourceCount`, `cappedFromUnanimous`, `topVotes`, `contrarianFlags` | the signal-layer call and the votes behind it |
| `completeness_decided` | `completeness` (FULL/PARTIAL/PROGRAM_ONLY/ODDS_ONLY), `externalSourcesPerRace`, `programAnalysis` (any program rank on the day) | the card's consensus-completeness bucket (invariant 13) |
| `rule_fired` | `rule`, `reason?`, rule-specific fields (`race`, `horse`, `stakeCents`, `reserveCents`, ...) | a structure-layer rule acted. Rules: `multi_race_reserve`, `guesswork_minimum`, `fade_favorite_price`, `win_bet`, `longshot_on_top`, `hedge_cut`, `two_source_coverage`, `mid_price_coverage`, `place_money_rule`, `place_money_carve_out`, `best_bet_weight` (D48: the best-bet allocation curve put the heavy weight on the program Best Bet race; `weight`) (D36: an 8-1+ win and its place money sized INSIDE the allocation - `fromCents`, `toCents`, `allocatedCents`, `exoticCents`), `ml_order_fallback` (a race with no program analysis and no external picks ranks by morning line, D40) |
| `rule_suppressed` | `rule`, `reason`, `race?`, rule-specific fields (`horse`, `ml`, `second`, `backers`, `horses`, `strongRaces`) | a rule was evaluated and DECLINED (D48) - so "never fired" and "never evaluated" are distinguishable in the corpus. Machine-readable reasons: `disabled_by_template` (any rule); `fade_favorite_price`: `no_algo_order` (no external source on the day - PROGRAM_ONLY / ODDS_ONLY), `not_unanimous`, `above_odds_on`, `no_morning_line`, `no_exotic_tickets`; `chaos_trifecta_box`: `not_chaos_classification` (per race), `no_chaos_race` (once per card, no race field), `insufficient_horses`, `no_exotic_tickets`; `hedge_cut`: `not_split_classification`, `no_second_choice`, `sufficient_backing` (the second win bet was placed); `split_exacta_box` / `unanimous_exacta`: `no_exotic_tickets`, `no_third_pick` (box-depth-3 with only two ranks), `disabled_by_template` on `split_exacta_box` alone when `hedgeBoxDepth` is 0 (D49 straight-only: the box is off, the mid-price straight exacta still fires); `mid_price_coverage`: `no_mid_priced_horse`, `no_exotic_tickets`; `two_source_coverage`: `no_multi_source_horse`, `no_exotic_tickets`; `longshot_on_top`: `no_live_longshot`, `no_exotic_tickets`; `place_money_rule`: `below_odds_threshold` (per win ticket, with `ml`), `no_morning_line`; `multi_race_reserve`: `fewer_than_two_strong_races`; `best_bet_weight`: `no_best_bet` (best-bet curve on a day without a Best Bet); `win_bet`: the fade's free-text reason (pre-D48) |
| `allocation_decided` | `race`, `amountCents`, `confidence`, `rule` | the per-race allocation and which weighting produced it |
| `ticket_added` | `race` (null for multi-race), `races`, `betType`, `selections` (legs), `stakeCents`, `costCents`, `rules` (provenance tags) | one ticket landed on the card |
| `remainder_distributed` | `remainderCents`, `passes`, `races[{race, amountCents, steps, ticket, withPlace, allocatedCents}]`, `skipped[{race, reason}]` (`no_win_ticket` / `guesswork_floor` / `stake_held_by_template` - D48: a race whose win stakes a template holds at the minimum steps its exacta box instead (one base unit a step), and its straight exacta for the last odd dollar; `ticket` then names that ticket; a held race with neither is skipped), `undistributedCents` | how the gap between the bankroll and the constructed tickets was spread: deficits toward each race's own allocation first (D36), then round-robin $1 steps onto each race's primary win ticket (`withPlace` = the place-money pair moved with it, $2 a step), larger allocations first, at most one step per race per pass; guesswork races only when nothing else can take the money. Emitted only when there was a remainder. `undistributedCents` is non-zero only when minimums made an exact match impossible |
| `bankroll_balanced` | `adjusted`, `remainingCents` | the exact-bankroll balancing pass (invariant 2); follows `remainder_distributed` |
| `card_finalized` | `engineVersion`, `totalCents`, `bankrollCents`, `ticketCount`, `completeness`, `perRace[{race, allocatedCents, spentCents}]`, `warnings` | last generation event; totals as persisted |

### Grading (emitted by `server/grading.js`, under the CARD's correlationId)

| event | fields | meaning |
| --- | --- | --- |
| `ticket_graded` | `cardId`, `ticketId`, `engineVersion` (the grader's version), `betType`, `races`, `legs`, `outcome` (win/refund/partial/loss), `costCents`, `returnedCents`, `plCents`, `note` | one ticket scored against the day's chart |
| `card_graded` | `cardId`, `gradedBy` (the triggering session's correlationId), `engineVersion`, `costCents`, `returnedCents`, `plCents`, `outcomes`, `topTicketShare` | the card summary. A regrade replaces DB rows but appends here — the log keeps every grading pass |

### Human cards (D54, emitted by `server/human-cards.js`, streamed under the card's correlationId)

A human's pasted tickets, not the engine, produced these - no `inputs_snapshot`/`rule_fired`/`allocation_decided` events exist for a human card, since `shared/card-engine.js` is never called.

| event | fields | meaning |
| --- | --- | --- |
| `card_generated` | `cardId`, `raceDayId`, `engineVersion` (`'human'`), `template` (`'human'`) | the human card's first race lock, on card creation only (append-only, D28) |
| `ticket_added` | `cardId`, `raceDayId`, `race`, `betType`, `selections` (legs), `stakeCents`, `costCents`, `rationaleText` | one human ticket landed on the card, carrying the pasted rationale verbatim |
| `human_race_locked` | `cardId`, `raceDayId`, `race`, `pass` | one race's picks were locked (or explicitly passed) on a human card - the timestamp this event's `ts` field carries is the same one written to `human_race_state.picks_locked_at`, the fact a later blindness computation (D55) is derived from |

### Simulation (emitted by `server/simulate.js`, one correlationId per POST /api/simulations)

| event | fields | meaning |
| --- | --- | --- |
| `simulation_run` | `runId`, `template`, `applyChartScratchesBeforeGeneration` (D50), `params` (`bankrollCents`, `perRaceMinCents`, `startingBankrollCents`, `applyChartScratchesBeforeGeneration`, `scratchesApplied` - entries scratched before generation across the run, `days`), `buckets[{completeness, days, tickets, wins, costCents, returnedCents, plCents, losingDays}]`, `days[{raceDayId, date, track, completeness, plCents}]` | one strategy template replayed over every non-deleted day with results (D19). The engine and grader are pure, so the per-ticket detail (persisted in `simulation_results.details`) is reproducible from the day + template + mode; the event records the recipe and the outcome. `applyChartScratchesBeforeGeneration` (D50, default false) = the card was built with the day's chart scratches (result_scratches, the rows grading refunds key on) already applied to the entries - the at-the-window baseline; grading is unchanged. The two modes are different experiments: reporting never pools them. Buckets never pool (invariant 13). Carries no `cardId`, so it never appears in a card export. |

### Day lifecycle (emitted by `server/ingest.js` / `server/results.js`, under the day's own correlationIds)

| event | fields | meaning |
| --- | --- | --- |
| `results_saved` | `raceDayId`, `track`, `date`, `results`, `exotics`, `scratches` | a chart landed (and auto-graded every card of the day) |
| `race_day_deleted` | `raceDayId`, counts | soft delete; the trace files are never touched (invariant 12) |
| `race_day_restored` | `raceDayId` | restore from the deleted list |
| `race_day_superseded` | `raceDayId`, `supersededRaceDayId`, `supersededCorrelationId`, `supersededWasDeleted` | re-ingest replaced a prior day; old ids stay resolvable here |
| `backfill_day` | `runId` (the run's correlationId), `date`, `meet`, `status` (saved / queued / skipped / resolved / regenerated / missing / failed / halted / would-*), `note`, `raceDayId`, `cardId`, `queueId`, `blocking[]`, `nonBlocking[]` (warning types), `completeness`, `engineVersion`, `crossSource {tickets, agree}` | one per race day the batch backfill (D43) decided, under the DAY's correlationId (the same id its race_days row carries) |
| `backfill_queue_decided` | `queueId`, `date`, `meet`, `decision` (confirmed / rejected), `note`, `raceDayId`, `cardId`, `blocking[]` | the human decision on a queued day (invariant 9 batch policy A), under the day's correlationId; a confirm is followed by the ordinary `race_day_saved` / `results_saved` / card events under the same id |

## The export document (`GET /api/cards/:id/export`, `npm run export-trace`)

One self-contained JSON object per card:

| section | contents |
| --- | --- |
| `export` | `schema` (`betsheet.card-trace-export`), `schemaVersion`, `exportedAt`, `docs` |
| `card` | id, cardNumber, variant, template (strategy-template name, D18), engineVersion (D34; `lean-0` = pre-versioning), bankrollCents, perRaceMinCents, consensusCompleteness, correlationId, createdAt |
| `raceDay` | id, track, date |
| `sources` | `used` / `unavailable`, each `{name, ts, outcome, reason}` — latest attempt per source (invariant 11) |
| `races` | per race: number, raceType, surface, distance, postTime, conditions, classification, contrarianFlags, wagerMenu, and full `entries` (programNumber, horseName, morningLine + decimal, programRank, bestBet, scratched) |
| `consensus` | every stored pick: race, source, kind, pick_type, program_number, horse_name, note |
| `allocations` | race, amountCents, confidence, rule, thesis (incl. TRIGGER lines) |
| `tickets` | the card as persisted, each with its `grade` (`outcome`, `returnedCents`, `plCents`, `note`, from the LATEST grade set - invariant 14 keeps older versions' sets in graded_tickets) or `grade: null` when the day has no results yet |
| `gradeSummary` | costCents, returnedCents, plCents, outcomes — or null when ungraded |
| `results` | the day's stored chart: `finishers` (with W/P/S prices in cents), `exotics` (per printed base), `scratches` |
| `traceStatus` | `complete` (the generation run's `seq` counter is present and gap-free through `card_finalized`), `partial` (some generation events lost — rotated past retention or a foreign log dir), or `missing` (no generation events found — e.g. the card predates a factory reset of a different instance's logs). Consumers should weigh `partial`/`missing` exports accordingly; the DB-backed sections (tickets, grades, results) are always current. |
| `trace` | every decision-trace event whose correlationId matches the card's or that carries this cardId, oldest first — generation, every grading pass, and any day events in the same session |

Deleted race days answer 410 (invariant 12: excluded from every reporting
surface; their history stays in the log files). Money is integer cents
everywhere. Program numbers are strings (`"1A"`).
