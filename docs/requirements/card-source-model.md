# Card source model: labels, vocabulary, and more than one card a day

**Status: SPECIFIED, NOT SCHEDULED.** No deliverable IDs are claimed here — they get
claimed when the work is picked up, not before. Scoped 2026-09-06 from Phase 3 of
`docs/decisions/2026-09-05-simulator-pivot.md`. **Every structural claim below was checked
against the code and against the live 108-card corpus**, not read off the plan; where the
plan and the code disagree, this doc says so and says which is right.

## Purpose

The pivot's third job is *analyze*: slice graded cards by source, model, human source
label, track, bet type, race type, field size and cross-card agreement. Phase 7's dimension
table names **card source**, **`llm_model`** and **`source_label`** among its columns. One
of those three exists. This phase builds the other two and removes the reason a race day
can only hold one hand-built card.

Phase 3 is independent of Phases 4 and 5 once P-2 has landed — which it has (D115–D117) —
so it can be built now, in any order against them.

---

## What the plan asked for

- **P-3.1** — add `source ∈ {OTR, LLM, HUMAN}` and `source_label` to cards; make
  `llm_model` required for LLM cards; back-fill by migration. *Done when: creating a card
  without a valid source fails; every list/dashboard view shows source and label.*
- **P-3.2** — a controlled vocabulary for `source_label`, seeded `emubets`, `drf`,
  `keeneland-tipsheet`, `own`, `chatgpt`, `gemini`, `claude-chat`, `other`, with free text
  stored separately as `source_label_other` so the seeded values stay clean for grouping.
- **P-3.3** — multiple HUMAN cards per race day, each an independent bankroll with its own
  label. *Done when: three HUMAN cards with different labels coexist on one race day, each
  grading independently.*

---

## What was checked

### Already true — no work needed

