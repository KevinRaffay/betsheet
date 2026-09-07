# Decision-trace schema

The decision-trace stream (`server/logs/decision-trace.jsonl` + rotations)
and the card export document built from it. This is the Phase 3 feed: give
an LLM one export and it can replay "given these inputs, the algorithm
decided X because Y — and it earned Z" for every dollar on the card
(invariant 7).

Versioning: the export document carries `export.schemaVersion` (currently
**3**, `SCHEMA_VERSION` in `server/trace-export.js`; D111 bumped it from 1
to 2 when `traceStatus` changed meaning, D149 bumped it from 2 to 3 for the
new top-level `llmInputs` block - see below). Bump it whenever the
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

The lean engine's events also carried `seq` — a 0-based, gap-free counter
within one generation run, whose gaps meant trace loss. **D111 deleted that
engine and no event carries `seq` any more.** None of the three producers that
remain could carry one honestly: a human, LLM or OTR card is appended to race
by race across separate requests, so a per-call counter would restart and read
as a gap on a perfectly intact trace. Completeness is now cross-referenced
against the database instead — see `traceStatus` below. Server-side wrapping
still adds `cardId` and `raceDayId` to every event.

## Event catalog

### Card generation by the lean engine — REMOVED (D111)

`shared/card-engine.js` and `server/cards.js`'s generate route are gone, and
with them every event they emitted: `inputs_snapshot`, `consensus_table`,
`race_classified`, `completeness_decided`, `rule_fired`, `rule_suppressed`,
`allocation_decided`, `remainder_distributed`, `bankroll_balanced` and
`card_finalized`. **Nothing emits them now.**

They are still present in the logs and exports of every card generated before
the pivot, and in the frozen archive, so a consumer reading historical exports
must still handle them. Their full field catalog is preserved verbatim in
`docs/feature-notes.md`'s snapshot rather than repeated here, because this file
documents what the system emits, not what it once did.

The three surviving producers each emit `card_generated` and one
`ticket_added` per ticket, catalogued in their own sections below.

### Grading (emitted by `server/grading.js`, under the CARD's correlationId)

