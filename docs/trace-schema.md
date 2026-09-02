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
| `inputs_snapshot` | `bankrollCents`, `perRaceMinCents`, `raceCount`, `entries[{race, entries}]`, `sourcesUsed`, `sourcesUnavailable`, `template`, `rules` | everything the run saw, first event (`seq` 0). `template` is the strategy-template name (D18, null for direct engine calls); `rules` is the full resolved rule set after template + explicit overrides. |
| `consensus_table` | `race`, `table` | the per-horse vote table the classification was computed from |
| `race_classified` | `race`, `classification` (UNANIMOUS/SPLIT/CHAOS/GUESS), `externalSourceCount`, `cappedFromUnanimous`, `topVotes`, `contrarianFlags` | the signal-layer call and the votes behind it |
| `completeness_decided` | `completeness` (FULL/PARTIAL/PROGRAM_ONLY), `externalSourcesPerRace` | the card's consensus-completeness bucket (invariant 13) |
| `rule_fired` | `rule`, `reason?`, rule-specific fields (`race`, `horse`, `stakeCents`, `reserveCents`, ...) | a structure-layer rule acted. Rules: `multi_race_reserve`, `guesswork_minimum`, `fade_favorite_price`, `win_bet`, `longshot_on_top`, `hedge_cut`, `two_source_coverage`, `mid_price_coverage`, `place_money_rule` |
| `rule_suppressed` | `rule`, `reason` | a rule was disabled by the template (simulation) — the suppression itself is traced |
| `allocation_decided` | `race`, `amountCents`, `confidence`, `rule` | the per-race allocation and which weighting produced it |
| `ticket_added` | `race` (null for multi-race), `races`, `betType`, `selections` (legs), `stakeCents`, `costCents`, `rules` (provenance tags) | one ticket landed on the card |
| `remainder_distributed` | `remainderCents`, `passes`, `races[{race, amountCents, steps, ticket, withPlace, allocatedCents}]`, `undistributedCents` | how the gap between the bankroll and the constructed tickets was spread: round-robin $1 steps onto each race's primary win ticket (`withPlace` = the place-money pair moved with it, $2 a step), larger allocations first, at most one step per race per pass; guesswork races only when nothing else can take the money. Emitted only when there was a remainder. `undistributedCents` is non-zero only when minimums made an exact match impossible |
| `bankroll_balanced` | `adjusted`, `remainingCents` | the exact-bankroll balancing pass (invariant 2); follows `remainder_distributed` |
| `card_finalized` | `totalCents`, `bankrollCents`, `ticketCount`, `completeness`, `perRace[{race, allocatedCents, spentCents}]`, `warnings` | last generation event; totals as persisted |

### Grading (emitted by `server/grading.js`, under the CARD's correlationId)

| event | fields | meaning |
| --- | --- | --- |
| `ticket_graded` | `cardId`, `ticketId`, `betType`, `races`, `legs`, `outcome` (win/refund/partial/loss), `costCents`, `returnedCents`, `plCents`, `note` | one ticket scored against the day's chart |
| `card_graded` | `cardId`, `gradedBy` (the triggering session's correlationId), `costCents`, `returnedCents`, `plCents`, `outcomes`, `topTicketShare` | the card summary. A regrade replaces DB rows but appends here — the log keeps every grading pass |

### Day lifecycle (emitted by `server/ingest.js` / `server/results.js`, under the day's own correlationIds)

| event | fields | meaning |
| --- | --- | --- |
| `results_saved` | `raceDayId`, `track`, `date`, `results`, `exotics`, `scratches` | a chart landed (and auto-graded every card of the day) |
| `race_day_deleted` | `raceDayId`, counts | soft delete; the trace files are never touched (invariant 12) |
| `race_day_restored` | `raceDayId` | restore from the deleted list |
| `race_day_superseded` | `raceDayId`, `supersededRaceDayId`, `supersededCorrelationId`, `supersededWasDeleted` | re-ingest replaced a prior day; old ids stay resolvable here |

## The export document (`GET /api/cards/:id/export`, `npm run export-trace`)

One self-contained JSON object per card:

| section | contents |
| --- | --- |
| `export` | `schema` (`betsheet.card-trace-export`), `schemaVersion`, `exportedAt`, `docs` |
| `card` | id, cardNumber, variant, template (strategy-template name, D18), bankrollCents, perRaceMinCents, consensusCompleteness, correlationId, createdAt |
| `raceDay` | id, track, date |
| `sources` | `used` / `unavailable`, each `{name, ts, outcome, reason}` — latest attempt per source (invariant 11) |
| `races` | per race: number, raceType, surface, distance, postTime, conditions, classification, contrarianFlags, wagerMenu, and full `entries` (programNumber, horseName, morningLine + decimal, programRank, bestBet, scratched) |
| `consensus` | every stored pick: race, source, kind, pick_type, program_number, horse_name, note |
| `allocations` | race, amountCents, confidence, rule, thesis (incl. TRIGGER lines) |
| `tickets` | the card as persisted, each with its `grade` (`outcome`, `returnedCents`, `plCents`, `note`) or `grade: null` when the day has no results yet |
| `gradeSummary` | costCents, returnedCents, plCents, outcomes — or null when ungraded |
| `results` | the day's stored chart: `finishers` (with W/P/S prices in cents), `exotics` (per printed base), `scratches` |
| `traceStatus` | `complete` (the generation run's `seq` counter is present and gap-free through `card_finalized`), `partial` (some generation events lost — rotated past retention or a foreign log dir), or `missing` (no generation events found — e.g. the card predates a factory reset of a different instance's logs). Consumers should weigh `partial`/`missing` exports accordingly; the DB-backed sections (tickets, grades, results) are always current. |
| `trace` | every decision-trace event whose correlationId matches the card's or that carries this cardId, oldest first — generation, every grading pass, and any day events in the same session |

Deleted race days answer 410 (invariant 12: excluded from every reporting
surface; their history stays in the log files). Money is integer cents
everywhere. Program numbers are strings (`"1A"`).
