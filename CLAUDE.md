# BetSheet — working notes

A horse race betting card generator and strategy tracker. Ingest a track
program, gather internet consensus, generate a betting card by confidence,
grade it against real results, and backtest strategies across many stored
cards.

Keep this file current. When a rule, invariant or feature status changes,
update it in the same commit as the change.

---

## The one rule everything else serves

**Benchmark first, bet later.** Phases 1–3 build the generate → grade →
simulate loop so the algorithm can be backtested and tuned across many stored
cards. Phase 4's at-track surfaces (PDF, here.now publish, mobile) only start
once backtesting proves out. Nothing in Phases 1–3 waits on anything in
Phase 4.

**D150-D155 built one deliberate exception, user decision 2026-09-07, and
D236 (user decision 2026-09-11) removed it.** The at-track MOBILE surface was
built ahead of that sequencing as a card CONSTRUCTION surface - no corpus, no
grading, no generation, no database - so it added HUMAN cards to the corpus
rather than consuming a benchmark that did not exist yet, which is what
earned it the exception. D236 removed construction entirely: the GitHub Pages
app is now a READ-ONLY viewer over race days, cards and grades the rest of
the app already produced. It is no longer an exception to the rule above,
because it no longer does the thing the rule was written to gate - it adds
nothing to the corpus and consumes only what Phases 1-3 already built, the
same as any other reporting surface in this codebase. The rule stands
unchanged for everything else in Phase 4.

---

## Invariants

Breaking any of these is a bug regardless of what the tests say.

**Invariants 1, 2, 3, 5 and 7 governed the LEAN ENGINE, which D111 deleted.**
Nothing generates a card any more - the three producers that remain (Equibase
OTR upload, LLM generation, human entry) each take tickets as given rather than
constructing them from rules. Those five are kept, marked, because they are
still true of every card in the stored corpus and are the reasons a future
generator, if one is ever built, would have to honour them. They are no longer
things live code can break. **Invariant 4 went with the consensus removal
(D112)** and is marked the same way, for the same reason.

1. *(engine-era)* **The place-money rule is mandatory.** Every win bet on a
   horse at 8-1 or higher automatically carries matching place money. No
   generated card may violate it. (Live longshots ran 2nd at $6.20 and $18.60
   place prices with win-only money on them.)
2. *(engine-era)* **All allocations sum exactly to the stated bankroll.** If
   the user edits tickets past the bankroll, warn — never block.
3. *(engine-era)* **Missing consensus never blocks card generation.** Program
   handicapper analysis and morning lines alone are sufficient. Every sheet
   labels which sources were used and which were unavailable, per race.
4. *(retired with consensus, D112)* **UNANIMOUS requires genuine
   multi-source agreement.** With fewer than 2 external sources, confidence
   caps at SPLIT — one source agreeing with itself is not a consensus. The
   D09 classification this governed is gone; the rule is kept as the record
   of what the stored UNANIMOUS/SPLIT/CHAOS values on historical races mean.
5. *(engine-era)* **Cut hedges, keep stacks.** Never dutch 3+ win bets in one
   race. Tickets covering different outcomes of the same thesis stay.
6. **Never scrape Equibase** (bot protection); results arrive as pasted chart
   text or uploaded chart PDFs. **D113 made this structural rather than a
   runtime rule**: with the crawler and the fetcher registry deleted there is
   no fetcher, no HTTP client and no robots checker left, because there is
   nothing left to fetch with. Every source of data is now a file a person
   chose to upload or paste. The rule stands for whatever is built next - if
   automated fetching ever returns, robots.txt is checked before every request
   and a source that resists falls back to manual paste. **D197 is the one
   deliberate exception this invariant's own text already anticipated,
   narrower than it sounds**: `server/apifyEquibase.js` calls the Apify
   API on demand to run `parseforge/equibase-scraper`, which scrapes
   Equibase server-side, on infrastructure the user pays for and
   explicitly triggers one call of at a time. BetSheet itself never sends
   Equibase a single request - no robots.txt question arises, because
   nothing here fetches equibase.com. Chosen 2026-09-09 (user decision) for
   minimum friction over this codebase's otherwise-universal manual-file
   posture; still no scheduling of any kind, ever - every call is a person
   running a command right now.
7. *(engine-era; the export half stands)* **Every generated card carries a
   complete decision trace.** The engine's own reasoning events are gone with
   it, but every producer still emits `card_generated` and one `ticket_added`
   per ticket, and `server/trace-export.js` still reads a card's trace back
   across rotated and gzipped logs and flags loss rather than exporting
   silence - see `traceStatus` there and in docs/trace-schema.md.
   Phase 3 must
   be able to replay "given these inputs, the algorithm decided X because Y"
   for every dollar on the card. The trace ships in the same PR as the
   engine, never after.
8. **One correlation ID per card session.** Every log event for a card's
   fetches, parses, generation, edits, grading and publishes carries it, so
   one card's history extracts as one coherent trace.