| event | fields | meaning |
| --- | --- | --- |
| `ticket_graded` | `cardId`, `ticketId`, `engineVersion` (the grader's version), `betType`, `races`, `legs`, `outcome` (win/refund/partial/loss), `costCents`, `returnedCents`, `plCents`, `note` | one ticket scored against the day's chart |
| `card_graded` | `cardId`, `gradedBy` (the triggering session's correlationId), `engineVersion`, `costCents`, `returnedCents`, `plCents`, `outcomes`, `topTicketShare` | the card summary. A regrade replaces DB rows but appends here — the log keeps every grading pass |

### Human cards (D54, emitted by `server/human-cards.js`, streamed under the card's correlationId)

A human's pasted tickets, not the engine, produced these - no `inputs_snapshot`/`rule_fired`/`allocation_decided` events exist for a human card, since `shared/card-engine.js` is never called.

| event | fields | meaning |
| --- | --- | --- |
| `card_generated` | `cardId`, `raceDayId`, `engineVersion` (`'human'`), `template` (`'human'`), `name` (D137, the optional user-entered label, or `null`) | the human card's first race lock, on card creation only (append-only, D28) |
| `ticket_added` | `cardId`, `raceDayId`, `race`, `betType`, `selections` (legs), `stakeCents`, `costCents`, `rationaleText` | one human ticket landed on the card, carrying the pasted rationale verbatim |
| `human_ticket_deleted` | `cardId`, `raceDayId`, `race`, `ticketId`, `betType`, `tellerCall`, `costCents`, `raceRetired` | one ticket was deleted from a locked, unrevealed race (D103). Deliberately NOT a timestamp change: a delete leaves `human_race_state.picks_locked_at` alone, so the card's derived blindness (invariant 15) is the same before and after - which is why deleting is offered where editing is not. `raceRetired` marks the last ticket going, which also drops the race's allocation and its `human_race_state` row |
| `human_race_locked` | `cardId`, `raceDayId`, `race`, `pass` | one race's picks were locked (or explicitly passed) on a human card - the timestamp this event's `ts` field carries is the same one written to `human_race_state.picks_locked_at`, the fact a later blindness computation (D55) is derived from |

### LLM cards (D63, emitted by `server/llm-cards.js`, streamed under the calling session's correlationId)

An LLM's own picks, not the engine, produced these - no `inputs_snapshot`/`rule_fired`/`allocation_decided` events exist, since `shared/card-engine.js` is never called. `card_generated`/`ticket_added` carry the same fields the Human cards section above documents (`template`/`engineVersion` are `'llm'`). D149 added the three events below to capture what a generation call CONSUMED as well as what it produced - previously only the prompt/response/notes on the `llm_card_requests` DB row recorded that, with nothing in the trace stream itself.

| event | fields | meaning |
| --- | --- | --- |
| `llm_request_sent` | `correlationId`, `cardId` (null for a brand-new card's first race, same nullability `llm_card_requests.card_id` already has), `raceDayId`, `races` (always length 1 - this generator calls the model once per race, never once per day), `model`, `promptTemplate` (`{id, version}`), `promptHashes` (`{system, user}`, each `sha256:<hex>`), `notesHash`, `notesChars` | logged BEFORE the model answers - invariant 11's "every attempt visible" rule, one event earlier than the `llm_card_requests` row (which is only written once the outcome, success or failure, is also known) |
| `llm_response_received` | `correlationId`, `cardId`, `raceDayId`, `responseChars`, `parsedTicketCount`, `parsedRaceCount` (0 on any hard failure, else 1), `parseErrors` (an API/network error message; `'no_ticket_block'` when the response had no parseable ticket block; else the `type` of every BLOCKING parse warning) | the outcome of the same call, whatever it was - a hard failure, an unparseable response, or a clean parse still gets one of these |
| `race_regenerated` | `cardId`, `race`, `previousCorrelationId` (the most recent earlier successful request logged for this exact card+race - an approximation, since no ticket row is linked back to the request that produced it, but the append-only request log makes it a close one), `newCorrelationId`, `ticketsRemoved` | emitted whenever `persistLlmRace` REPLACES tickets already on file for a race (append-only per invariant 14's spirit at the ticket level: the DB row set is replaced, but this event keeps the fact that a replacement happened, and how many tickets it removed, discoverable without diffing `ticket_added` timestamps against the current ticket set) |

### Equibase Off to the Races (D71, emitted by `server/equibase-otr.js`, one correlationId per confirm call spanning all three cards)

Equibase's printed sheet, not the engine, produced these - no `inputs_snapshot`/`rule_fired`/`allocation_decided` events exist, since `shared/card-engine.js` is never called. One confirm call always produces exactly three `card_generated` events (some-reward / higher-reward / both, D71's three variants) plus one `equibase_otr_ingested` summary event.

| event | fields | meaning |
| --- | --- | --- |
| `card_generated` | `cardId`, `raceDayId`, `engineVersion` (`'equibase-otr'`), `variant` (`'some-reward'` / `'higher-reward'` / `'both'`) | one of the three cards created by this confirm call (append-only - a re-upload creates three MORE cards, never replaces) |
| `ticket_added` | `cardId`, `raceDayId`, `race`, `betType`, `selections` (legs), `stakeCents`, `costCents`, `rationaleText` (the tier label, "Some Reward Opportunity" / "Higher Reward Opportunity") | one printed ticket landed on a card, taken verbatim - no interpretation, no re-sizing |
| `equibase_otr_ingested` | `raceDayId`, `archivePath`, `sha256`, `races` (count parsed), `warnings` (count) | one summary event per confirm call, naming the archived file this ingest was re-parsed from |

### Equibase OTR as a consensus source (D74, emitted by `server/equibase-otr.js`, under the confirm call's correlationId)

The sheet is ALSO a consensus source now (D07 still stands - no fetcher; this reads the same parse the confirm/`--consensus-only` path already did). Written through `server/consensus.js`'s ordinary `storePicks`/`classifyAndPersist` - the `day_classified` event those emit (fetch-audit stream) follows this one under the same correlationId, exactly as it does after a manual paste or the ATR upload.

| event | fields | meaning |
| --- | --- | --- |
| `consensus_source_ingested` | `raceDayId`, `source` (`'equibase-otr'`), `races` (count), `sha256` (the archived file this write was re-parsed from), `picksStored` | one event per write (a confirm, a re-upload's replace, or a `--consensus-only` batch write) - the source's rows for the day were just replaced, not duplicated |

### Replay (D55, emitted by `server/replay.js`, under the card's correlationId)

| event | fields | meaning |
| --- | --- | --- |
| `human_race_revealed` | `cardId`, `raceDayId`, `race` | one race's results were revealed on a human card - the `ts` this event carries is the same one written to `human_race_state.results_revealed_at`, the other half of the blindness computation |
| `human_card_closed` | `cardId`, `raceDayId` | `POST /api/replay/cards/:id/close` ran: every still-unlocked race became an explicit PASS, every locked-unrevealed race was revealed, all under ONE timestamp so a genuinely pre-committed day still computes PRE_COMMIT afterward. Makes the card eligible for the standing table (`shared/replay.js`'s `isCardClosed`) |

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
| `llmInputs` | (D149, schemaVersion 3) `null` for a non-LLM card, or an LLM card exported before this capture existed (schemaVersion 2 or earlier, or an LLM card with no matching `llm_card_requests` rows at all) - **`null` means "unknown", never "no notes were used."** Otherwise an array, one entry per correlation id that landed at least one ticket on this card: `{correlationId, races, model, requestParams, promptTemplate: {id, version}, requests: [{race, promptHashes: {system, user}, notes, systemPromptRendered, promptRendered, responseRaw}]}` - `requests` has one element per race (this generator calls the model once per race, so a shared correlation id can still cover several distinct prompts/responses, never one prompt for the whole group). `notes` is `null` when that race carried none, else `{raw: {race, card}, rendered, hash, chars}` - `raw` is what the human typed, `rendered` is the composed/sanitized/truncated text the model actually saw. `?omitLlmInputs=1` on the endpoint (or `--omit-llm-inputs` on the CLI) drops `systemPromptRendered`/`promptRendered`/`responseRaw` and `notes.raw`/`notes.rendered` from every entry, keeping only `notes.hash`/`notes.chars` alongside the always-kept `promptHashes`/`promptTemplate`/`race`/`model` - the shareable form for a card whose notes may carry someone else's copyrighted prose. |
| `traceStatus` | `complete` (the card's `card_generated` event is present AND the log holds at least one `ticket_added` for every ticket on file), `partial` (some events lost — rotated past retention, or a foreign log dir), or `missing` (no generation events found at all — e.g. the card predates a factory reset of a different instance's logs). **D111 changed how this is computed** (schemaVersion 2): it used to read the lean engine's self-reported gap-free `seq` counter, and now cross-references the log against the DATABASE, which is both the stronger test and the only one still possible once the engine is gone. Consumers should weigh `partial`/`missing` exports accordingly; the DB-backed sections (tickets, grades, results) are always current. |
| `trace` | every decision-trace event whose correlationId matches the card's or that carries this cardId, oldest first — generation, every grading pass, and any day events in the same session |

Deleted race days answer 410 (invariant 12: excluded from every reporting
surface; their history stays in the log files). Money is integer cents
everywhere. Program numbers are strings (`"1A"`).
