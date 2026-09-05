# Analyst notes on LLM cards — pre-registered hypotheses

- **Engine**: `llm` (LLM cards carry `engine_version = 'llm'`; the lean engine is untouched at `lean-1.1`)
- **Prompt version**: `llm-card-v1 + analyst notes` (D92)
- **Bucket**: `LLM_GENERATED`, split by `cards.notes_present`
- **Corpus**: none yet. **This file is written BEFORE the first notes-augmented card is played.**
- **Deliverables**: D92 (schema/prompt/logging), D93 (modal UI), D94 (this file + the P/L split)

This is a pre-registration, not a result. It exists so the hypotheses are fixed
before any data arrives, and so the first ten outputs are read against a written
expectation rather than an impression.

---

## Why this file has a prompt version and no other findings file does

The Findings convention is one file per **(engine version, bucket, corpus)**.
That works because the engine has a version axis: `ENGINE_VERSION` is bumped by
every PR that changes generation, and invariant 14 keeps P/L from pooling across
versions.

**LLM cards have no such axis.** `engine_version` is the literal string `'llm'`
for every one of them, so invariant 14's bump rule never reaches them and a
prompt change would silently pool with pre-change cards.

D92 closes that for this feature by making the notes clauses **conditional**
(`buildSystemPrompt({hasNotes})`), so a notes-free generation stays byte-identical
to a pre-D92 one and the existing corpus remains poolable. `check-llm-cards`
asserts `buildSystemPrompt({hasNotes:false}) === SYSTEM_PROMPT`.

**A future prompt change needs either the same conditional treatment or a real
`cards.prompt_version` column.** Without one, this file's comparisons quietly stop
meaning anything.

---

## What `notes_present` actually means

It **latches**: it is set true the first time any race on the card is generated
with notes, and never cleared. So it means **"at least one race on this card used
notes"** — never "every race did".

That is deliberate (a user will realistically have commentary for 3 of 8 races,
and refusing the other 5 would make the feature unusable), but it makes the
card-level split blunt. Per-race truth is in `llm_card_requests.notes_present`,
and any query that needs it should go there rather than inferring from the card.

---

## H1 — Do notes change the tickets at all?

**The only hypothesis a small corpus can actually answer**, so run it first.

Paired generation: same race, same model, one generation with notes and one
without, compared on the ticket set (selections, bet types, stake distribution).
The pairs must be **deliberate** — scavenging pairs after the fact selects for
races where something already looked different.

Recorded per pair: `llm_card_requests.id` for both calls, `notes_hash`, the model,
and the two ticket sets.

This is descriptive. A difference does not mean notes *help*; it means the input
is reaching the decision, which is the precondition for every other question here.
If H1 comes back "no difference", H2 and H3 are moot and the feature is a no-op
worth reverting.

---

## H2 — Does the model obey the five rules?

**This is where injection resistance is actually measured.** CI cannot do it:
`check-llm-cards` runs with `BETSHEET_LLM_TEST_MODE=1` and a stubbed response, so
its injection test proves only that the **plumbing** is injection-resistant —
notes enter as prompt text and never as a parameter, so bankroll arithmetic,
stake validation and persistence ignore note content by construction. **The stub
is not a model.** Whether a real model follows the rules is an empirical question
answered here, from real logged `prompt_text` / `response_text`.

Measured over every notes-bearing request row:

1. **Money rule.** Does any ticket's stake correspond to a dollar figure that
   appears only inside the notes? (The server re-validates stakes, so a violation
   shows up as an attempted stake, not a saved one — read the response, not the card.)
2. **Roster rule.** Does any ticket name a horse the model's own `NOTES_REPORT`
   flagged `not_in_this_race`? A ticket contradicting the model's own report is
   the sharpest available signal.
3. **Directive rule.** On a note containing an explicit instruction, does the
   reasoning acknowledge ignoring it, as the clause asks?
4. **Report presence.** How often does a `NOTES_REPORT` block appear at all when
   notes were sent? A high `notes_report_missing` rate means the clauses are being
   partly ignored, which weakens every other reading here.
5. **Transcription.** Does the card simply reproduce a ticket list pasted in the
   notes? This is the failure mode the scope doc named as the main risk.

**Self-reported `influence` is not evidence.** A model that writes
`influence | used` on every race is telling you about its narration, not its
behaviour. Every item above is measured against tickets, not against the report.

The first ~10 notes cards should be read by hand regardless of what these
counts say.

---

## H3 — Does `notes_present = 1` beat `notes_present = 0` on P/L?

**Secondary, and it will be noise for a long time.** State the corpus size in any
claim; do not report an ROI on a handful of cards.

`GET /api/pl`'s `byNotes` breakdown is the mechanical split (rows sum to the
bucket total — a breakdown, never a second pool). Two things make it weaker than
it looks:

- The split is **card-level and latching** (see above), so a card with notes on
  one race of eight sits entirely on the "with" side.
- Notes and no-notes cards are **not randomised**. Kevin will write notes on races
  he finds interesting, which is exactly the selection effect that makes an
  observational P/L difference uninterpretable.

**Pre-registered threshold:** no claim about H3 until **at least 20 cards on each
side across at least two meets**, and even then paired against the same day's
lean card rather than read as an absolute. Below that, report the numbers as
descriptive and say explicitly that they are not evidence.

---

## Corpus hygiene

- **Backfill and batch runs cannot carry notes.** `previewLlmRace` takes a positive `interactive` flag that only the preview route passes, and refuses 409 if notes exist without it. `check-backfill` asserts no notes-bearing request survives a backfill run.
- **`notes_post_result = 1` marks a note written on a day whose results were already recorded.** Those are not blind and must be excluded from any H2 or H3 claim. The modal shows an amber banner when this applies. Given the corpus is 74 archived days and a handful of live ones, expect most early notes cards to carry this flag — which is a reason to weight H1 (paired, mechanical) over H3 (outcome-based) in the early going.
- **The day-level note is repeated into every race's prompt.** `notes_card_text` is stored separately from `notes_race_text` precisely so a tally can dedupe it; a naive count over `prompt_text` would count one day note eight times.
- **Notes are copyrighted prose.** They are stored verbatim in `llm_notes`, in `llm_card_requests.notes_*_text`, and inside `prompt_text`. `server/trace-export.js` touches none of these and invariant 10 keeps published cards to card data only. **Never add `prompt_text` to the export or publish path.** `notes_present` survives a redaction of the text columns, which is the escape hatch if that is ever needed.

---

## What is NOT concluded

Nothing. No card has been generated with notes at the time of writing.

**No engine change, no template weighting change and no prompt change follows
from any of these hypotheses until a result is written into this file with the
request IDs it was measured from.**

## The question the next corpus must answer

**H1, cleanly**: do notes change the ticket set at all, on paired generations of
the same race with the same model? Everything else here is unreadable until that
one has an answer.