9. **Parsers never save without a preview, and the preview is read-only.**
   Every ingest path (entries, picks, result charts) shows exactly what Save
   will store — warnings first — and the user confirms before anything is
   written. Corrections happen at the source (fix the pasted text, re-parse),
   never by hand-editing the parser's output in the preview. **The ONE
   exception is the batch backfill (D43, user decision 2026-09-01, policy
   A):** a day whose parse has ZERO blocking warnings (unparsed distance,
   race-count mismatch vs the calendar, index validation failure, results
   race-count mismatch, program/ML conflict on program numbers, a foreign
   program - D46: the Breeders' Cup official program on BC days) is saved
   without a click; any blocking warning sends the day to the review queue
   with its read-only preview, unsaved until confirmed in the UI.
   The race-count check uses the calendar count when the calendar carried
   one; otherwise (a past meet indexed by its meet-dates table, D47) the ML
   sheet, the program and the results page must agree, blocking otherwise.
10. **The server binds 127.0.0.1.** BetSheet is local-only; sharing is the
    here.now publish feature's job (Phase 4). Published cards contain card
    data only, never personal information. **D154 added the one other thing
    that leaves this machine**: the GitHub Pages static builder publishes a
    race-day PAYLOAD (entries, morning lines, wager menus - what Equibase
    already prints publicly) so cards can be built on a phone at the track.
    The server is untouched and still loopback-only; the Pages app has no
    server at all. Two rules ride on it: a **Pages site is publicly readable
    even from a private repo**, so the deployed payload is built WITHOUT
    `--reference-cards` unless publishing the day's own LLM/OTR picks is a
    deliberate choice; and nothing personal, no grade and no corpus row ever
    enters a payload.
11. **A failing source must be visible.** Every fetch attempt lands in the
    fetch audit log; a source going quiet must surface in the UI, never
    silently thin the cards.
12. **Soft-deleted race days are excluded everywhere by default.** Deleting
    a race day sets `race_days.deleted_at`; every query and aggregate —
    including every future Phase 2/3 P/L and simulation query — filters
    `deleted_at IS NULL` (children cascade by the race_day join, no child
    flags). Decision-trace and fetch-audit LOG FILES are never touched by
    deletion: a deleted day's history stays readable under its correlation
    ids, and the deletion itself is logged as a trace event. Restore is
    always available from the deleted list. **Race-day ids are never
    reused** (migration 006, AUTOINCREMENT): superseding a tombstone mints
    a fresh id and logs `race_day_superseded` naming the old id/correlation
    — found live when a superseded day inherited the deleted day's rowid
    and the trace went ambiguous. The ONE exception to logs-are-never-
    touched is the explicit factory reset (`npm run reset -- --yes` or the
    Danger zone's confirmed "Wipe everything"): it deletes every record
    AND every log file together, restarts the id sequence (safe only
    because the logs go too), and opens the fresh app log with an
    `app_reset` event.
13. **Completeness buckets never pool.** Every card records a
    `consensus_completeness` level (FULL / PARTIAL / PROGRAM_ONLY /
    ODDS_ONLY - the D40 tier below PROGRAM_ONLY: no external sources AND no
    program analysis, the morning line is the only signal / HUMAN - D54: a
    human's own pasted tickets, never engine-generated or simulated /
    LLM_GENERATED - D63: an LLM's picks, generated manually one race at a
    time, never engine-generated or simulated / EQB_OTR - D71: Equibase's
    "Off to the Races" printed sheet, tickets taken verbatim, never
    engine-generated or simulated) from the sources that
    actually contributed. All P/L, simulation, and distribution reporting
    buckets by this level — a program-only backfill card and a
    full-consensus card never share an aggregate, and none of HUMAN,
    LLM_GENERATED or EQB_OTR ever shares one with any engine bucket or with
    each other. Structure-layer rules
    (place-money, hedge cuts, exotic construction, allocation curves) are
    benchmarkable on ANY bucket; signal-layer conclusions require the bucket
    that actually had the signal.
14. **Graded results are immutable per (card, engine_version).** The engine
    version (`ENGINE_VERSION` in shared/version.js, ONE place - it lived in
   shared/card-engine.js until D109 relocated it and D111 deleted that file) is
    bumped by every PR that changes generation, allocation, ticket
    construction or grading behavior, and every card and every grade set
    records the version it was produced under. Regeneration is append-only
    (D28): a regen under a new version is a NEW card row; the old card and
    its grade stay intact. A regrade under the same version replaces its
    set; under a newer version it appends one - older sets stay readable.
    Improvement is measured by comparing versions, never by overwriting.
    P/L never pools across versions unless the user explicitly chooses
    "all versions". `lean-0` = pre-D34, provenance not recorded.
15. **HUMAN is a completeness bucket; human cards never pool with engine
    cards; blindness is derived from timestamps, never set by hand.**
    (D54/D55) A human's pasted tickets are graded by the same grader as
    any card, but `consensus_completeness = 'HUMAN'` and
    `engine_version = 'human'` keep every aggregate (P/L, Distributions,
    the standing table) separate from every engine bucket and every
    `lean-*` version. Whether a played day was PRE_COMMIT, SEQUENTIAL or
    NON_BLIND is computed from `human_race_state.picks_locked_at` /
    `results_revealed_at` (`shared/replay.js`'s `computeBlindness`) - never
    a flag a person sets. `race_days.replayed_at` and a card's
    `saw_classification` are the only recorded facts; everything else
    about blindness is derived fresh on every read.

---

## Architecture map

Moved to `docs/architecture-map.md` (D208, user request) — the map itself is
unchanged, only its location. It stopped being loaded into every session by
this move, so update it in the same commit as any change that adds,
renames or repurposes a file, exactly as before; nothing about when or how
carefully it's kept current changes because it now lives in a second file.

---

## Commands

Moved to `docs/commands.md` (D219, user request) - the list itself is
unchanged, only its location. **A PR that adds, renames or retires a command
still updates that file in the same commit**; nothing about how carefully it
is kept current changes because it now lives in a second file.

The four you need before you can read anything else:

```bash
npm start                # build + serve on 127.0.0.1:8788
npm run dev:preview      # the AGENT's dev stack (api :8795 / vite :5185) - never the human's pair
npm run allocate-deliverable -- --title "..."   # claim a D number BEFORE naming a branch (D203)
npm run gh -- pr list    # the GitHub API, through the credential git already has (D101)
```

---

## Delivery workflow

- **Every deliverable is its own PR** — small, independently reviewable,
  independently revertable. The full sequence lives in `DELIVERABLES.md`,
  which is the ledger: every PR updates its own row (ID, phase, PR#/branch,
  status, notes) in the same PR.
- `REQUIREMENTS.md` maps requirements → deliverable IDs.
- **Claim the D number with `npm run allocate-deliverable -- --title "..."`
  BEFORE naming a branch or writing a ledger row (D203).** Reading
  DELIVERABLES.md/CLAUDE.md and picking "the highest number plus one" by eye
  is the exact race that let two concurrent sessions both claim D200 - the
  loser had to renumber to D201 on rebase (see that row). The allocator
  claims atomically from a database shared by every worktree on this
  machine; see `scripts/lib/deliverable-numbers.js`'s own header for how.
- Feature branches off `main`, short kebab-case names, PR into `main`.
  **Claude opens AND merges its own PRs into `main`, without asking each
  time** - a standing authorization for the duration of this project (user
  decision 2026-09-05, D106). It supersedes the per-PR rule D101 introduced,
  which itself replaced "Claude never merges". The reason for the change is
  that the ceremony was not buying review, it was buying AMBIGUITY: the
  session had to infer from a "merged" in chat what had actually landed, and
  got it wrong repeatedly - resolving conflicts on the wrong branch, stacking
  on an unmerged base, writing a ledger row against an ID that was already
  taken. Being the one who merges removes the guessing entirely.
  **Nothing else about the discipline relaxes, and one thing tightens: with
  no second pair of eyes before `main`, the check suite is the only gate, so
  it runs BEFORE every merge, not after.** Claude still never merges a red
  branch, never merges to get around a failing check, and still reports what
  landed. Every deliverable is still its own PR with its own ledger row, so
  the history stays reviewable after the fact and any one change stays
  revertable. A direct push to `main` is still refused by the tracked
  pre-push hook (`npm run install-hooks`) - `main` moves by merge, never by
  push, even now.
- A PR description states what it delivers, how it was tested (with
  evidence), and any deviations from plan. **That shape now lives in
  `.github/pull_request_template.md` (D227)**, which GitHub pre-fills a new
  PR with and which carries the definition-of-done boxes below. The template
  is a LAYOUT, never a second rulebook: it deliberately holds no rule of its
  own, so a new rule goes here and only then, if useful, gets a box there -
  otherwise the two drift and the file loaded into every session stops being
  the authority.
- Too big to review = split it and add rows to DELIVERABLES.md.
- **QA branch deliverables carry a `-QA` suffix on their ID** (`D44-QA`): a PR
  merged from `qa` gets the suffix in DELIVERABLES.md, in
  `docs/feature-status.md` and wherever the ID is cited, so the plain D-sequence stays
  reserved for the planned deliverables (user rule, 2026-09-02).

## Definition of done

Before a branch is reported ready, verify — out loud, in the final message:
1. `DELIVERABLES.md` row updated (status, PR#/branch, notes).
2. The right file reflects the change, and there are FOUR - three of them
   former sections of `CLAUDE.md`, kept current exactly as they were then
   (the moves changed where they live, never when they are updated):
   `CLAUDE.md` for a changed invariant, workflow rule, house rule or gotcha;
   `docs/commands.md` for a command added, renamed, retired or changed in
   meaning (D219); `docs/feature-status.md` for a feature's state and its
   one-paragraph row (D219); `docs/architecture-map.md` for a file added,
   renamed or repurposed (D208).
3. Verification scaled to what changed: presentation-only diffs need
   `npm run build` to exit 0; anything touching `shared/`, `server/`,
   parsers, the schema or an API contract needs the relevant check scripts
   to exit 0. State which category applied.

---

## Feature status

Moved to `docs/feature-status.md` (D219, user request) - the table itself is
unchanged, only its location. It was 107k of this file's 186k, and a ledger
read one row at a time has no more reason to be loaded into every session
than the architecture map D208 moved out for the same reason. **Every PR
still updates its own row there, in the same commit as the change.**

**This file has now been trimmed four times and had three sections moved out
of it.** The trims, each because cells had grown into second copies of their
ledger entries: 2026-09-04 at 165k (feature rows), 2026-09-06 at 168k
(architecture cells, plus collapsing the feature rows for what the pivot
deleted), 2026-09-07 at 193k (both sections again, after six weeks of
D136-D149 work regrew them), and 2026-09-08 at 178k (the 71 settled pre-D130
feature rows collapsed into seven ERA rows, plus the fattest architecture
cells stripped of deliverable history - 178k to 148k). Then the moves, once
it was clear that trimming a reference table only buys time: `docs/architecture-map.md`
(D208), and `docs/commands.md` + `docs/feature-status.md` (D219, together
taking this file from 186k to about 63k). **The house rule those five
interventions produced is in Gotchas** - it says what earns a place in this
file and what belongs in `docs/`, so the next reference table is never added
here in the first place.

**All four trims are reversible.** The rows as they read before each are
preserved verbatim in `docs/feature-notes.md` (2026-09-04),
`docs/claude-md-pre-trim-2026-09-06.md` (2026-09-06),
`docs/claude-md-pre-trim-2026-09-07.md` (2026-09-07) and
`docs/claude-md-pre-trim-2026-09-08.md` (2026-09-08) - frozen snapshots, never
updated, for the rare case where a compressed cell dropped a detail its ledger
row words differently. The three MOVES need no such snapshot: nothing was
compressed, and `git log` on the moved file reaches the same text.

---

## Findings

Findings live in `docs/findings/`, one file per **(engine version, bucket,
corpus)**. **Read `docs/findings/README.md` first** - it says which files are
live and which are history, and D114 wrote it for exactly that reason.

The pivot relaxed the discipline these were written under, from "a hypothesis
before any engine change" to **"label everything, conclude nothing until n is
stated"**. A deliberate loosening, not an abandonment: the old rule guarded an
engine that has since been deleted, the new one guards the analyzer replacing
it. Rules still in force:

- Written from run or card IDs, never from memory; every number cites its
  source. It states what is NOT concluded and the exact question the next
  corpus must answer.
- **No P&L figure without its `n`.** The rule the pivot kept most
  deliberately - the pivot's own motivating anecdote turned out to rest on 1
  card and 3 graded tickets, with another model looking worse on more data.
- A findings file is **never edited after the thing it describes is
  superseded**. A correction to a LIVE file is fine, with the date. An
  amendment recording a change in the world AROUND the file - a deleted
  engine, a changed prompt - is not a revision of a finding and is allowed;
  both existing files now carry one.
- `lean-1.1-program-only.md` is **history**: its engine was deleted rather
  than superseded, so no `lean-1.2` file will follow it. Its run citations
  stay checkable against the frozen snapshot (D107), which is part of why
  that snapshot was taken before any removal began.

---

## Gotchas

- **CLAUDE.md holds RULES; a reference table belongs in `docs/` - HOUSE
  RULE** (user rule, 2026-09-10, D219). This file is loaded in full into
  every session, so its size is a tax paid on every turn whether or not the
  content is read. What earns a place here is what a reader must know
  BEFORE they know they need it: the invariants, the delivery workflow, the
  definition of done, the house rules, and the gotchas - each one a thing
  that changes what you do, and each one useless if you only find it after
  the fact. What does NOT earn a place is anything a reader LOOKS UP: a
  command list, a per-file architecture table, a feature-by-feature ledger.
  Those are read one row at a time, by someone who already knows what they
  are looking for, and `docs/` is where they go - `docs/commands.md`,
  `docs/feature-status.md`, `docs/architecture-map.md` today.
  **The rule is about the shape of the content, not its importance**: the
  moved files are not less authoritative, and a PR still updates its row in
  the same commit as the change, exactly as before. **The evidence for the
  rule is that trimming did not work.** This file was trimmed four times in
  five days (165k, 168k, 193k, 178k), each trim genuinely compressing real
  duplication, and it was back to 186k within two days of the last one -
  because a growing table grows again, and the compression is a one-off
  while the growth is continuous. Moving the table out of the loaded file
  ends that loop rather than resetting it. **So: before adding a new SECTION
  here, ask whether it is a rule or a lookup.** A lookup gets a file under
  `docs/` and a pointer paragraph here - and the pointer is not a courtesy,
  it is what stops the next session rebuilding the table in this file
  because it could not find the real one.
- **A blocking parse warning is a REFUSED LINE, not a refused ticket - the
  ticket never existed** (D215). Every blocking path in
  `shared/parsers/human-picks.js` returns without pushing onto `tickets`:
  `parseColumnRow` and `parseTellerTicketString` return null before a spec
  exists, and `buildTickets` returns early on every structural, resolution and
  wager-menu refusal. So `parsed.tickets` is ALREADY the survivors, and code
  that saw `warnings.some(w => w.blocking)` and refused the whole save was not
  preventing a bad bet from being stored - it was discarding the good tickets
  parsed from the same block. That cost real work: five LLM generations on
  Horseshoe Indianapolis, 2026-09-10, each had one unbuyable line and 4-5
  legal tickets, and the user kept none of them. `persistLlmRace` now saves
  the survivors and logs a `ticket_refused` trace event per refusal.
  **`server/human-cards.js` deliberately still refuses** - a human can fix the
  pasted text and re-parse, which is the correction route invariant 9 requires,
  and silently dropping a line a person typed is the hand-editing it forbids;
  a paid model response has no source to fix, which is the whole difference.
  **The one case that must keep refusing** is a race where EVERY line was
  refused: an empty save is indistinguishable from the model deciding no bet is
  worth making, which is a real outcome the prompt asks for and the thing the
  LLM_GENERATED bucket measures.
- **A line that leads with money is only a teller ticket if it has no columns
  - and a mis-routed line is SHREDDED, not merely misread** (D214).
  `TELLER_LINE_RE` decides the grammar before any splitting, and its comment
  justifies that with "no bet type starts with '$', '.' or a digit" - a true
  statement about the `BET_TYPES` table, and not a statement about what a
  writer can put in the type column. An LLM wrote the wager menu's own base
  unit in front of the type (`50 cent trifecta | #4 / #3 / #5 | $0.50`), the
  line matched as teller, and `splitTellerTickets` then cut it on its own `/`
  separators into three fragments that each failed - one bad line, three
  blocking warnings, and a message (`unrecognized bet type in "50 cent
  trifecta | #4"`) naming a fragment nobody wrote. **`isColumnRow` now settles
  it structurally**: three or more non-empty `|`-separated columns is the
  column grammar whatever the line starts with, because the teller grammar has
  no `|` in it at all. Two columns stays on the teller path deliberately, so
  `$2 EX BOX 1-2 | note` behaves as it always has. The general lesson is about
  the comment as much as the code: "provably disjoint" was proved about a
  lookup table, and the input does not come from the lookup table.
- **A wager menu's minimum is only as good as the money token the parser can
  see, and a missed one FAILS CLOSED - it refuses a legal bet** (D213).
  `parseWagerMenu` falls back to `BET.minimums` for any bet type its patterns
  do not match, and that fallback is silent: nothing warns, nothing labels the
  minimum as assumed, and the first sign of trouble is a ticket being refused
  as "below the minimum" for a price the track actually sells. That is what
  happened live at Woodbine, whose menu prints `0.20 Trifecta` with no `$` and
  no `c` - a shape the old `(\$[\d.]+|\d+c)` token could not match - so a legal
  24-combo $4.80 trifecta box was blocked against a fallback 50c minimum.
  **The forms in this corpus are more varied than they look**, and they come in
  TWO shapes: amount-then-name (`$1`, `$.50`, `50c`, `20 Cent`, `10 cent`,
  `.50`, `0.20`, plus `Exactor`/`Triactor` at Canadian tracks) and
  name-then-parenthetical (`Trifecta (.50)`, `Super (.10)`, `Pick 3 ($1)`,
  `$1 Superfecta (10c min)`), the second added by D214. When a new track's menu
  arrives, check `parseWagerMenu` against it rather than assuming - one shape is
  still unread, an amount separated from its bet type by a word
  (`$3 PRIME PICK 3`), harmless today only because it coincides with the
  fallback. **A near-miss regex here fails silently and expensively**: the
  pre-D214 superfecta rule demanded the exact spelling `(10c min)`, so Del Mar's
  own `(10c min.)` and `(10-cent min)` fell through to `$1 Superfecta` and the
  home track's dime-super minimum read as $1 across the whole corpus, unnoticed
  until a corpus-wide diff went looking. **Diff a menu change against every
  stored `races.wager_menu` before believing it** - the old and new parsers side
  by side over all 488 of them is what caught this, and it is cheap.
  **A bare INTEGER must never be read as an amount**: `Double ($1) 9 & 10
  Pick 3 ($1) (9-11)` is a real stored menu, and a bare-integer token would
  read that race pair as a $10 Pick 3. The bare form requires a decimal point,
  and `check-human-picks` pins that with a named negative control.
- **Every warning object needs a `message:` string - `ParsePreview.jsx`
  renders `w.message` with nothing else to fall back on** (D207). Every
  parser under `shared/parsers/` that predates the Apify sources
  (`equibase-entries.js`, `equibase-otr.js`, `human-picks.js`,
  `dmtc-results-parser.js`, `chart-parser.js`) attaches a human-readable
  `message` to every warning it pushes, alongside the structured `type`/
  `blocking`/data fields a check script hand-counts against. The two Apify
  parsers (`equibase-apify-parseforge.js`, D190/D192;
  `equibase-apify-results.js`, D193) never did - every warning site in both
  pushed only the structured fields, so a live Apify entries preview showed
  "N parse warnings" followed by N genuinely empty bullets, for as long as
  those parsers have existed. The structured data was always correct; only
  the prose was missing, which is exactly why the check scripts (which
  assert on `type` and structured fields, never on rendering) never caught
  it. **A new parser or a new warning site in an existing one must set
  `message` on every push** - both Apify check scripts now run a
  `checkMessages()` helper asserting a non-empty `message` on every warning
  they produce, and any new parser's check script should do the same rather
  than trust that structured-field assertions alone prove the UI shows
  something.
- **`?replace=1` / `--replace` HARD-DELETES the day it replaces - it is NOT
  the same operation as the trash/restore "Delete race day" flow, and there
  is no undo** (found live, 2026-09-09, D204). `POST /api/race-days` with
  `replace: true` against an existing, non-deleted day runs
  `db.prepare('DELETE FROM race_days WHERE id = ?').run(existing.id)`
  (`server/ingest.js:284`) - a real SQL delete, cascading away every card
  and ticket on that day via the schema's `ON DELETE CASCADE`, before
  inserting the replacement under a fresh id. This is DELIBERATE and
  matches invariant 12's own summary ("replacing a day mints a new id"),
  but it is easy to conflate with the UI's ordinary "Delete race day"
  button, which is genuinely soft (`deleted_at`, restorable, invariant 12's
  main text) - replace is a different, harder operation that happens to
  share a log event name (`race_day_deleted`) with the soft path. Cost real
  data live: a Kentucky Downs 2026-09-09 day was manually pasted from
  Equibase's HTML page with the full, correct 14-race card (168 entries,
  zero warnings) and 3 human cards built on it (98 tickets); a later live
  Apify pull for the SAME track+date, saved with `--replace` because a day
  already existed, permanently destroyed all of it to make room for an
  Apify capture that itself turned out to be short (see the next entry) -
  and a SECOND `--replace` a few hours later destroyed that attempt too.
  **Before replacing a day that already has real work on it (cards,
  tickets, notes), check what's on it first** - `GET /api/race-days/:id/cards`
  or the day view - since replace does not ask again and cannot be undone
  from the trash list; the soft-delete/restore path exists for a reason
  replace deliberately opts out of.
- **The actor's own `maxItems` default silently TRUNCATES a big field
  instead of erroring - always set it explicitly (D205).** Found live,
  2026-09-09: Kentucky Downs, an actual 14-race/168-entry card (confirmed
  by a same-day HTML-sourced pull that got it exactly right), came back
  from TWO SEPARATE live Apify pulls as 2 races then 9 races - never the
  full 14, a different wrong number each time, no error either time.
  D204 first ruled out a local bug (`parseApifyParseforgeDataset` groups
  strictly by `raceNumber` with no capping; the app log's own
  `parse_completed` event recorded the same short count the instant each
  real call returned, before any of this codebase's own code touched it)
  and added `runId` logging so the actual cause could be checked against
  the actor's own run. **D205 confirmed it**: the user ran the identical
  input directly in the Apify portal and only got all 14 races/168 rows
  once `maxItems: 10000` was set explicitly - this codebase's own calls had
  never set it at all, relying entirely on the actor's own default, which
  is too low for a big field. `fetchEntries`/`fetchResults`
  (`server/apifyEquibase.js`) now default `maxItems` to 10000 - the exact
  value the user confirmed works, and generously above the largest single-
  track single-day row count on file (123) - the same "override the
  actor's own default rather than trust it" shape `includeWagers` already
  used for the identical reason (D197). Overridable via an explicit
  `maxItems` in the call, and costs nothing extra for a normal card: the
  actor's `costModel` (`shared/parsers/registry.js`) bills PER ITEM/PAGE
  actually produced, not per `maxItems` requested, so raising the cap only
  matters when the true count would have exceeded it. **`runId` logging
  (D204) stays valuable independently** - a future undercount from a
  different cause is still checkable via
  `console.apify.com/actors/runs/<id>` without re-paying for another call.
  **If a live pull's race/entry count still looks wrong after this fix, do
  not immediately retry it** - each retry is billed again, and combined
  with the entry above, a retry saved with `--replace` also destroys
  whatever was there before. Cross-check against a manually-saved HTML page
  first if one exists or can be gotten.
- **D numbers are claimed from a database now, not read off the highest row
  in a file - `npm run allocate-deliverable`** (D203). Multiple worktree
  agents used to pick their D number by reading DELIVERABLES.md/CLAUDE.md
  and incrementing the highest one they saw - a read-then-write race with no
  lock, and it produced a real collision: D200 was independently claimed by
  two concurrent sessions, and the loser renumbered to D201 on rebase (that
  row still records it). **Found again while building the fix itself**: `git
  log --oneline --all` across every worktree on this machine showed a THIRD,
  still-unmerged branch had already minted `D202` locally before this tool
  existed to stop it - so the allocator's first-ever seed was set to 203, not
  202, specifically to not collide with a claim the tool had no way to see
  coming. `scripts/lib/deliverable-numbers.js` fixes the class: a SQLite
  counter in the shared `.git` COMMON directory (`git rev-parse
  --git-common-dir` - confirmed by `git worktree list` to be the one thing
  every worktree of this checkout actually shares), claimed inside an
  immediate transaction with a busy-timeout and a JS-level retry, proven
  under 25 real concurrent child processes in `check-deliverable-numbers.js`.
  Numbers are never recycled even on `--release` (invariant 12's own
  reasoning: an abandoned number may already be cited somewhere by the time
  anyone notices). **This only coordinates worktrees on ONE machine** - a
  separate clone (betsheet-alt) or a cloud session has its own `.git` and
  cannot see this counter, and until D226 the advice here was to eyeball the
  ledger in that case. **D226 replaced that advice: run the allocator there
  too.** A brand-new database now SEEDS from DELIVERABLES.md's high-water
  mark instead of a hardcoded constant, so a fresh clone starts at the last
  merged row + 1 rather than reissuing D203 - which is exactly what a cloud
  session was handed on 2026-09-11, for the very work that fixed it. The
  CLI prints the seed and its source to stderr on that first run, so a wrong
  one is visible immediately rather than discovered by a human recognising
  the number. The seed can only ever be RAISED by the ledger, never lowered
  below the old constant, so a stale or half-written checkout falls back to
  the pre-D226 behaviour instead of handing out a spent number. **What has
  NOT changed: this is still not networked**, so it cannot see a number
  minted on an unmerged branch in a DIFFERENT clone - if you know of one,
  that is still yours to check by eye. A number in a merged row it now sees
  by itself.
  **D230 closed the two holes D226 left, and the second one had already
  cost a renumber.** (a) The seed was read ONCE, when the counter row was
  absent - correct where the counter is shared and authoritative, wrong in a
  separate clone, where nothing then ever taught it about a number merged
  upstream mid-session. (b) `DELIVERABLES.md` in the working tree is only as
  fresh as that clone's last pull: on 2026-09-11 a cloud session seeded from
  a checkout topping out at D223 and claimed D224, a number **merged to main
  69 minutes earlier** (#296 at 02:20Z, the claim at 03:29Z) - and then D225
  the same way. Both rows had to be renumbered to D228/D229 on rebase. The
  fix is `syncCounterFloor`: before EVERY claim, raise the counter to
  `max(counter, local ledger + 1, ORIGIN's ledger + 1)`, reading
  `origin/main:DELIVERABLES.md` with `git show` after a bounded `git fetch`.
  It only ever raises, so on a machine whose shared counter is already ahead
  it is a no-op. **The allocator never REQUIRES a network**: every remote
  failure path returns null and falls back to the local ledger, `--no-remote`
  and `BETSHEET_DELIVERABLE_NO_REMOTE=1` opt out, and the CLI says out loud
  when the strongest check did not run. **What is still NOT fixed, and you
  should know it**: two clones claiming within the same minute, before either
  merges, still collide - the window shrinks from "everything merged since my
  clone" to "everything merged since my last fetch". That residual is the
  D225 half of the same incident (#298 merged seven minutes AFTER the
  colliding claim). Closing it needs a server-side atomic claim; see the
  module header for the shape it would take.

- **Equibase does not publish live odds in any form this project can read - the column is a JS placeholder** (D232). The entries page HAS a `LiveOdds` column, which is why D228 built a capture path around uploading that page. It is EMPTY in the HTML Equibase serves: 123 of 123 cells in this repo's own `DMR090726USA-EQB` fixture, the header carrying `title="Live Odds refreshed every 60 seconds"` and the cells carrying nothing but `id`/`name` hooks for an external `/js/liveOdds.js`. So the values exist only in a live browser DOM. **Both capture shapes this codebase supports are therefore empty by construction, at any hour** - `shared/parsers/equibase-entries.js`'s own header defines them as the original server markup (`view-source:`, and Ctrl+S "Webpage, HTML Only"). The requirements doc's open question 2 read the empty column as "this capture predates wagering" and asked for a second capture closer to post; that was the wrong diagnosis, and a near-post capture of either shape would have been just as empty. **The Apify route is out for the same underlying reason**: the actor scrapes that same page server-side and never sees the JS output - checked across all three real datasets on file, entries rows carry `morningLineOdds`/`morningLineDecimal` and no live-odds field of any kind, results rows only the payoffs. **So the board is TYPED, per race, at post time** (D232), which is the same posture invariant 6 already describes for every other source here. **Chrome's "Webpage, Complete" was the last candidate and it does NOT work either** - tested by the user, 2026-09-11. So NO browser save method reaches the board: not view-source, not "HTML Only", not "Complete", and not the Apify actor. `LiveOddsModal.jsx`'s upload path still functions and is still correct, but **nothing known can feed it** - it is kept because its reconciler, refusals and capture history are what the typed path reuses, not because there is a capture to make. The general lesson: **a column existing in the markup is not the same as a column carrying data**, and the way to tell is to read the served bytes rather than the rendered page.
- **A check script's safety assumption about its target can go stale when
  the target changes independently of the check** (D201). D198 shipped
  `check-pull-apify-cli.js`'s "no token" test on the assumption that
  `delete env.APIFY_TOKEN` on the spawned child's env is enough to prove
  "no token means no call" - true at the time, because neither
  `pull-apify-entries.js` nor `pull-apify-results.js` loaded dotenv at all.
  D199 fixed a REAL bug in those two scripts (they never picked up
  `.env`'s `APIFY_TOKEN`) by adding `import 'dotenv/config'` - which
  quietly broke the check's assumption from the other side: dotenv fills
  in any key still missing from `process.env` by reading `.env` straight
  off disk, so the check's stripped env no longer stops the real token
  from loading. As merged, `npm run check-pull-apify-cli` would load the
  REAL `.env` token into the exact test case meant to prove a live,
  billed Apify call is impossible without one - on any machine with a
  token configured, which this one has had since D193/D194. Found only
  by reading the check's own logic again before running it, not by it
  failing (it would have "passed" - the test never asserts no network
  call happened, only that the CLI reports a clean refusal, and it never
  got the chance to because the token loaded before the CLI's own
  `hasToken()` check ran). **The general rule**: when a fix changes how a
  script under test acquires a credential or makes a call, re-read every
  check that constructs "no credential" or "no call" scenarios for that
  script - stripping an env var is only a valid test of "no credential"
  for as long as the script's OWN acquisition path agrees that stripping
  it is sufficient. Fixed by pointing `DOTENV_CONFIG_PATH` at a path that
  cannot exist in the `clearToken` case, so `.env` is never found
  regardless of what's on disk - the same fix `check-pull-apify-cli.js`
  already needed and got for itself in D198, before D199 broke it again
  from the opposite direction.
- **`npm run dev` uses `scripts/dev-watch.js`, NOT `node --watch`** (D77-A).
  Node's watch mode restarts on any filesystem notification for a loaded
  module file, and on Windows libuv's filter includes attribute/security
  changes - so a virus scan, the search indexer, a `git fetch`, an editor
  stat sweep or a repo-wide `find` restarts the API for a file whose bytes
  and mtime never changed. Proven 2026-09-04: `fs.utimesSync(f, ..., st.mtime)`
  on `server/pl.js` makes `node --watch` print "Restarting". That is what
  killed an in-flight `/api/fetch/ml-sheet` mid-ingest and surfaced as
  `[vite] http proxy error: read ECONNRESET` - the API was not crashing
  (no `uncaught_exception` in the app log, and `node --watch` does not
  respawn after a throw OR a V8 OOM abort - both verified; it only respawns
  on a file change). It cannot be fixed inside the server: on Windows the
  watcher force-kills the child (TerminateProcess - SIGTERM is not
  deliverable, a handler never runs), so in-flight sockets are always reset.
  `dev-watch.js` hashes every watched file and restarts only when a hash
  actually moves. `--watch-path` is not an alternative: it restarts on ANY
  change under the path, and the D02 log streams live in `server/logs/`.
- **A dropped `/api` connection in dev answers 503 JSON, not a raw reset.**
  `vite.config.js`'s proxy has an `error` handler that replies with the
  `{ error }` shape `client/src/api.js`'s `asJson` already reads, so the UI
  shows a sentence. Vite attaches its own listener AFTER `configure`, so its
  red `http proxy error` stack still prints below our one-line `[api proxy]`
  summary - expected, not a second fault. The proxy targets `127.0.0.1`, not
  `localhost`: the server binds IPv4 loopback only (invariant 10) while
  `localhost` on Windows resolves `::1` first.
- **A malformed PDF can crash the whole server, not just its own request.**
  Found live 2026-09-03: uploading a chart PDF sometimes killed every
  in-flight request with `ECONNRESET` at the vite proxy, then `node --watch`
  restarted the API - the giveaway was the "BetSheet listening" banner
  reappearing right after the proxy error with no other cause. Root cause:
  pdfjs-dist's Node "fake worker" can throw from its own message-dispatch
  timer, outside any route's `await`/try-catch, which Node treats as an
  uncaught exception and kills the process. Fixed in two places, `server/
  index.js` and `server/pdf-text.js`: process-level `uncaughtException`/
  `unhandledRejection` handlers now log via the app stream instead of
  crashing (no route holds an open DB transaction a bad PDF could corrupt,
  so staying up is safe), and `extractPdfLines` races extraction against a
  45s timeout so a wedged pdfjs promise returns an honest error instead of
  hanging the request forever.
- **Deleting a base branch CLOSES its stacked PRs; it does not retarget
  them.** Learned 2026-09-05: after merging D104 (#141), deleting
  `equibase-entries-parser` to make the stacked D105 PR (#142) retarget to
  `main` instead closed #142 outright. GitHub retargets children only when
  the base PR is merged through it, not when the branch is removed
  underneath. The work was safe on its own branch and a replacement PR
  (#143) merged clean, but the tidy-up cost a PR number. **Merge the stack
  bottom-up and leave the base branch alone until every child is merged.**
- **The GitHub API IS reachable from here - via the credential git already
  has** (D101). `gh` is NOT installed and the repo is private, so a bare
  `curl https://api.github.com/...` returns `Not Found` and looks like a dead
  end. It is not: pushes authenticate through Git Credential Manager, and
  `npm run gh -- pr <n>` uses that same credential. Do not infer a PR number
  from ordering - look it up. Guessing is what turned "resolve the conflicts
  on #133" into resolving the wrong branch entirely on 2026-09-05.
  Server-side branch protection is genuinely unavailable (Free account +
  private repo -> 403 "Upgrade to GitHub Pro or make this repository
  public"), which is why the guard on `main` is a local hook.
- **This machine's Bash tool quirks** (inherited from life-swipe, they apply
  here too): `PATH` needs exporting before node/git resolve; `/tmp` means two
  different directories (bash → AppData, node → `C:\tmp`) so use full Windows
  paths for anything node opens; heredocs truncate near 8KB — write long
  files in chunks; git identity may not resolve from the global config —
  this repo carries a local `user.name`/`user.email`.
- **Ports**: BetSheet uses api :8788 / vite :5175 for the HUMAN's `npm run dev`
  and for `npm start`. An AGENT's browser-verification stack must use
  `npm run dev:preview` (api :8795 / vite :5185, D97) and never the human's
  pair - `.claude/launch.json` already points there, so `preview_start` gets
  it for free; do not hand-run `npm run dev` to verify. betsheet-alt is
  :8798/:5178. life-swipe owns :8787 and :5173/:5174 on this machine — don't
  squat on them. The check scripts each bind a fixed port in **8899–8920**
  (betsheet-alt's old 8902 sat inside that band), so a long-running instance
  must stay out of it. 8790/5177 is the escape hatch the preflight prints;
  leave it free. **The static Pages target owns its own pair** (D151/D155):
  `npm run dev:static` is vite :5186 and `npm run preview:static` is :5187,
  both in `.claude/launch.json`. Neither has an API half - the static app has
  no server - and the service worker registers only in a PRODUCTION build, so
  `preview:static` on :5187 is the only way to exercise it.
- **A stale `npm run dev` outlives its shell, and used to fail silently** (D80).
  `concurrently -k` only kills siblings when concurrently itself exits, so a
  closed terminal or an ended session orphans the whole tree, which keeps
  :8788 and :5175 indefinitely. Found live 2026-09-04 with two stacks up at
  once. The old failure mode was the dangerous part: vite silently walked to
  :5176 while the API hard-failed, so a NEW front end proxied `/api` to the
  OLD stack's server and edits appeared not to take effect. Now
  `strictPort: true` makes vite refuse, `scripts/dev-preflight.js` refuses
  before either half starts and names the process AND its tree root, and
  `npm run dev:clean` stops stale stacks. Killing the process that holds the
  port is usually wrong - it is supervised, and its parent respawns it.
  **A dev stack is not the only thing that holds 8788** (found live
  2026-09-05): `npm start` binds it too, so "port in use" can mean a served
  build rather than a stale `npm run dev`. `dev:clean` catches it anyway - it
  sweeps whoever holds a CONFIGURED port, since you cannot start without
  those - but the holder line is worth reading before assuming an orphan.
  D97 adds `npm run dev:restart` (dev:clean --yes then dev) because the
  two-step remedy is itself part of why a stale stack stayed in the way.
- **The scratch instance is a SEPARATE CLONE now (D83).** `betsheet-alt` in C:/repos/.claude/launch.json runs `C:\repos\betsheet-alt`, its own checkout, with ONLY `BETSHEET_PORT=8798` / `BETSHEET_VITE_PORT=5178` overridden (plus `BETSHEET_RAW_DIR` pointed at this repo's archive, which a reset provably never touches). Those overrides live in that clone's own `.env` and every dev entry point loads it - `server/index.js` always did, and `scripts/dev-preflight.js`, `scripts/dev-watch.js`, `scripts/dev-clean.js` and `vite.config.js` do since D83 - so the whole stack moves together and no env prefix has to be remembered on the command line. That matters because `set X=Y&& ...` is cmd.exe syntax: in Git Bash `set` assigns positional parameters and exports nothing, so the ports silently stayed at 8788/5175 and the preflight correctly (and confusingly) named the MAIN app as the process in the way - hit live 2026-09-04 following this repo's own README. It used to run THIS checkout with `BETSHEET_DB` / `BETSHEET_LOG_DIR` / `BETSHEET_OTR_ARCHIVE_DIR` redirected, which was correct only as long as every override was remembered - one missing var and `npm run reset -- --yes` lands on the real 74-day corpus. In a separate clone every path default resolves inside that clone, so the isolation is structural. The original lesson stands and is what motivated all of it: the two instances once shared `server/logs`, and either side's factory reset silently wiped the other's decision traces (found live: exports came back `traceStatus=missing`) - never point two instances at one log dir, one DB, or one OTR archive (a confirm's `confirmed_sha256` in the archive's manifest.json is what makes `npm run ingest-otr` skip a day as already done). A reset touches exactly two paths, `BETSHEET_DB` and `BETSHEET_LOG_DIR`; `data/raw`, `data/archive`, `tests/fixtures`, `docs/backfill` and `data/meets` are never touched. Ports: stay out of **8899-8920**, the check-script band - the old alt port 8902 sat inside it. See README's "The scratch environment" for the full setup.
- **An effect that fetches must also guard against its own stale response**
  (D118). Two renders in quick succession - a toggle clicked twice, a filter
  changed and changed back - leave two fetches in flight with no ordering
  guarantee, and the FIRST one's answer can land last and overwrite the
  second's. Found live 2026-09-06 on the deleted-days list: 75 rows on the
  wire, "No deleted race days." on the screen. **It was latent for months**
  because the active list was never empty, so a superseded active response
  still rendered a plausible table - the bug only became visible the first
  time the corpus was hidden. Set a `cancelled` flag in the effect and return
  `() => { cancelled = true; }` as the cleanup, which is a FUNCTION and so
  also satisfies the rule above.
- **HISTORICAL (the mechanism is gone, the lesson is kept - D236 removed the
  static app's ticket construction, this is now a record of what its bug
  taught, not a live warning about current code). State that must track a
  prop is adjusted during RENDER, not in an effect** (D155). `RaceView.jsx`
  used to keep a snapshot of a race's already-saved ticket text and compose
  the builder's output on top of it. Reading that text LIVE duplicated every
  ticket: the saved card flowed back down as a prop, the snapshot became the
  sum, and the next render recomputed `$20 W 1` as `$20 W 1 / $20 W 1` - with
  no new event at all, the render alone did it. Moving the snapshot into a
  `useEffect` fixed that and broke something worse: **child effects run
  before parent effects**, so `TicketBuilder`'s mount-time `onChange('')`
  fired while the parent still held the previous (empty) snapshot and wrote
  an empty race over saved text - re-opening a race erased the work in it.
  Both were fixed by React's documented pattern for this exact case: compare
  a key during render and `setState` right there, so the new value is in
  place before any child commits. Neither bug was reachable from a check
  script (they needed a real render tree) and both were found by driving the
  app in a browser - which is why the general lesson (a value derived from a
  prop, and read by a child's mount-time effect, needs the render-time-key
  pattern) is worth keeping even though this specific screen no longer
  composes anything.
- **A call to action must be reachable without sideways scrolling on a phone
  - HOUSE RULE** (user rule, 2026-09-07, D157). Every UI in this codebase that
  a phone can reach must keep its primary action - the button the screen
  exists for - inside the viewport at 375px. Found live on the deployed Pages
  builder: the races grid carried Distance / Surface / Runners between the
  post time and the **Build** button, `.grid { overflow-x: auto }` stopped the
  page from stretching by pushing the RIGHTMOST column out of sight, and the
  rightmost column in these tables is always the button. The table looked
  fine; the only thing you could not reach was the one thing you came for.
  **The fix is to drop descriptive columns, never to shrink or move the
  action**: mark them `className="col-detail"`, which `static/src/static.css`
  hides below 720px, leaving identity + state + action. Applies to the cards
  table (Export / Forget) for the same reason. `scripts/check-static-app.js`
  asserts that every static table with a button column has `col-detail`
  columns, so a new table cannot quietly reintroduce the problem. Desktop is
  untouched and still shows every column - this is a mobile rule, not a
  simplification of the data.
- **This repo's browser harness fires NO `resize` and NO `matchMedia` change
  events** (D158). Its viewport emulation updates `window.innerWidth` and
  `matchMedia(q).matches` correctly, but dispatches neither event - measured as
  0 of each across a 375<->1000 crossing. So any code that reacts to a LIVE
  breakpoint change cannot be verified by driving the browser here, and a panel
  that fails to re-lay-out on resize is far more likely to be the harness than
  the code. Mount-time behaviour IS verifiable: reload at the target width and
  read. This cost a wrong diagnosis once - a `<details>` that stayed open across
  a simulated resize was blamed on React refusing to rewrite the `open`
  attribute, when in fact the hook feeding it had never been told anything
  changed.
- **A wrong Node version here is a SEGFAULT, not an install error** (D156).
  `better-sqlite3@13` requires node `>=22` and `pdfjs-dist@6` `>=22.13`, and
  **npm treats an engine mismatch as a WARNING** (`EBADENGINE`) unless
  `engine-strict` is set - so `npm ci` reports success, installs a native
  binding built for a different ABI, and the first `require` of it dies with
  exit 139. Found on the Pages workflow's very first run, which pinned node 20
  out of habit: `npm run check-static-app` crashed two seconds in having
  printed no output at all, which reads like a broken check and is nothing of
  the kind. `package.json` now declares `engines.node` and the workflow both
  pins node 24 and asserts the running version against that field before any
  check runs. **The local machine is node 24**, so nothing reproduces this
  locally - it is CI-only by construction, which is exactly why the assertion
  lives in the workflow.
- **`MSYS_NO_PATHCONV=1` is needed for a slash-leading ENV VALUE too**, not
  just for a slash-leading argument. Git Bash rewrote
  `BETSHEET_STATIC_BASE=/betsheet/` into `/Program Files/Git/betsheet/` while
  reproducing a CI build locally, producing asset URLs that would 404 on
  Pages. `scripts/gh-api.js` already documents the argument half of this
  (`/repos/x/y` arriving as a Windows path). CI runs bash on Linux and is
  unaffected; only local reproduction needs the prefix. Node's own
  `execFileSync({env})` bypasses the shell entirely, which is why
  `check-static-app`'s Pages-base assertion was always correct.
- **A service worker's cache lookups must pass `ignoreVary` here** (D155).
  Vite emits `<script crossorigin>` for its module bundle, so the browser
  sends those requests with an `Origin` header, while the worker's
  install-time `cache.add()` fetches them without one. Any server answering
  `Vary: Origin` - vite preview does, and static hosts commonly do - then
  makes `cache.match` MISS on exactly the requests the page needs. The
  symptom is nasty: the shell loads from cache, the bundle does not, and the
  screen is blank with a full and correct cache sitting right there. Safe to
  ignore Vary in this app because everything cached is same-origin and
  content-hashed. Related: a first visit does NOT populate the asset cache on
  its own - the page's own script/link requests are issued before the worker
  activates - so `sw.js` reads the hashed names out of `index.html` at
  install. Without that, offline works only from the second visit, which at a
  racetrack means it does not work.
- **A re-export creates NO local binding - and the symptom is a BLANK PAGE**
  (D172). `export { NOTE_SOURCE_LABELS as SOURCE_SUGGESTIONS } from '...'`
  re-exports the name without binding it locally, so the same file writing
  `SOURCE_SUGGESTIONS.map(...)` a few lines later throws
  `ReferenceError: SOURCE_SUGGESTIONS is not defined` - React unmounts the
  whole root and the page goes white with no notice. Shipped in D167 and found
  only by a live bug report: clicking "Generate Card from LLM" blanked
  `/day/:id`, because `NoteSourceDatalist` renders inside that modal.
  **Nothing in the build or the check suite could see it** - esbuild compiles a
  bare unresolved identifier as a global (it might be `window.foo`), and every
  check script is server-side and never renders a component body.
  `npm run check-module-bindings` (D172) now catches the whole class. **The fix
  is always: import the name, then export it** - `import { X } from '...'`
  then `export const Y = X;`. The same trap sits behind any consolidation that
  moves a constant into a shared module and leaves a re-export behind, which is
  exactly what D167 was.
- **`process.exit()` after a network fetch can ABORT this machine's node
  instead of exiting, and the shell then sees 127** (D218). Found in
  `scripts/gh-api.js`, whose `die()` ended in `process.exit(code)`: after a
  fetch to api.github.com the process died with `Assertion failed:
  !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` and returned
  **127** - conventionally "command not found" - rather than the 1 or 2 the
  script asked for. It looked like cosmetic noise printed after an otherwise
  correct message, which is why it sat there; it is not, because a caller
  branching on the exit status cannot tell a deliberate refusal from a broken
  command. Deterministic (5 of 5) on node 24 / Windows, and narrow: no fetch
  is fine, a **localhost** fetch is fine (so every check script that boots a
  temp server and exits 1 on failure is unaffected, which is why this never
  surfaced there), and https to example.com or registry.npmjs.org is fine -
  those carry `connection: keep-alive` where GitHub's response carries no
  `connection` header at all. Not DNS, not TLS alone, not compression, not
  reading the body - all four ruled out by experiment. **The rule to take
  from it is not "avoid api.github.com"**: it is that `process.exit()` is an
  abrupt, truncating stop that is only ever safe when nothing is in flight,
  and predicting that is not worth it. Set `process.exitCode` and let the
  loop drain - it exits with the right code, exits promptly (~0.5s; undici's
  pooled sockets do not hold the loop open), and cannot truncate a piped
  stdout write, which `process.exit()` also can. Where execution must stop
  from deep inside, throw a sentinel and let a top-level handler ignore it -
  and make that handler report every OTHER error with its stack, or a real
  bug exits 0 and looks like success. A negative control in `check-gh-api`
  pins exactly that, because it is the worse bug of the two.
- **An editable field must look editable AT REST, not on hover - HOUSE RULE** (user rule, 2026-09-11, D235). `.in` was `border: 1px solid transparent; background: transparent`, with the border appearing only on `:hover`. That is a LABEL until you touch it - no border, no contrast, and the single affordance hidden behind a gesture a touch device never performs. The user's report was exactly that: *"they look like labels... I shouldn't have to hover a field to indicate that is an update."* **The stylesheet already held the right answer twice** - `.formrow input` and `.pastebox textarea` both carried a real border and background - so there were two contradictory styles for one concept and the ghost was the one on the newest fields. **The fix is on the ELEMENTS, not on a class**: `input:not([type=checkbox]):not([type=radio]):not([type=file])`, `select` and `textarea` carry the border, field background, radius, padding and focus ring; `.in` is layout only (width). That is deliberate - 7 of this app's text-ish controls carried NO class at all (two date inputs, two number inputs, four selects, a textarea), and a style you must remember to apply is one that will be forgotten again. Tokens: `--color-field-border` is Radix step 7 (the "UI element border" step), not step 6 (`--color-border`, for dividers, which reads as decoration on a control). `:focus-visible` gets a real 3px ring - the old rule set `outline: none` and tinted a 1px border, which is the least a keyboard user can be given while still technically having focus. **Verified by driving the real app**, both themes and four routes, asserting `getComputedStyle` on every control: 0 borderless fields anywhere. **And one thing the new clarity exposed**: D232 had set the live-odds placeholder to the horse's morning line, which read as a hint on a ghost field and reads as a VALUE ALREADY ENTERED on a real one - it is now `"odds"`, and the M/L is in the adjacent column anyway.
- **A CSS class name in `client/src/styles.css` is a GLOBAL, and the file is
  long enough that a second meaning for one silently wins the cascade**
  (D216). There is one stylesheet for the whole client and no CSS modules, so
  a new component that picks an obvious semantic class name is picking from a
  namespace ~600 lines long that nobody re-reads. D216 added
  `.row--flagged td { background: var(--color-bg-raised) }` for a highlighted
  entry and did not know `DistributionView.jsx` had used `.row--flagged` since
  D27 for an OUTLIER DAY, painted `color-mix(... var(--red) 12% ...)` - a
  warning colour - from a rule ~280 lines further down. The later rule wins,
  so every Baffert runner and every five-horse favorite came up looking like a
  problem, in a stylesheet where both declarations are individually correct.
  **Nothing in the build or the check suite can see this**: the class names are
  strings, both components compile, both rules are valid CSS, and every
  server-side check never renders a page. It was found by reading
  `getComputedStyle(...).backgroundColor` on the live page and noticing the
  colour was red when the token said mauve - which is worth doing as a habit
  whenever a change adds a row/cell background. **`grep` the class name in
  `client/src/styles.css` AND in `client/src/components/` before adding a
  rule**, and prefer a name that says which feature it belongs to
  (`row--entry-flag`) over one that says how it feels (`row--flagged`) - the
  second is the one two features will both reach for.
- **Two sibling components must never both be keyed on a bare remount counter**
  (D181). `RaceDayView` used the D142 "bump a counter, pass it as `key`, get a
  remount" pattern TWICE - `<CardsPanel key={cardsVersion}>` and
  `<TipPicksPanel key={tipVersion}>` next to each other - and both counters
  start at `0`, so the two panels claimed the SAME key in one children list
  from the very first render. React reconciles a static children list by key
  whenever keys are present, and a duplicate key there is not a lint nag: the
  documented behaviour is that children are **duplicated or omitted**. Live
  symptom on `/day/268`: 2 "Betting cards" panels on a hard reload, 4 after
  clicking Delete race day, 5 after Cancel - the DOM accumulating a panel on
  every state change, with `#root` still holding exactly one child and not a
  single application error, which is why it read as a delete bug rather than a
  render bug. The console said so plainly ("Encountered two children with the
  same key, `0`", `at section at RaceDayView`) and is the fastest way to
  diagnose the class. **Namespace the key** - `` key={`cards-${cardsVersion}`} ``
  - so the value cannot collide with a neighbour's counter. Neither D142's nor
  D176's key was wrong on its own; the bug was created by putting the second
  one beside the first, so this is a rule about ADDING a sibling, and nothing
  in the check suite can catch it (the checks are server-side and never render
  React, and `npm run build` compiles it happily).
- **A React effect must never be handed a promise-returning function.**
  `useEffect(reload, deps)` where `reload` is `() => fetch(...).then(...)` stores
  the PROMISE as the effect's cleanup; on unmount React calls it and throws
  "destroy is not a function", which unmounts the entire root - the symptom is a
  BLANK SCREEN, not an error notice. Found live 2026-09-05 closing the day-level
  ticket builder. Always `useEffect(() => { reload(); }, deps)`. Nothing catches
  this automatically: the check scripts are server-side and never render React,
  and `npm run build` compiles it fine. When browser-verifying a dialog, assert
  the PAGE still rendered (`#root` still has children) - "the modal is gone" is
  also true when the app has crashed.
- **`check-static-app` is OUT OF SCOPE in a git worktree - HOUSE RULE** (user
  rule, 2026-09-08, D168). Do not run it, do not work around it, and do not
  treat its absence as a gap in a worktree's verification. A worktree has no
  `node_modules` of its own - module resolution walks UP to the parent
  checkout, which is why `npm run build` and every other check work fine there
  - while `scripts/check-static-app.js` spawns an ABSOLUTE
  `<repo>/node_modules/vite/bin/vite.js` that therefore does not exist. It
  fails identically on `main`, so a failure is never the branch's doing.
  **The rule is about effort, not correctness**: D167 got it running by
  creating a `node_modules` directory junction, which worked and was still the
  wrong move - it spent real time, left a stray junction behind that could make
  a later session think dependencies were installed locally, and bought
  nothing. Check the static app's IMPORT SURFACE instead - it is a separate
  Vite entry and reaches outside `static/` in exactly three places as of D236
  (re-derived that day; before it the count was seven, and TicketBuilder.jsx,
  human-picks.js and static-export.js all fell off once construction was
  removed and nothing under `static/src/` imported them directly any more -
  the list is the thing to re-derive rather than trust, every time):
  `@client/components/EntriesTable.jsx`, `@client/styles.css`,
  `@shared/static-payload.js`. A change touching none of those, nor `static/`
  itself, nor anything they transitively import, provably cannot move the
  static bundle. When a change DOES touch them, run the check from the
  primary checkout, where it works as designed. State plainly in the final
  message that it was skipped as out of scope per this rule - never imply the
  suite ran clean when this one did not run at all.
- **A race-specific input or edit belongs in the Race UI component - HOUSE
  RULE** (user rule, 2026-09-08, D182/D184). If a thing is an opinion about,
  or a property of, ONE race, the place to type it is that race's own panel,
  as tightly coupled to it as the code allows - not a day-level list, not a
  modal that enumerates every race, not a second screen. Analyst notes and tip
  sheets are both now entered exactly there, beside that race's entries.
  **The rule is about where a fact is AUTHORED, not about where it may be
  read**: the same note still renders read-only on the card sheet
  (`RaceNotes.jsx` in `CardSheet.jsx`, D237), because a card is a record of what was
  decided rather than a place to change it. A day-level surface survives only
  for things that are genuinely day-level - the WHOLE-DAY note (race 0), and
  tip-sheet STAKING, which splits the bankroll across every race that has
  picks and so cannot be expressed one race at a time. Before adding a
  day-level editor, the question to answer is "is this fact about the day, or
  about a race?", and only the first answer earns one. What the rule buys is
  concrete and was visible immediately: entering a note used to mean opening a
  dialog, finding the right race among twelve, and typing into a box with the
  entries no longer on screen - so the one thing you were reasoning about was
  the one thing you could not see.
- **A `.modal-backdrop` never closes its dialog on click - HOUSE RULE.** Only
  the header's × / Close button (and Escape, where a dialog offers it) may
  dismiss a modal. Found live 2026-09-06 on both of this app's modals: an
  accidental click outside `LlmCardModal` (D131) silently discarded an
  in-progress, possibly paid, LLM generation with no confirmation, and
  outside `DayTicketBuilderModal` (D132) it was worse - that modal's close
  path auto-LOCKS every cleanly-previewed race (D103), so the same stray
  click was a database write, not just a dismissed view. Neither modal had
  ever been asked to lose work or write data on an accidental click; the
  backdrop's `onClick={onClose}` (or equivalent) was just how the
  `modal-backdrop`/`modal` pattern in `styles.css` had always been wired.
  **Any new modal in this codebase must render `<div className="modal-backdrop">`
  with no click handler at all** - not `onClick={onClose}` with an inner
  `onClick={(e) => e.stopPropagation()}` to half-guard it, which is the
  pattern that was actually removed from both fixes. Escape-to-close, where
  present, is a deliberate keyboard affordance and is unaffected by this rule.
- **`resetApp(db)` takes a database; the log half of it does not.** `resetLogs()`
  reads the log directory the LOGGER was configured with, so running a reset
  against some other database - a copy, a probe, a fixture - still deletes the
  real log files. Found the hard way 2026-09-06: a reset run against a scratch
  copy of the corpus wiped 14 live log files, and every card's trace export has
  read `traceStatus: missing` since (the trace CONTENT survives in the committed
  `archive/exports/`, which is the whole reason D107 froze it). To reset a
  throwaway database only, point `BETSHEET_LOG_DIR` at a throwaway directory in
  the same process, before the logger is first used - which is exactly what
  `check-ingest.js` does, and why it was never affected.
- **Shipped migrations are immutable.** If an applied migration needs a repair, restore its original contents and add the fix as the next numbered migration. Migration 019 carries the D35 tombstone-collision repair that must not be added to 014 after release.
- **Equibase blocks scripted fetching.** Confirmed. Don't retry cleverly;
  the paste/PDF path is the design, not a fallback.
- **This machine's PATH `pdftotext` is xpdf, not Poppler** - xpdf silently
  has no `-tsv` mode, which `server/equibase-otr.js` (D71) requires.
  Poppler is present via `winget install oschwartz10612.Poppler` but not
  linked onto PATH; `resolvePdftotextCommand()` locates it under
  `%LOCALAPPDATA%\Microsoft\WinGet\Packages\` automatically, checks the
  TSV header on every call (a wrong binary throws instead of silently
  mis-parsing), and `BETSHEET_PDFTOTEXT` overrides the path explicitly if
  the winget layout ever changes.
- **Newer models REJECT a non-default `temperature`; the default value is fine**
  (D166). `claude-sonnet-5` answers a 400 `\`temperature\` is deprecated for this
  model.` to `temperature: 0`, while `temperature: 1` - what `complete()` sends
  by default, and what every LLM card generation uses - is accepted normally.
  **So LLM cards are NOT affected and never were**; the failure only appears
  when a new caller pins temperature for determinism, which is exactly what
  D166's vision extraction tried to do and why this was found (that caller was
  removed in D177; the client behaviour and this trap both remain). `complete()` in
  `server/anthropic-client.js` now treats `temperature: null` as OMIT THE FIELD,
  which is the only way to call such a model; every existing caller passes a
  number and is byte-identical to before. The wider lesson: a model can retire a
  request PARAMETER, not just a model id, and the check scripts cannot catch it
  because they all run under a TEST_MODE stub that never reaches the API.
- **ANTHROPIC_API_KEY** (in `.env`, gitignored) is required for "Generate
  Card from LLM" (D63) - without it, preview shows a visible error
  ("ANTHROPIC_API_KEY is not set") rather than calling out; nothing
  crashes and nothing is persisted, verified live. `BETSHEET_LLM_MODEL`
  overrides the default model. `BETSHEET_LLM_TEST_MODE=1` is a
  check-script-only escape hatch (`scripts/check-llm-cards.js`) that lets
  a request body's `__stubResponse` bypass the real API call entirely -
  never set it outside a check script.
- **APIFY_TOKEN** (in `.env`, gitignored) is required for any live
  `server/apifyEquibase.js` call (D197) - without it, `getApifyClient()`
  throws "APIFY_TOKEN is not set" at call time, mirroring
  `ANTHROPIC_API_KEY`'s own fail-fast shape exactly. Get one at
  https://console.apify.com/settings/integrations. Unlike the LLM key,
  there is no check-script-only stub mode: `scripts/
  check-apify-equibase-client.js` verifies `fetchEntries`/`fetchResults`
  by injecting a fake client object through `runActor`'s own `client`
  parameter instead, since a real Apify call costs real money and no
  check script may ever make one - that belongs to a person running a CLI
  script (Phase 4) on purpose.
- **Every PROGRAM_ONLY figure in the corpus is a backfill figure.** No
  consensus source ever ran on an archived day, so that bucket measures Bottom
  Line + morning line and nothing else - never read one of its numbers as the
  live methodology's. Nothing can enter the bucket any more (D111 deleted the
  engine that assigned it, D113 the program ingestion that fed it), so this is
  now a rule for READING the stored corpus rather than for producing it.
- **`race_days.meet` is still derived at save, by `shared/track-codes.js`.**
  Del Mar runs summer (Jul-Sep) and fall (Oct-Dec) meets, so those corpora
  stay separable in P/L and Distributions; a non-Del-Mar day has no meet at
  all (null, never a guessed label). The derivation lived in the dmtc crawler
  until D113 deleted it and relocated this one function.
