# Tipsheet and OTR picks as a baseline input to the LLM prompt

**Scoped 2026-09-08, built as D179.** Records what was decided, what the
archaeology found, and what was deliberately left out — so the reasoning
survives the session that produced it.

The ask: the LLM generator should see what the other sources on the day
already think — the tip sheets (D176) and Equibase's Off to the Races sheet
(D71) — as a **baseline**, in addition to the optional analyst notes it
already reads.

---

## Archaeology: three things that were checked first

**1. There is prior art, and it is directly reusable.** D112 deleted a
`CONSENSUS` block from `buildLlmRaceUserPrompt` (recoverable with
`git show 2543e52 -- server/llm-prompt.js`). It already implements every
decision taken below: labelled per source, both sources rendered with no
precedence, an explicit absence line, and — crucially — OTR rendered in its
own vocabulary rather than forced into a ranked line. D74 left the reason:

> OTR prints a show pick, a win pick and two unranked box mentions — not a
> top/2nd/3rd order, so it gets its own sentence in its own vocabulary rather
> than being forced through the generic ranked line, which would misrepresent
> an unranked box mention as a "3rd" pick it never claimed to be.

That argument is stronger than any written for this scope, and it settles the
"tickets, not ranks" question for OTR.

**2. The legacy block lived in the USER prompt only.** No consensus clauses
were ever added to `SYSTEM_PROMPT`. Notes needed system clauses (how to treat
advisory text); a source table did not. Following that shape keeps
`buildSystemPrompt({hasNotes:false}) === SYSTEM_PROMPT` true untouched.

**3. Capture is already free.** `llm_card_requests.prompt_text` stores the
**entire user prompt verbatim** — confirmed against a stored row. A baseline
block rendered there is captured for reproduction with **no migration, no new
columns, no latch**. The heavier scope originally proposed (capture columns, a
`baseline_present` flag) was defending a corpus that is, by standing
instruction, a sandbox.

---

## Decisions

| question | answer | why |
| --- | --- | --- |
| OTR as ranks or tickets? | **Tickets** | D74's reason above: OTR never claimed a 3rd pick, and ranking its box mentions would invent one. |
| Both sources, or a precedence rule? | **Both when both exist** | They are different opinions. A precedence rule would silently discard one. |
| Labelled, or merged into one list? | **Labelled per source** | A merged "the sheets like these horses" loses which source the model followed — the one thing worth knowing later. |
| Where does OTR ticket data come from? | **The `both` variant's tickets** | Verified: `both` carries all four printed tickets (`$2 S 8`, `$1 EX BOX 8-4-5-9`, `$2 W 4`, `$2 EX BOX 8-4-5`); `some-reward` and `higher-reward` each carry half. |
| Schema changes? | **None** | The full user prompt is already stored verbatim. |

---

## What this deliberately does not do

**No measurement of whether it helps.** No P/L breakdown by baseline, no
findings document, no pre-registration, no comparison of baseline-fed cards
against bare ones. Excluded by explicit instruction, and noted here so a later
reader does not mistake the absence for an oversight.

**No backfill and no backwards compatibility.** The existing corpus and P/L
are a sandbox by standing instruction (2026-09-08). Stored cards are not
reconciled and nothing migrates.

---

## The consequence worth writing down

This is an **un-versioned prompt-comparability boundary** — the usual kind for
LLM cards, which have no version axis (`engine_version` is the literal
`'llm'`). It is accepted here only because the corpus is a sandbox.

More importantly, it changes what a bucket **means**. Today `EQB_OTR`,
`TIPSHEET` and `LLM_GENERATED` are independent opinions that can be compared.
Once the LLM reads the other two, its cards are **derivative of them** — the
comparison quietly stops measuring what it measured before. That is fine in a
sandbox and would not be fine in a corpus, and this paragraph exists so the
distinction is not rediscovered the hard way.