**1. Multiple HUMAN cards per race day already work in the database.** Migration 007
replaced `UNIQUE (race_day_id, variant)` with `UNIQUE (race_day_id, card_number)`, and race
day 27 carries two `human` cards today (#2 and #3, both $200, twelve minutes apart). The
API supports it explicitly: `POST /race-days/:id/human-cards` with `cardId` omitted always
mints a new card (D28, append-only).

**The constraint P-3.3 asks to remove is not in the database. It is in the UI**, and it is
one expression: `CardsPanel.jsx` resolves `humanCardId` as the day's highest-numbered
`human` card and hands it to the builder, so opening the builder always resumes rather than
starting. `ReplayDayLanding` and `ReplayRaceView` do the same. Nothing anywhere passes
`cardId: null` — the path `LlmCardModal`'s "Start a New Card" button already exposes for
LLM cards. **P-3.3 is a UI deliverable, not a schema one.**

**2. A card cannot be created without a source today.** `server/cards.js` stopped owning
generation at D111; the only three `INSERT INTO cards` statements left in `server/` are in
`equibase-otr.js`, `llm-cards.js` and `human-cards.js`, and each hardcodes its own
`consensus_completeness` and `engine_version`. P-3.1's "creating a card without a valid
source fails" is already structurally true of every writer that exists — with one hole,
below.

### Not true — the plan's premise needs correcting

**3. A `source` column would be the FOURTH column encoding the same fact.** The corpus:

| `engine_version` | `template` | `consensus_completeness` | cards |
| --- | --- | --- | --- |
| `human` | `human` | `HUMAN` | 5 |
| `llm` | `llm` | `LLM_GENERATED` | 12 |
| `equibase-otr` | `equibase-otr` | `EQB_OTR` | 6 |
| `lean-1.1` | (twelve retired lean templates) | `FULL` / `PARTIAL` / `PROGRAM_ONLY` / `ODDS_ONLY` | 85 |

For the three surviving producers those three columns are **1:1 with each other and with
`source`** — the grouping query returns exactly three combinations, with no exception
anywhere in 108 cards. A fourth stored copy adds a fourth thing that can drift and nothing
a reader could not already compute.

Nor is one of the existing three free to remove. `consensus_completeness` still carries a
distinction no `source` enum can: the 85 lean cards split four ways by how much signal they
actually had, and invariant 13 exists to keep those four apart. Dropping or renaming that
column while the lean corpus is live would lose the distinction or lie about it.

**Recommendation: derive `source`, do not store it.** One shared helper — the shape
`gradeVersionFor` already uses, keying off the `lean-` prefix so a future bucket is right
without editing it — read by every view that needs a label. A derived value cannot drift
from what it is derived from, which is the whole failure mode a fourth column would
introduce.

### Real defects found while checking

**4. `consensus_completeness` defaults to `PROGRAM_ONLY` — a retired engine bucket.** The
column is `NOT NULL DEFAULT 'PROGRAM_ONLY'`, so a writer that forgets it produces a card
silently filed in a bucket CLAUDE.md's own gotcha says nothing can enter any more, and
whose every stored figure is a backfill figure. `scripts/check-schema.js` already inserts
cards that way, correctly, as a schema test — but the default is a live trap for the next
writer, and it mislabels rather than refusing. **The default should be removed so the
omission is an error**, which is the strongest single argument for doing P-3.1 at all.

**5. `llm_model` is null on 2 of the 12 LLM cards**, both pre-D76. They group under
`'unknown'` in P/L's `byModel` breakdown today.

- **Card 110** (day 73, 2026-09-03) is exactly recoverable: all 24 of its
  `llm_card_requests` rows carry `claude-sonnet-5`.
- **Card 118** (day 27, 2026-09-04) is **not**. Its only plausible request row has
  `card_id` null — by design, since the first call for a brand-new card necessarily
  precedes that card's existence (migration 018) — and names
  `claude-haiku-4-5-20251001` twelve seconds before the card was created. That is an
  inference from a timestamp, not a recorded fact, and a back-fill that wrote it would be
  indistinguishable afterwards from one that knew.

Making `llm_model` NOT NULL therefore needs a decision about card 118, not just a
migration. This is also a **small correction to D105's stated goal**: retiring Haiku was
implemented so "the existing card stays graded, visible and correctly labelled", and card
119 — the labelled Haiku card — does. Card 118 does not and never did; it predates the
column.

**6. Blindness collides with P-3.3 head-on.** `shared/replay.js`'s `computeBlindness`
returns `NON_BLIND` unconditionally when `isFirstHumanCardOfDay` is false, and
`server/replay.js` computes that as `card.card_number === MIN(card_number)` over the day's
human cards. The rule was written for the D28 case it names — replaying a day already
played — and is right for that. Under P-3.3 it is wrong: three cards labelled `own`, `drf`
and `emubets`, all locked before any result is revealed, would record the first as
`PRE_COMMIT` and the other two as `NON_BLIND`, which is a claim about what the operator saw
that is false.

Two ways out, and they compose:

- **Blindness is a property of `own` cards.** A `drf` card is a transcription of someone
  else's picks; there is nothing the operator could have been blind to. Blindness there is
  not merely mis-derived, it is meaningless — it should be `null`, and the standing table
  should group such cards as their own thing rather than as failed blind plays.
- **For `own` cards, key on the day's reveals rather than on card number.** Whether a lock
  was made after a result was visible is derivable from the same timestamps invariant 15
  already uses, widened from one card's reveals to the day's. That drops the `card_number`
  heuristic entirely and covers the replay case and the sibling case with one rule.

Either way this changes a **derived value the standing table groups by**, so it belongs in
the same deliverable as multi-card support, never after it.

**7. `saw_classification` is now a dead grouping dimension.** D112 deleted the D09
classification and with it the `POST .../reveal-classification` route and its client call;
no code path can set the column any more. Four cards carry 1 and 104 carry 0, frozen.
Keeping the column is right — it is a true fact about those four cards — but
`GET /replay/standing` still groups by `(blindness, sawClassification)` and
`check-replay.js` still asserts the pair is never pooled, so every card from here on lands
in a single-valued dimension that splits nothing.

**Also found: CLAUDE.md's `server/replay.js` row is stale.** It advertises
`POST .../reveal-classification` as a live route and states a pre-reveal consensus
invariant in terms of `saw_classification` — both describing code D112 removed. The code
itself is correctly commented; the architecture row was missed. Worth fixing in whichever
PR touches this area first.

---

## The corrections this phase depends on

1. **Derive `source` from `engine_version` in one shared module; do not add a column.**
2. **Remove `consensus_completeness`'s `PROGRAM_ONLY` default**, so a writer that omits it
   is refused rather than mislabelled.
3. **Blindness is `null` for a card that is not the operator's own**, and for the
   operator's own it derives from the day's reveals rather than from card ordering.
4. **`source_label` is the only genuinely new information here** — nothing in the schema
   encodes it — and the only part of P-3.1/P-3.2 that needs a migration at all.

---

## The deliverable shape

Three deliverables, sequenced. Each is independently revertable and leaves the app working.

### S-1 — `source` derived, and the default that mislabels removed

A new pure `shared/card-source.js` exporting `sourceOf(card)` → `OTR` / `LLM` / `HUMAN` /
`ENGINE`, keyed off `engine_version` with the `lean-` prefix rule, plus display labels. A
migration removing the `PROGRAM_ONLY` default from `consensus_completeness` — an ordinary
column-default change, which on SQLite still means a table rebuild, so it carries the
`-- betsheet:schema-rebuild` header and the same real-corpus verification D115 used. Every
list view (`CardsPanel`, `PLView`, `DistributionView`, `CardView`'s header) renders the
derived source. No behaviour change beyond the refusal.

**Done when**: a card insert omitting `consensus_completeness` fails rather than becoming
`PROGRAM_ONLY`; `sourceOf` returns the same answer for all 108 stored cards as the
three-column combination does, asserted card by card; every card list shows a source.

### S-2 — `source_label`, with a controlled vocabulary

Migration adding `cards.source_label` and `cards.source_label_other` (both nullable — a
label is meaningless on an LLM or OTR card and null is the honest value there). A seeded
vocabulary in one shared module so the picker, the writer's validation and the analyzer's
grouping read the same list rather than three copies. `persistHumanRace` accepts a label at
card creation and freezes it, the way `llm_model` freezes (D76) — a card's source identity
must not drift mid-comparison. Free text lands in `source_label_other` and never in the
grouping key.

**Done when**: a human card can be created with a seeded label or a free-text override; the
seeded value is what any grouping keys on; an unknown seeded value is refused rather than
stored.

### S-3 — more than one hand-built card a day, and blindness corrected

A "New card" affordance in `CardsPanel` / the day builder that passes `cardId: null` (the
API path already exists), a list of the day's human cards with their labels, and the
blindness correction from finding 6 — `null` for a card that is not `own`, day-reveal-keyed
for one that is. `ReplayStanding` grows a label dimension and loses or keeps
`saw_classification` on the evidence in finding 7.

**Done when**: three human cards with different labels coexist on one race day, each grades
independently, each appears separately in P/L, and none of them is recorded as `NON_BLIND`
merely for not being first.

---

## Decisions the operator owns

These are not blocking — S-1 and the shape above stand either way — but they change what
S-2 and S-3 do, and guessing them would be worse than asking.

1. **Is the factory reset (P-6.3) still the plan?** If the corpus is wiped, the live
   database holds only the three producers and `consensus_completeness` becomes a
   badly-named `source` column that *should* be renamed. If it is not wiped, the lean-era
   distinctions stay live and the column must keep its meaning. The recommendation above
   (derive, do not store) is the one answer that is right either way, which is why it is
   the recommendation — but a rename becomes attractive the moment a reset is committed to.
2. **Card 118's model.** Leave it `'unknown'` and keep `llm_model` nullable, or write the
   inferred `claude-haiku-4-5-20251001` and record in the ledger that one of the twelve is
   inferred rather than recorded. Card 110 is recoverable exactly either way.
3. **The seed vocabulary.** `emubets`, `drf`, `keeneland-tipsheet`, `own`, `chatgpt`,
   `gemini`, `claude-chat`, `other` came from the plan. Two things worth noting before it
   is frozen: `keeneland-tipsheet` is track-specific in a list that is otherwise not, and
   `chatgpt` / `gemini` / `claude-chat` are cards **typed in by hand from an outside chat**,
   so they are `HUMAN`-source cards with an LLM label — deliberately *not* pooled with the
   in-app `LLM` source, which is the right call and worth stating out loud so a later
   reader does not "fix" it.

---

## What this doc does not cover

Phase 4 (OTR picks-to-tickets) and Phase 5 (LLM notes as primary input) are separate and
independent. The analyzer that consumes `source_label` is Phase 7. Nothing here changes
grading, and nothing here bumps `ENGINE_VERSION` — no card's tickets or grades move.
