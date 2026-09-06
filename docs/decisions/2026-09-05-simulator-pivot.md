# Pivot: from card generator to betting simulator and strategy analyzer

**Decided 2026-09-05.** Supersedes the consensus-engine roadmap. Recorded before any
removal begins, so the reasoning survives the sessions that execute it.

This is a decision record, not a specification. The per-phase detail lives with each
deliverable as it is scheduled; what belongs here is *what was decided, why, and what was
checked before deciding it*.

---

## The thesis

Strategy will not be designed up front. It emerges from volume: as many graded cards as
possible, from as many tracks, sources and models as possible, each labelled cleanly enough
that patterns become visible when sliced by any dimension.

The system therefore has three jobs:

1. **Ingest** a race day cheaply for any track, from Equibase entries HTML.
2. **Capture** cards from three sources — OTR, LLM, HUMAN — with clean labels, and grade
   them against uploaded results.
3. **Analyze** graded cards across source, model, human source label, track, bet type, race
   type, field size and cross-card agreement.

Everything that exists only to compute upstream consensus is removed.

**Pre-registration discipline is relaxed**, from "a hypothesis before any engine change" to
**"label everything, conclude nothing until n is stated"**. That is a deliberate loosening,
not an abandonment: the old rule guarded an engine that is being deleted, while the new one
guards the analyzer that replaces it. `docs/findings/lean-1.1-program-only.md` stands as
history; its hypotheses are withdrawn.

---

## Removed, kept, retargeted

**Removed** — all of it, no partial keep: ATR PDF ingestion; SFTB fetch and discovery (D08c
closed won't-fix); Del Mar program / Bottom Line ingestion, `programRank`, `bestBet`;
EQB_OTR *as a consensus source*; D09 classification, `CLASSIFY_UNANIMOUS`, contrarian flags,
`consensusCompleteness` and the consensus tables; "Generate Card"; the `lean` templates;
the pasted-entries input and parser.

**Kept**: the OTR parser and the `EQB_OTR` bucket; the LLM generator and its per-race
reasoning/raw-response logging; the Ticket Builder; results upload and the grader; the card
trace-export schema; structured decision-trace logging; and the invariants that still bind —
bucket isolation, append-only grading, and keeping any edge private.

**Retargeted**: `docs/requirements/equibase-entries-ingest.md` — the PDF path is replaced by
the HTML parser, which landed as **D104**; and per-race free-text notes become the *primary*
qualitative input to the LLM generator rather than an add-on, moving to the front of the
build order.

---

## What was checked before agreeing to this

Six claims in the proposal were tested against the code and the live corpus. Three held and
three did not. The three that did not are corrections the plan depends on, and the user
concurred with all of them on 2026-09-05.

### Verified correct

- **The regression fixture values.** Cards 5, 10, 11 on 2026-09-05 grade to
  **−5045 / +7015 / −9778** cents — exact. They are the Sonnet 5 / Fable 5.1 / Opus 5 cards,
  a well-chosen set.
- **The replay targets.** Win **−67 / −56 / −51** and trifecta box **+65 / +56 / +62**
  dollars on those cards — exact.
- **Removing the pasted-entries parser is clean.** `shared/entries-parser.js` has four real
  importers: `server/ingest.js` (retargeted), `ml-sheet-parser.js` and `program-parser.js`
  (both removed anyway), and its own check script. The Ticket Builder is unaffected —
  `human-picks.js` and `picks-parser.js` only *mention* it in comments.

### Corrected

1. **OTR never used the lean engine.** The proposal kept `lean-1.1` "as the deterministic
   picks-to-tickets template for OTR" and renamed the survivor `otr-lean`. But OTR cards
   already carry `template = engine_version = 'equibase-otr'` and are built by
   `server/equibase-otr.js`'s own `buildRaceTickets`. **The lean engine can go entirely**;
   no `otr-lean` needs to exist. The three surviving templates are the ones already in the
   database — `equibase-otr`, `llm`, `human` — and renaming them would churn live rows for
   nothing.
2. **Two removals are not leaf nodes.** `shared/card-engine.js` still owns `ENGINE_VERSION`,
   which `server/grading.js` imports, and `FAILURE_MODE_WARNINGS`, which `CardView.jsx`
   imports — both kept. `shared/entries-parser.js` owns `morningLineToDecimal`, which the new
   D104 parser uses. **Relocate all three before deleting either file**, or the removal phase
   breaks kept code. `shared/betmath.js` is the natural home for the odds helper.
3. **The motivating anecdote did not hold.** The proposal opened with "Haiku-generated cards
   are already observably useless". The corpus holds **1 Haiku card, 3 graded tickets,
   −$50**. Opus is −$232 over 3 cards / 135 tickets and Sonnet −$105 over 3 / 124 — so on the
   numbers Opus looks *worse*, and none of it is near significance. The thesis is sound and
   the "no P&L figure without its n" rule is exactly what catches this; the example was an
   impression of the kind the analyzer exists to replace.

---

## Command decision: Haiku is retired as an LLM option

**Decided 2026-09-05, after the correction above was accepted.** Haiku is no longer offered
in the model picker.

**This is a product decision about where to spend generations, not a finding.** The evidence
does not support a claim about the model, and this record should not be read as if it did.
It says: the operator does not want to spend further generations on it. That is a legitimate
call and needs no statistical backing — but conflating the two would poison exactly the kind
of reasoning the analyzer is being built to enable.

Implemented as a **retire, not a delete** (D105):

- `server/anthropic-client.js` gains `KNOWN_MODELS` — every model ever offered, retired ones
  flagged — with `SELECTABLE_MODELS` derived as the non-retired subset.
- `server/pl.js` builds its `byModel` labels from `KNOWN_MODELS`, **not** `SELECTABLE_MODELS`.
  This is the point of the split: that file previously derived labels from the picker list,
  so deleting the entry outright would have silently degraded the existing Haiku card to a
  raw id in P/L the moment the option disappeared.
- The existing card stays graded, visible and correctly labelled. Generating a *new* Haiku
  card is refused 400 by D75's existing model validation.

The same mechanism now exists for any future retirement.

---

## Sequencing that must be respected

1. **Archive before removing.** Copy the live SQLite read-only, export every card, and
   promote the graded-card regression fixtures — *before* a single deletion. There is no
   other copy of the 70-day corpus, the blind-play timestamps or the LLM request log.
2. **Prove the grader still reproduces archived summaries** before the factory reset. A
   mismatch means grading behaviour changed, which is a finding, not a rounding error.
3. **Relocate the three shared symbols** (correction 2) before deleting their files.
4. **Remove leaves before roots**, so the app builds at every step.
5. The parser (D104) was built **first**, ahead of the archive and removal phases, because it
   is pure and additive and unblocks everything downstream while risking nothing.

---

## Known open at the time of deciding

- **"Track-agnostic" is a claim, not a finding.** D104's only fixture is Del Mar; the first
  real target is Kentucky Downs. Parsing a KD page is what would settle it.
- **The live-odds path is untested.** The reference capture predates wagering, so live odds
  are empty in all 113 entries and only the morning-line fallback is exercised.
- **Deferred, not decided**: a paste parser for picks into the Ticket Builder; replay-card
  blindness (D54/D55), moot for live-only use; QR/here.now sharing; pool-impact concerns.
