# LLM card prompt v1 (D63)

The prompt behind "Generate Card from LLM": a manual, per-race LLM picker
run alongside lean and human, to investigate whether a non-static picker
beats the static rules engine. This is not a replacement for the engine -
see CLAUDE.md invariant "Benchmark first, bet later."

## Origin

Base text, confirmed from the "Racing program betting analysis and picks"
project (2026-08-30 origin):

> Analyze the races in this racing program and determine the best bets.
> Search the internet for consensus picks. Include longshots and parlays,
> $50 of bets per race.

## v1 deviations from the base text

1. **No search tool wired in.** The day's already-fetched consensus
   (`shared/classification.js`'s per-source table - source, top/second/
   third picks, watch/contrarian flags) is provided directly in the
   prompt instead of asking the model to search the internet itself.
   Nothing here calls out to the web; the model reasons over what
   BetSheet already gathered for the race.
2. **Per-race, not per-day; per-race bankroll, not a flat $50.**
   Generation happens one race at a time
   (`POST /api/race-days/:id/llm-cards/preview`), so the prompt only
   ever sees one race, never the whole card. The per-race bankroll
   defaults to `(card bankroll - spent so far) / (races remaining)`,
   recomputed fresh on every call so an early race's underspend or
   overspend reshapes what's left for the rest of the day. **Flagged for
   review** - two alternatives were considered and rejected for v1:
   - a flat split (`bankroll / raceCount` on every race, ignoring actual
     spend) - simpler, but a cheap early race leaves money stranded and a
     later race can't pick it up;
   - a user-editable per-race amount - more control, but adds a UI step
     to every race and nothing yet suggests the default needs overriding.
   See the DELIVERABLES.md ledger row for this PR.
3. **Structured output for parsing, not prose, and not a new JSON
   schema.** The response must end with a fenced ticket block using the
   SAME row grammar `shared/parsers/human-picks.js` already parses for a
   human's pasted picks - `<bet type> | <selections> | <stake> |
   <rationale>`, one ticket per line - so the exact same parser, the same
   validation (wager menu, minimums, scratches, unknown program numbers)
   and the same warning vocabulary apply to an LLM's picks as to a
   person's pasted ones. No JSON schema, no translation layer. "Parlays"
   from the base text becomes same-race exotics only in v1 (exacta /
   exacta box / trifecta / trifecta box / superfecta / superfecta box) -
   multi-race wagers (Daily Double, Pick N) are out of scope, the same
   limitation the human parser already has (`MULTI_RACE_RE`).

## Per-race prompt template

The server builds this by plain string interpolation (`server/llm-prompt.js`),
not a templating engine - `{{...}}` below is illustrative, not literal syntax.

### System

```
You are an expert horse racing handicapper. You will be given ONE race
from a printed program - the entries, the morning line, program
handicapper rankings, and (if available) the program's own Bottom Line
analysis - plus the consensus picks already gathered from external
sources for this race. Analyze the race and propose betting tickets
against a fixed bankroll for THIS RACE ONLY.

Rules:
- Only bet horses that appear in the entries below, by their exact
  program number. Never invent a horse or a program number.
- Never bet a scratched horse.
- Your total stakes for this race must not exceed the race bankroll
  given below.
- Include longshots where you see value, and same-race exotics
  (exacta / exacta box / trifecta / trifecta box / superfecta /
  superfecta box) where warranted - no multi-race wagers (Daily
  Double, Pick 3, etc.) in this version.
- Respond in two parts: your reasoning first (plain prose - explain
  which horses you like and why, referencing the entries, rankings and
  consensus given), then the ticket block, exactly as specified below.

Ticket block format - after your reasoning, output a line reading
exactly "<<<TICKETS>>>", then one ticket per line in this exact
grammar, then a line reading exactly "<<<END TICKETS>>>":

  <bet type> | <selections> | <stake> | <rationale>

- <bet type>: one of win, place, show, exacta, exacta box, trifecta,
  trifecta box, superfecta, superfecta box (case-insensitive).
- <selections>: program numbers only, e.g. "#4". Straight bets
  (exacta/trifecta/superfecta, not boxed) separate finish positions
  with "/", e.g. "#4 / #2" (4 to win, 2 to place). Box types list
  every horse in the box separated by ",", e.g. "#4,#2,#7".
- <stake>: the TOTAL dollar amount for that ticket (not per-combo),
  e.g. "$20".
- <rationale>: one short sentence, required.

If you have no bet worth making on this race, output the block with
zero ticket lines between the markers - do not pad it with a bet you
don't believe in.
```

### User (one call per race)

```
RACE {{raceNumber}} of {{totalRaces}} - {{track}}, {{date}}
{{surface}} · {{distance}} · {{raceType}} · post {{postTime}}
Wager menu: {{wagerMenu}}
Race bankroll: ${{perRaceBankrollDollars}} ({{racesRemaining}} race(s)
left of ${{remainingBankrollDollars}} on this card)

ENTRIES
#{{programNumber}} {{horseName}}{{" (SCRATCHED)" if scratched}} - ML {{morningLine}}{{", program rank " + programRank if programRank}}{{", BEST BET" if bestBet}}
... one line per entry ...

PROGRAM BOTTOM LINE
{{bottomLineText, only if present}}

CONSENSUS
{{sourceName}}: top {{top}}, 2nd {{second}}, 3rd {{third}}{{", watch/contrarian: " + flagged if any}}
... one line per source, or ...
No external consensus on file for this race - program analysis and
morning line only.
```

## Response parsing

`server/llm-prompt.js`'s `extractTicketBlock(responseText)` finds the
`<<<TICKETS>>>` / `<<<END TICKETS>>>` markers and returns
`{ reasoningText, ticketBlockText }`. If the markers are missing entirely
the call is treated as a hard failure (visible error, nothing persisted) -
there is nothing safe to preview. When the markers are present,
`ticketBlockText` is handed to `shared/parsers/human-picks.js`'s
`parseHumanPicksText` exactly as a human's pasted text would be (with
`ruleTag: 'llm'` so the persisted tickets' `rule_tags` read `["llm"]`, not
`["human"]`) - same warnings, same blocking rules, same ticket shape. A
response whose ticket block parses with blocking warnings (an invented
program number, a scratched selection, a below-minimum stake) is not a
hard failure: it previews exactly like a human's bad paste would, with
the warnings shown and nothing saved until the block is empty of them.
