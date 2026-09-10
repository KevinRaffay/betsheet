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

**One deliberate exception, user decision 2026-09-07 (D150-D155):** the
at-track MOBILE surface was built ahead of that sequencing. It is a card
CONSTRUCTION surface only - no corpus, no grading, no generation, no database
- so it adds HUMAN cards to the corpus rather than consuming a benchmark that
does not exist yet, and nothing in Phases 1–3 depends on it. The rule stands
for everything else in Phase 4.

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

```bash
npm start              # build + serve on 127.0.0.1:8788
npm run dev            # vite :5175 + api :8788 (api restarts via scripts/dev-watch.js)
npm run dev:clean [-- --yes]  # find (and stop) stale dev stacks holding :8788 / :5175
npm run dev:restart    # D97: dev:clean --yes then dev, in one command - the two-step is why a stale stack stayed in the way
npm run dev:preview    # D97: the AGENT's dev stack, api :8795 / vite :5185, never the human's ports (.claude/launch.json runs this)
npm run gh -- pr 133 | pr list | pr create --title T --body-file f | pr merge N | pr close N | checks [ref] | raw GET <path>  # D101: GitHub API via the git credential; D217 added pr close
npm run check-gh-api   # D217+D218: gh-api.js's ALLOWLIST and how it STOPS - offline and credential-free - what PATCH may reach and (mostly) what it must not, that the only PATCH body in the file is the literal {state:'closed'}, and that DELETE is permitted nowhere
npm run install-hooks  # D101: point core.hooksPath at the tracked hooks (pre-push refuses a direct push to main)
npm run allocate-deliverable -- --title "Short title" [--branch b] [--who name]  # D203: atomically claim the next D number - run this BEFORE naming a branch or writing a ledger row; also --list, --status <n>, --release <n> [--reason "..."]
npm run check-deliverable-numbers  # D203: the allocator's own verification, incl. 25 real concurrent processes claiming 25 distinct numbers
npm run check-logging  # logging: rotation, sweep, retention, torn lines
npm run check-schema   # schema: constraints, cascades, migrations, tamper guard
npm run check-staleness # D117: entries freshness - the exact part (capture age) and the parts it refuses to guess (has a race run, without the track's timezone)
npm run check-track-codes # D123: the track registry's silent-failure properties - no shared codes, no ambiguous spellings, no alias the lookup can never match; every display and alias round-trips; D209: every tz is a real IANA zone, an unrecognized track carries no guessed timezone
npm run check-race-calendar # D209+D210: the race-day calendar's pure timezone math (a known winter/summer offset for two zones, the real 2026 spring-forward boundary not just a two-season pair, the 10am-Pacific hour grid, formatPacific's PST/PDT label, every registered track's zone actually converting) AND the GET /api/calendar endpoint on a seeded temp DB (three tracks/zones on one date, a null post time and an unregistered track both landing in unplaceable, a deleted day and a different date both excluded, the 400 refusals)
npm run check-graded-card-fixtures # D108 + D120 (P-6.1): the 9 fixtures are present and self-consistent, AND the real grader re-run over them reproduces every archived summary to the cent and all 386 per-ticket outcomes - with a negative control proving the check can fail
npm run check-equibase-entries # D104: Equibase entries HTML parser vs. the real Del Mar page (golden + hand counts; the 12-column claiming-race regression)
npm run check-equibase-apify-parseforge # D190: the second registered parser vs. a real two-track Apify dataset (golden + hand counts; the morning-line-decimal recomputation; multi-track refusal; toPayload's deliberate throw)
npm run check-equibase-apify-results # D193/D196: the second RESULTS source vs. a real 11-race single-track Apify dataset (golden + hand counts; the two finalTime-less races; exotics-on-winner's-row-only; scratch derivation from a supplied entries context; output already matches saveResults's shape)
npm run check-apify-equibase-ingest # D196: the real entries -> results flow end to end over HTTP, using the two real fixtures that happen to be the same real day (Del Mar 2026-09-07) - entries save with equibase_apify provenance, results preview derives the 4 genuine race-11 scratches, both bogus-provenance refusals hold for real
npm run check-apify-equibase-client # D197: the live Apify client's input shaping, includeWagers default, run-status handling and raw-item round trip through the real parsers - all against a FAKE client, never a real billed call
npm run check-equibase-apify-entries-preview # D202/D204: the UI-triggered live entries pull's previewApifyEntries() against a fake client (never a real billed call), plus the real Express route's request validation and its no-APIFY_TOKEN refusal path over a real temp server; the returned apifyRunId
npm run check-equibase-apify-results-pull # D206: the /day UI's live results pull, pullApifyResults() against a fake client (never a real billed call) - the day's own track/date feeding the call, scratch derivation against a seeded entriesByRace - plus the real route over a real temp server seeded with the real D192/D193 Del Mar fixture: 404 on an unknown day, the no-APIFY_TOKEN refusal before any network call, 410 on a soft-deleted day
npm run check-zip-read # D127: the zip reader's refusals - bombs stopped during inflation, encrypted/zip64/truncated/bad-CRC named, and no filesystem access at all
npm run check-entries-zip # D127: the bulk path end to end on a temp DB - preview writes nothing, policy A skips a bad file without losing the good ones, replace only when asked
npm run batch-equibase -- <dir> [--write-report f.json] [--parser id]  # D121: every saved Equibase page in a folder through the real parser AND the real writer, into a throwaway DB that is deleted on exit. D188: --parser selects a registered parser (shared/parsers/registry.js), default equibase-html; an unknown id is a hard error
npm run pull-race-day -- <date> --dir <dir> [--tracks C1,C2] [--parser id] [--per-track-parser C=id,...] [--write-report f.json]  # D189: a full day's slate from a directory of already-saved pages, no live fetch; appends one row per track to data/ingest_runs.jsonl
npm run pull-apify-entries -- <date> [--tracks C1,C2] [--yes] [--replace] [--bankroll-cents N] [--per-race-min-cents N] [--write-report f.json] [--fixture f.json]  # D198: live, on-demand entries pull through the real running server - COSTS REAL MONEY without --fixture, even without --yes; --yes governs the save only
npm run pull-apify-results -- <date> [--tracks C1,C2] [--yes] [--write-report f.json] [--fixture f.json]  # D198: the results sibling - requires entries already saved for the day, day looked up by track+date, never assumed
npm run check-pull-apify-cli  # D198: both CLI scripts run as real child processes against a real temp server, using --fixture on the same real Del Mar 2026-09-07 pair D196 verified - never a real billed call
npm run compare-parsers -- <date> <TRACK_CODE> --dir <dir> [--parsers id1,id2,...] [--write-report f.json]  # D191: diffs a challenger parser against the registry default for one real track/date, from files only; appends one row per comparison to data/parser_comparisons.jsonl
npm run check-compare-parsers  # D191: the diff logic (shared/parsers/compare.js) vs. hand-built synthetic parses - field-coverage classification, type-tolerant value comparison, the generalised data-quality checks
npm run check-ingest   # boots the real server on a temp DB; full API flow (~30s)
npm run check-charts    # results-chart parser vs. the real Equibase chart
npm run check-grading   # ticket grading vs. hand-computed + real-day payoffs
npm run check-human-picks # D103: delete a locked ticket (allocation recomputed, last ticket retires the race, revealed 409, graded 409, 404s); D98: the LIVE race-day path - lock with no results on file, estimates still filled from the M/L, replayed_at stamped, blindness undetermined until a reveal, and the results save grading the already-locked card (plus the D99 bug pinned); D91: payout estimator pure (incl. identity for unsupported types), preview==saved estimate (invariant 9); D54: human ticket parser, lock/save/grade, D28 refusal, bucket isolation; D84: teller grammar (pure), the inverse proof, structural + wps_split rules
npm run check-replay    # D55: blindness/close pure units, blind-view key-set discipline, standing; D62: day landing per-race PL
npm run check-llm-cards # D92: notes-free prompt byte-identical, sanitizer, trailingText, notes report, draft/snapshot immutability, prompt-injection containment, batch 409; D63: prompt builder + ticket-block extraction, stubbed preview/save round trip, per-race bankroll math, bucket isolation; D64: box-bet prompt fix; D67: "If it hits" estimate math; D68: consensus picks reach the prompt; D75: GET /api/llm-models shape, an unknown model refused 400, a requested model recorded on the request row without a real API key; D76: llm_model recorded at card creation, a mismatched-model save refused 409, the LLM_GENERATED P/L bucket's byModel breakdown
npm run check-llm-input-capture # D149: correlation id / prompt hashes / template id-version / request params / notes snapshot all independently recomputable; llm_request_sent/llm_response_received bracket a call; export at schemaVersion 3 with a populated llmInputs entry; --omit-llm-inputs redaction; a non-LLM card and a simulated pre-migration row both export llmInputs: null; a regeneration writes a new request row (original untouched) plus a race_regenerated event naming both correlation ids
npm run check-equibase-otr # D71+D72+D74: OTR PDF parser vs. all 16 real archived files, synthetic wrap/mismatch/trailing-token edge cases, upload/confirm round trip, per-ticket blocking, D07 mismatch refusal, bucket isolation, archive re-parse, batch CLI (ingest + idempotent re-run + --consensus-only); D74: exact consensus mapping, re-upload replaces not duplicates, the real favorite/box4 fade rule, the LLM prompt's OTR block present/absent
npm run ingest-otr -- [dir]  # D72: batch-ingest every Equibase OTR PDF in a folder (default data/archive/equibase-otr/DMR), policy A, idempotent by sha256
npm run check-pl        # P/L views: bucket isolation, per-race sums, delete/restore
npm run check-export    # trace export: rotation/gzip read-through, loss flagging
npm run check-routing   # browser routes, SPA deep links, and API JSON boundary
npm run check-dmtc-results # dmtc results page vs. Equibase chart: identical cents per ticket on 08-28/29/30
npm run check-distribution  # distributions: losing days, drawdown, single-ticket dependence gross vs net, bucket isolation
npm run reformat-teller-calls [-- --yes]  # D85: re-derive every stored tickets.teller_call into the D84 grammar (dry run by default)
npm run backfill-payout-estimates [-- --yes]  # D96: fill tickets.est_payout_* on human/llm/equibase-otr cards saved before D67/D73/D91 (dry run by default; never touches an engine card, never overwrites)
npm run archive-corpus [-- --force]  # D107: freeze the pre-pivot corpus to archive/ (snapshot + one export per card); refuses to clobber
npm run fix-grade-set-versions [-- --yes]  # D99: re-stamp grade sets written under the wrong engine version (regrade then drop the stale set; dry run by default)
npm run export-trace -- --card N [--out f]  # the LLM feed for one card
npm run reset -- --yes  # FACTORY RESET: wipe every record AND every log file

# The static Pages target (D150-D155) - the at-the-track card builder
npm run build-static-payload -- <raceDayId> [--out f] [--reference-cards]  # D150: one race day -> static/public/payload.json (read-only; --reference-cards embeds the day's LLM/OTR cards, which the deploy then publishes PUBLICLY)
npm run dev:static      # D151: the static app on vite :5186 (needs a payload built first)
npm run preview:static  # D155: serves the BUILT dist-static on :5187 - the only way to exercise the service worker (it registers in production builds only)
npm run build:static    # D151: build dist-static (BETSHEET_STATIC_BASE sets the deploy sub-path)
npm run check-static-payload  # D150: canonicalization, the 13 validation refusals, a real day, hash stability incl. a negative control
npm run check-static-app      # NOT RUNNABLE IN A WORKTREE - out of scope there by house rule (D168, see Gotchas); run it from the primary checkout. D151+D154+D155: payload rows and DB rows parse IDENTICALLY, the built bundle ships no LLM/OTR/grading/API code (with a positive control), the Pages base, the service-worker strategies
npm run import-static-cards -- <path> [--yes]  # D153: import phone-built cards (dry run by default; a directory of rolling backups is one safe import)
npm run check-static-import   # D153: migration 027, the same file imported three times producing ONE card, all four refusals, invariant 15's lock times
npm run check-module-bindings # D172: no module uses a name it only re-exports - the blank-page class that build and every server-side check structurally miss
npm run dedupe-tip-cards [-- --yes]  # D174: fold D171 duplicate TIPSHEET card sets to one per (day, source, variant); keeps the NEWEST (the one a later stake reuses) and REFUSES to delete a graded card. Dry run by default
npm run check-tip-staking     # D171 + D174 (re-staking reuses the same three cards; a third race re-prices the whole card; a second SOURCE gets its own three; migration 031 backfill; a graded card warned then regraded cleanly): the three variants, the 8/1 place-money threshold (and that 7/1 does not fire), refusals instead of unpayable stakes, migration 030's cards REBUILD keeping every child row and both indexes, preview writing nothing, three cards appended not edited, and a TIPSHEET card grading through the ORDINARY grader into its own P/L bucket
npm run check-entry-flags   # D216: the two entries-table highlights (shared/entry-flags.js) - all three real Baffert spellings, the LIVE-runner field count in both directions, a scratched horse keeping BAFFERT but never taking FAV, co-favorites, and the no-stored-decimal input shape; two negative controls
npm run check-tip-scoring     # D170: a scratched top pick promotes the next live one, an unplaced also-ran is a loss but an unknown program number is surfaced, NULL not zero when unscorable, rates NULL at n=0, sources never pooled, a soft-deleted day leaving every figure and coming back on restore
npm run check-tip-picks       # D166 shape + D176 manual entry (D177 removed the vision phases): migration 028, the hyphen->slash odds conversion re-checked through morningLineToDecimal, absent odds omitted not fabricated, a broken ranking blocking, the reset naming tip_picks, and the manual round trip - the same horse ranked differently in two sheets, names from the day, an empty sheet clearing a source
```

Further verification commands (simulator runs, distribution reports) are
added by their PRs and listed here as they land.

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
  evidence), and any deviations from plan.
- Too big to review = split it and add rows to DELIVERABLES.md.
- **QA branch deliverables carry a `-QA` suffix on their ID** (`D44-QA`): a PR
  merged from `qa` gets the suffix in DELIVERABLES.md, in the feature-status
  table below and wherever the ID is cited, so the plain D-sequence stays
  reserved for the planned deliverables (user rule, 2026-09-02).

## Definition of done

Before a branch is reported ready, verify — out loud, in the final message:
1. `DELIVERABLES.md` row updated (status, PR#/branch, notes).
2. `CLAUDE.md` reflects any changed invariant, command or feature status;
   `docs/architecture-map.md` reflects any changed architecture entry (D208
   relocated the table there, out of CLAUDE.md itself).
3. Verification scaled to what changed: presentation-only diffs need
   `npm run build` to exit 0; anything touching `shared/`, `server/`,
   parsers, the schema or an API contract needs the relevant check scripts
   to exit 0. State which category applied.

---

## Feature status

Orientation only: what exists, its state, its PR, and a sentence or two of
why. **`DELIVERABLES.md` is the ledger of record** - the rationale, the
alternatives rejected and the verification evidence live in its row for the
same ID, and every row here ends with a pointer to it.

Keep a row to roughly a paragraph. This file is loaded in full every session
and has a hard size limit. It has been trimmed four times, each time because
cells had grown into second copies of their ledger entries: on 2026-09-04 at
165k (feature rows), on 2026-09-06 at 168k (architecture cells, plus collapsing
the feature rows for what the pivot deleted), on 2026-09-07 at 193k
(both sections again, after six weeks of D136-D149 work regrew them), and on
2026-09-08 at 178k (the 71 settled pre-D130 feature rows collapsed into seven
ERA rows, the way the pivot row already was, plus the fattest architecture
cells stripped of deliverable history - 178k to 148k). Detail belongs in
DELIVERABLES.md, which has no such limit. **D208 moved the architecture map
out of this file entirely** (to `docs/architecture-map.md`), rather than
trimming it a fifth time - four trims of that table were still not enough to
stop it regrowing this file past its limit, and a reference table read
file-by-file has no reason to be loaded into every session the way the
feature-status ledger below does. The same rule still governs it wherever it
lives: a cell says what a file OWNS and the invariants a reader must not
break, not the history of how it got that way.

**All four trims are reversible.** The rows as they read before each are
preserved verbatim in `docs/feature-notes.md` (2026-09-04),
`docs/claude-md-pre-trim-2026-09-06.md` (2026-09-06),
`docs/claude-md-pre-trim-2026-09-07.md` (2026-09-07) and
`docs/claude-md-pre-trim-2026-09-08.md` (2026-09-08) - frozen snapshots, never
updated, for the rare case where a compressed cell dropped a detail its ledger
row words differently.

| feature | state | notes |
| --- | --- | --- |
| Fix: `npm run gh` aborted with a libuv assertion instead of exiting (D218) | merged | PR [#286](https://github.com/KevinRaffay/betsheet/pull/286), branch `gh-api-die-exit` - **user request**, and more than the cosmetic noise it looked like: `die()` called `process.exit()`, and on this machine `process.exit()` after a fetch to api.github.com ABORTS - `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\winsync.c` - so **the shell saw 127, not the code the script asked for**. Every carefully-worded refusal came back looking like "command not found", and a caller branching on the exit status could not tell a refusal from a broken command. Reproduced deterministically (5 of 5, node 24 / Windows) and narrowed by experiment: it does NOT happen without a fetch, NOT after a localhost fetch (so the check scripts that boot a temp server were never affected), and NOT after https to example.com or registry.npmjs.org - whose responses carry `connection: keep-alive` where GitHub's carries no `connection` header at all. **The diagnosis stops at that correlation, deliberately**, because it is also the argument for the fix: stop calling `process.exit()` rather than predict when it is safe. `die()` now sets `process.exitCode` and throws a sentinel, with `uncaughtException`/`unhandledRejection` handlers that ignore the sentinel and report anything else WITH ITS STACK, through `redact()`. The one remaining `process.exit(2)` went too - it was safe, but leaving one behind is how the next network-touching branch inherits the bug. **VERIFIED**: all six exit paths exercised live against GitHub - the merged-PR refusal that used to abort now exits 1, usage 1, bare usage 2, an allowlist refusal 1, an HTTP 404 after a real fetch 1, a successful read 0. `check-gh-api` gained a D218 section (zero `process.exit(` calls in the file, the handler shape, and the fatal path run for real on a temp copy with a throw injected before the dispatch). Two negative controls - restoring `process.exit(code)` fails 2, and swallowing non-sentinel errors fails 3, one proving the script would have exited **0** on a real bug. `build` green. Full record: DELIVERABLES.md D218. |
| `npm run gh -- pr close <n>` (D217) | merged | PR [#284](https://github.com/KevinRaffay/betsheet/pull/284), branch `gh-api-pr-close` - **user request** ("close #281"), which `npm run gh` could not do: its allowlist permitted reads, opening, commenting and merging, and nothing else. The script's own header says to edit `ALLOW` if that is genuinely wrong, so the capability was added rather than reached around - the two alternatives were worse, being a raw `curl` past the guard, or deleting the head branch to close the PR as a SIDE EFFECT, which is exactly how #142 was lost in D104/D105. **The new entry is narrower than the endpoint**: `PATCH /repos/o/r/pulls/<n>` can also retarget a PR's base and rewrite its title and body, and an allowlist cannot say "this verb but only this field" - so the guard is that the file contains exactly ONE PATCH call and its body is the literal `{ state: 'closed' }`, both asserted. Anchored with `$`, so PATCH still cannot reach `/merge`, a review, an issue, the repo itself or a branch-protection rule; DELETE remains permitted nowhere, which is why closing a PR here never touches its branch. `raw PATCH` became reachable and is a guaranteed no-op, since `raw` has no body flag. An already-merged PR is REFUSED rather than PATCHed (GitHub answers 200 and leaves it merged, so a blind PATCH would print a reassuring "closed" for a no-op). **VERIFIED**: new `npm run check-gh-api` - offline and credential-free by construction, since the allowlist is checked before any request is built; it re-derives the regexes by PARSING `gh-api.js` (the `check-track-codes.js` technique) so a hand-copied second rule cannot drift, and spawns the real CLI for the usage-refusal paths. Two negative controls: dropping the `$` fails the two "cannot reach" assertions, and making the PATCH body a variable fails the literal assertion. Then exercised for real against GitHub - #280 (merged) refused, #281 closed, a second close reporting "already closed". `check-module-bindings` and `build` green. Full record: DELIVERABLES.md D217. |
| Entries tables highlight Baffert runners and the five-horse-field favorite (D216) | merged | PR [#280](https://github.com/KevinRaffay/betsheet/pull/280), branch `entry-flags-baffert-favorite` - **user request**, after asking whether the LLM Generator could run "in a 5-horse race bet the favorite; if the trainer is B Baffert bet to win". **It could not, mechanically**: `server/llm-prompt.js`'s ENTRIES line is `#<pgm> <name> - ML <odds>` and carries no trainer (D178 trimmed it there on purpose). The user chose to have both conditions SURFACED and to build the HUMAN tickets by hand, so this **produces no card, no ticket, no bucket and no migration** - a reading aid over stored entries needs none of invariants 13/14. New pure, browser-safe `shared/entry-flags.js` + shared `EntryFlagTags.jsx`, rendered in all four entries tables (ingest preview, `/day`, the shared `EntriesTable` the static builder also uses, and the card sheet). **The trainer test is a case-insensitive SUBSTRING, measured not assumed**: the corpus holds `Bob Baffert(J. Barnes)` (160), `B Baffert` (9) and `B. Baffert` (8), so the literal equality the thesis words would have reached 4% of the runners and still looked like it worked. **Field size counts LIVE runners** (a six that scratches to five qualifies), and co-favorites are all flagged rather than none. **A real CSS collision found only in the browser**: `row--flagged` was already `DistributionView`'s red outlier highlight and won the cascade - renamed `row--entry-flag`. **VERIFIED**: new `check-entry-flags` (44 assertions, two negative controls failing 6 and 14); browser-verified on all four surfaces in the agent's preview stack against a throwaway DB, the ingest preview driven with the real 4.2MB Del Mar fixture (11 races, 5 real Baffert runners, an independent DOM count confirming the one five-live-runner race is the only one with a FAV tag). `check-module-bindings`, `check-routing`, `check-equibase-entries`, `check-ingest`, `check-schema`, `build` green. `check-static-app` NOT run (D168 + the static scope note) - a GENUINE skip: `EntriesTable.jsx` is in its import surface and gains two imports here. Full record: DELIVERABLES.md D216. |
| LLM cards: a refused ticket LINE drops, the rest of the race is kept (D215) | merged | PR [#279](https://github.com/KevinRaffay/betsheet/pull/279), branch `llm-partial-save` - **user decision**, taken from D214's own offer. D214 measured the old cost: across five reported Horseshoe races, 4-5 tickets parsed perfectly in each and ONE line blocked each race, so five paid generations produced nothing. **The change is small on purpose**: a blocking warning never meant "drop a parsed ticket" - the parser already returns without pushing one, so the blanket 422 only ever discarded the tickets that HAD parsed. No legality rule changed. **Invariant 9 holds**: the preview renders the same `parsed.tickets` the save writes, so the confirmed table IS what is stored; the per-warning label moved `BLOCKING:` -> `REFUSED, not saved:` and Save is gated on there being zero tickets rather than on a refusal existing. **One case still 422s deliberately**: every line refused - an empty save is indistinguishable from the model declining to bet, which invariant 13's bucket exists to tell apart. **Invariant 7**: one `ticket_refused` trace event per refusal, so a card holding 2 of 3 written lines is explained rather than a gap. **LLM path ONLY - `server/human-cards.js` still refuses, deliberately**: a human can fix the source and re-parse, which is the correction route invariant 9 mandates; a paid model response cannot be edited. "Regenerate all" now saves and reports `N saved, M refused` instead of skipping. **VERIFIED**: new `check-llm-cards` section on the real reported shape - preview shows 2 tickets + 1 refusal, save 201 storing exactly those 2, `refused` returned, cost counts only saved tickets, trace log carries 1 `ticket_refused` + 2 `ticket_added`, all-refused still 422s and changes nothing; negative control fails exactly 4 on revert; both pre-existing all-refused 422 tests still pass unmodified. `check-llm-cards`, `check-human-picks`, `check-export`, `check-grading`, `check-replay`, `check-ingest`, `check-schema`, `check-module-bindings`, `check-routing`, `build` green. **`check-pl` fails 4 and they are NOT this branch's** - reverting `server/llm-cards.js` alone reproduces the identical 4 on the untouched baseline; the same pre-existing failures D195 isolated, still unfixed, and in this same LLM save path. Worth its own deliverable. `check-static-app` not run (D168 + the static scope note) - provably irrelevant here, unlike D213/D214: neither changed file is in its import surface. Full record: DELIVERABLES.md D215. |
| Trailing-parenthetical menus, a bet type carrying its base unit, and the routing trap between them (D214) | merged | PR [#278](https://github.com/KevinRaffay/betsheet/pull/278), branch `menu-trailing-parenthetical` - **user request** (finish the form D213 left) **plus a bug report** on Horseshoe Indianapolis 2026-09-10 races 1/5/6/8/9, which split cleanly into 'the parser was wrong' and 'the model was wrong'. **(1)** Saratoga names the bet first (`Trifecta (.50)`, `Super (.10)`, `Pick 3 ($1)`); a new `MENU_TRAILING` + `menuParenCents` reads it, applied last so the parenthetical wins - generalising the `Superfecta (10c min)` rule it replaces. A bare integer in a parenthetical is refused for D213's reason: nearly every one is a race list. **This found a real unreported bug** - the replaced regex demanded the exact spelling `(10c min)`, so **Del Mar's own `(10c min.)` and `(10-cent min)` read as $1 for the whole corpus**, refusing legal dime supers on 12 races. **(2)** The reported race 9 wrote the menu's base unit into the type column (`50 cent trifecta | ... | $0.50`). `TELLER_LINE_RE`'s 'provably disjoint' claim holds for the BET_TYPES TABLE, not for what a writer can type, so the line took the teller path and was SHREDDED on its own `/` into three failing fragments. `isColumnRow` now routes any 3+-column pipe row to the column grammar, and `stripBaseUnitPrefix` reads the type with a non-blocking warning; the stake column still governs and is still menu-validated. **(3)** Races 1/5/6/8 are the model's error, not the parser's - a $12 box written as `$6` to fit leftover bankroll, twice with the model's own `invalid`/`dropped` annotation on a line it emitted anyway. One new prompt bullet (a line you decided against must not be written; shrinking `<stake>` cannot make a ticket affordable). Fifth prompt patch in the D145-D163 series - a mitigation, not a guarantee. **Measured and offered, not taken**: in all five races 4-5 tickets parsed fine and one line blocked the race (`persistLlmRace` refuses the whole race), so ~22 good paid-for tickets were discarded; letting a preview-confirmed save keep them would end this class regardless of the model, but it changes what money lands on a card, so it is the user's call. **VERIFIED corpus-wide, D213's method**: both parsers over all 488 stored menus - 18 change a minimum (34 races), every one correct (12 Del Mar superfecta, 22 Saratoga quinella/double/pick3); no other track moves, no race list ever read as money; all 1,946 stored tickets re-checked, no new sub-minimum. Replaying the 5 reported races: **race 9 goes 3 blocking -> 0**; races 1/5/6/8 stay blocked, correctly. 12 new assertions in `check-human-picks` with a negative control (7 fail on revert); one stale D213 assertion updated, not left passing. All checks + `build` green; `docs/prompts/llm-card-v1.md` kept byte-identical. `check-static-app` NOT run (D168 + the standing static scope note) - a real skip, both changed shared files are in its import surface. **Also confirms the earlier Woodbine report is fixed by D213** - all 8 menus now parse at 20c; it was reported against a pre-D213 server. Full record: DELIVERABLES.md D214. |
| Fix: a legal 20-cent trifecta box was refused - the printed wager menu's minimum was unreadable (D213) | merged | PR [#277](https://github.com/KevinRaffay/betsheet/pull/277), branch `claude/trifecta-box-minimum-price-66ba76` - **user-reported** as an LLM failure (`BLOCKED Race 1: $0.20 per combo is below the $0.50 minimum for trifecta box`), and **the model was right and the parser wrong** - the first fix in the D160-D163 box-arithmetic series that changes no prompt text. The stored request (`llm_card_requests` 438, Woodbine) priced a 4-horse trifecta box at `$0.20 x 24 combos = $4.80`, honouring every earlier fix, against a menu that literally reads `0.20 Trifecta`; `shared/betmath.js` matched a menu amount as `$N` or `Nc` only, so a bare decimal matched nothing and `parseWagerMenu` fell back to `BET.minimums`' 50c. One shared `MENU_AMOUNT` now covers every form this corpus prints - and deliberately NOT a bare integer, since a real menu's `9 & 10 Pick 3` would become a $10 Pick 3. See Gotchas for the forms still unread. **VERIFIED against the corpus, not a fixture**: old and new parsers run side by side over all 488 distinct stored menus - 34 change a minimum, all 20c at the three Canadian tracks that really sell it, zero false positives; all 1,690 stored tickets re-checked for a new sub-minimum, none. New pure section in `check-human-picks` with a negative control (reverting `betmath.js` fails 6 assertions, one reproducing the reported message verbatim). `check-human-picks`, `check-equibase-entries`, `check-tip-staking`, `check-llm-cards`, `check-grading`, `check-equibase-otr`, `check-ingest`, `check-schema`, `check-module-bindings`, `build` green. `check-static-app` NOT run - out of scope in a worktree (D168), and the static app is out of scope entirely by the 2026-09-08 scope note above. `shared/betmath.js` IS in its import surface, so this is a genuine skip rather than a provably-irrelevant one - recorded, not treated as a blocker, per that decision. Full record: DELIVERABLES.md D213. |
| Fix: Del Mar's own track code carried no timezone (D212) | in review | branch `dmr-code-alias` - **user-reported**: `shared/track-codes.js`'s Del Mar entry was the ONE of 39 that omitted its own code from `aliases`, and `canonicalizeTrack` compares against `display` and `aliases` only - it never consults `code` - so the bare string `'DMR'` fell through to the derived-code path as `{ display: 'DMR', recognized: false, timezone: null }` while `'SAR'`/`'KD'` resolved with their zones. Fix is one word; no other entry had the gap (checked by running the real function over all 39). **Latent, but one step less so than it looked**: both entries parsers emit the display name, so no stored row is wrong - but `shared/parsers/equibase-apify-parseforge.js:158` (`trackName \|\| trackCode`) is LIVE code that hands the save layer a bare code when a capture prints no name, correct for 38 tracks precisely because they list their own code; for Del Mar it would have saved display `"DMR"` and `server/race-calendar.js` would route every race into `unplaceable`. **VERIFIED**: `check-track-codes` gained the general assertion (every entry's own code round-trips to that entry's code/display/`recognized`/`tz`) plus a named one for the specific case, with a negative control - reverting the alias fails exactly those 2 and exits non-zero. `check-track-codes`, `check-race-calendar`, `check-ingest`, `check-schema`, `check-equibase-entries`, `check-equibase-apify-parseforge`, `check-module-bindings`, `build` all green. `check-static-app` not run - out of scope in a worktree (D168), and its import surface provably does not reach this module. Full record: DELIVERABLES.md D212. |
| Race day calendar, phase C-3: the client matrix view (D211) | merged | PR [#263](https://github.com/KevinRaffay/betsheet/pull/263), branch `claude/race-day-calendar-matrix-s3br3o` - the third and final phase of `docs/requirements/race-day-calendar.md`, picked up on user confirmation right after D210 shipped. New `client/src/components/RaceDayCalendar.jsx`: tracks x 24 hourly Pacific columns, reading D210's `GET /api/calendar` via a new `getCalendar(date)` in `client/src/api.js`. Date input defaults to TODAY'S PACIFIC DATE (`Intl.DateTimeFormat` against `America/Los_Angeles`, not a bare `new Date()`), reusing `shared/race-calendar.js`'s `CALENDAR_START_HOUR`/`CALENDAR_COLUMNS` for the column headers rather than hardcoding them. Every populated cell reads `Race N - <postTimePacific>` straight off the response and is a clickable `.linkish` span into that track's `/day/:id` (multiple races in one track's hour stack in the same cell); the track name is clickable too, for the same day. A footer line reports the total `unplaceable` count across every track when non-zero. New route `calendar` (`routes.js`), a `calendar` view block (`App.jsx`), and a "Race calendar" button on `RaceDayList.jsx`. **New CSS**: `.grid--wide-scroll` (`overflow-x: auto` + `white-space: nowrap`) - the 25-column table is wider than the shell at any realistic column width, the first table in the main client to need its own scroll container rather than stretching the page. **VERIFIED**: `npm run build` and `check-module-bindings` both green (presentation-only diff otherwise). **Browser-verified for real** in the agent's own `dev:preview` stack (api 8795/vite 5185) against a throwaway seeded database (never the human's) - Del Mar/Kentucky Downs/Saratoga/an unregistered track seeded for the actual Pacific "today," driven with a temporary Playwright script (this sandbox has no `chromium-cli`; `playwright` installed with `--no-save` and pointed at the pre-installed `/opt/pw-browsers/chromium` binary, then removed afterward - `package.json`/`package-lock.json` untouched, confirmed via `git status`). Screenshot confirmed the matrix rendering correctly (Del Mar's two 10am races stacked in one cell, tracks sorted by earliest post, the unregistered track last with its race in `unplaceable`, the footer line reading "2 races could not be placed"), clicking a populated cell navigated to the real `/day/1` Del Mar page, and the one console error present (`favicon.ico` 404) was confirmed pre-existing and unrelated by isolating it with a response/console listener. Preview server and seeded throwaway DB torn down afterward. No schema or server-route change - this phase is client-only. Full record: DELIVERABLES.md D211. |
| Race day calendar, phase C-2: read-only `GET /api/calendar` endpoint (D210) | merged | PR [#263](https://github.com/KevinRaffay/betsheet/pull/263), branch `claude/race-day-calendar-matrix-s3br3o` - the second phase of `docs/requirements/race-day-calendar.md`, picked up on user confirmation right after D209 shipped. New `server/race-calendar.js`, modeled on `server/distribution.js`'s shape (a small standalone read-only reporting router, no writes): `GET /api/calendar?date=YYYY-MM-DD` - every non-deleted `race_days` row for the date, joined to its `races`, each race placed via D209's `placeRacePacific` and returned per track as `{raceDayId, track, trackCode, timezone, races: [{number, postTimePacific, hourBucket}], unplaceable: [race numbers]}`. Tracks come back sorted by earliest post so a caller rendering rows in order already reads top-to-bottom as "who's up soonest." A race with no parseable post time, or a track with `timezone: null` (unregistered/derived code), lands in `unplaceable` rather than being silently dropped - invariant 11's standing preference for a visible gap. `400` on a missing or malformed `date`. **D number again determined by eyeballing the ledger, same mechanism as D209's row**: this session's local allocator counter has no memory of the real ledger between calls in a fresh environment, so a second `allocate-deliverable` call also collided (this time with the real D204) and was released the same way; used D210 (one past D209). **VERIFIED**: `scripts/check-race-calendar.js` extended with a second section booting the real server on a seeded temp DB - three real tracks in three real zones (Del Mar/Pacific, Kentucky Downs/Central, Saratoga/Eastern) on one date, hand-computed to land in ascending Pacific columns 0/1/2; a null post time and an unregistered track (`Some Brand New Fairgrounds`) both landing in `unplaceable` rather than vanishing; a soft-deleted day and a different date both excluded; the two 400 refusals; an empty date returning an empty list rather than an error - 12 new assertions, all passing alongside the 30 pure ones from D209. Full regression sweep green: `npm run build`, `check-module-bindings`, `check-schema`, `check-ingest` (the real server round-trip, unaffected by the new mounted router). No schema change - the endpoint reads existing tables only. Phase C-3 (the client matrix view) remains not scheduled. Full record: DELIVERABLES.md D210. |
| Race day calendar, phase C-1: per-track timezone data + pure hour-bucketing helper (D209) | merged | PR [#263](https://github.com/KevinRaffay/betsheet/pull/263), branch `claude/race-day-calendar-matrix-s3br3o` - the first phase of `docs/requirements/race-day-calendar.md`, a user-requested plan (2026-09-10) for a tracks-x-hourly-blocks matrix. **User decision, mid-plan**: the viewer is always Pacific, so every displayed time - both the column a race lands in and the time printed in its cell - is Pacific, never a track-local mix; this phase builds the timezone conversion that decision depends on. `shared/track-codes.js`'s 39-entry registry gained a `tz` field (each individually checked against the track's real city/county, not assumed from its state - two real corrections found this way: Kentucky Downs and Atokad Downs are both Central despite sitting in nominally-Eastern-leaning states, Sandy Ridge Racing is Eastern despite being in Kentucky since Boyd County sits on the state's eastern side) and `canonicalizeTrack` now returns it as `timezone` (`null` for an unrecognized/derived-code track - never guessed). New pure `shared/race-calendar.js`: `localWallClockToUtc` (the standard DST-safe two-pass `Intl` conversion, no dependency), `hourBucket` (the 10:00 AM Pacific-anchored grid), `formatPacific` (the one time string a viewer ever sees), and `placeRacePacific` (the combined call C-2's future endpoint needs). **D number determined by eyeballing the ledger, not the allocator**: this session's `.git` common directory is fresh (an ephemeral cloud environment with no prior counter history), so `npm run allocate-deliverable` claimed D203 locally - which collides with the real D203 already in this ledger. Released that claim (`--release 203`) and used D209 (one past the real highest, D207) instead, exactly the documented cross-machine fallback in Gotchas ("a cloud session has its own `.git` and cannot see this counter"). **VERIFIED**: new `scripts/check-race-calendar.js` (30 assertions - known winter/summer offsets, the REAL 2026-03-08 US spring-forward boundary two weeks either side rather than a same-track two-season pair which correctly lands on the identical Pacific column either way, the hour-grid's boundary columns, `formatPacific`'s seasonal PST/PDT label, `placeRacePacific`'s refusal on an unparseable time or an unknown zone, and every one of the registry's 9 distinct zones actually converting); `scripts/check-track-codes.js` gained a regex-shape update (the new `tz` field widened the object-literal pattern it parses the registry from) plus new assertions (every entry's `tz` is non-empty and a real zone `Intl` accepts, the round-trip check now includes `timezone`, an unrecognized/empty track carries `timezone: null`) - all pass. Full regression sweep green: `check-schema`, `check-module-bindings`, `check-ingest` (canonicalization end-to-end, unaffected by the additive field), `build`. No schema or server change - phases C-2 (a read-only `/api/calendar` endpoint) and C-3 (the client matrix view) remain not scheduled. Full record: DELIVERABLES.md D209. |
| Architecture map relocated out of CLAUDE.md (D208) | merged | PR [#261](https://github.com/KevinRaffay/betsheet/pull/261), branch `claude/architecture-map-relocation-bfas9t` - **user request**: CLAUDE.md is loaded in full every session and had been trimmed four times (see the paragraph above) because the architecture-map table kept regrowing it past its size limit. Moved the whole table verbatim to `docs/architecture-map.md`, with a one-paragraph pointer left in its place; the "Definition of done" rule and the trim-history paragraph were both updated to name the new file rather than silently going stale. Content is unchanged byte-for-byte apart from the new file's own header and the pointer replacing it in CLAUDE.md - no invariant, command, or feature-status text moved or changed. **VERIFIED**: presentation/docs-only change (no `shared/`, `server/`, parser, schema or API-contract file touched), so `npm run build` is the applicable check; ran green. Full record: DELIVERABLES.md D208. |
| Fix: live Apify entries/results parse warnings rendered as blank bullets in the preview (D207) | in review | branch `empty-parse-warnings-api-3f0fdf` - **user-reported**: a live Apify entries pull's preview showed "N parse warnings" followed by N empty bullets. Root cause: `ParsePreview.jsx` renders `warnings.map((w) => <li>{w.message}</li>)`, a convention every other parser (`equibase-entries.js`, `equibase-otr.js`, `human-picks.js`, `dmtc-results-parser.js`, `chart-parser.js`) follows but `equibase-apify-parseforge.js` (D190/D192) and `equibase-apify-results.js` (D193) never did - every one of their warning sites pushed `{type, blocking, ...fields}` with no `message`. Not a data bug; the structured fields were always correct. Fixed: all 13 + 14 warning sites in both files now carry a `message:` string worded like the HTML parser's own; both goldens regenerated (diff confirms only `message` fields were added). **Both check scripts gained a `checkMessages()` assertion** - every warning set they already produce now asserts a non-empty `message` on every warning, closing the exact blind spot that let this ship (the checks asserted `type`/structured fields via hand counts, never `.message`, and never rendered through `ParsePreview`). Full record: DELIVERABLES.md D207. |
| Load results by calling the Apify API from the `/day` UI (D206) | in review | branch `apify-api-day-ui-e6492c` - **user request**, the results-side sibling of D202's live entries pull. Simpler than the entries side: the day (and its own track/date) already exists by the time results are pulled, so `ResultsPanel.jsx` gained one button, "Pull results from Apify," with no form - `server/equibase-apify-results.js`'s new `POST /race-days/:id/results-apify/pull` route (and its exported `pullApifyResults(db, day, client)`) calls `fetchResults` live using the day's own `track`/`date`, reuses this file's existing `entriesByRaceFor` helper for scratch derivation, and returns the identical preview shape the manual `.../preview` route already returns - so the existing preview/save flow (`applyParse`/`handleSave`, posting to the unmodified `POST /race-days/:id/results`) needed no changes beyond the new handler and button. `apifyRunId` is logged then stripped before the response, matching D204's precedent on the entries side. **VERIFIED**: new `scripts/check-equibase-apify-results-pull.js` - `pullApifyResults()` against a fake client (real actor id, single-track `tracks`, `resultType: 'results'`, `includeWagers` defaulting true, a real parse with scratch derivation against a seeded `entriesByRace`), plus the real route over a real temp server seeded with the real D192/D193 Del Mar 2026-09-07 entries fixture (404 on an unknown day, the no-`APIFY_TOKEN` refusal before any network call with the real named error, 410 on a soft-deleted day) - never a real, billed call. Full regression sweep green: `check-apify-equibase-ingest`, `check-apify-equibase-client`, `check-equibase-apify-entries-preview`, `check-equibase-apify-results`, `check-ingest`, `check-schema`, `check-module-bindings`, `build`. Browser-verified in the agent's own preview stack (ports 8795/5185): the button renders with the cost-warning notice, and clicking it (no `.env`/`APIFY_TOKEN` in this worktree) surfaces the real "APIFY_TOKEN is not set" error with no console exception and no call reaching Apify. `check-static-app` not run - out of scope in a worktree by house rule (D168); none of the changed files are in the static app's import surface. Full record: DELIVERABLES.md D206. |
| Default `maxItems=10000` on every live Apify call (D205) | in review | branch `apify-max-items-default` - **the confirmed root cause of D204's own undercount**: the user ran the identical Kentucky Downs input directly in the Apify portal and only got the correct 14 races/168 rows once `maxItems: 10000` was set explicitly - this codebase's calls had never set it, silently truncating on the actor's own too-low default with no error. `fetchEntries`/`fetchResults` now default it to 10000 (the user's own confirmed value, well above the largest fixture on file), overridable, and free for a normal card since the actor bills per item/page produced, not per `maxItems` requested. **VERIFIED**: `check-apify-equibase-client.js` gained 3 assertions (both functions default to 10000; still overridable). Full regression sweep green: `check-equibase-apify-entries-preview`, `check-pull-apify-cli`, `check-module-bindings`, `build`. `check-static-app` not run - out of scope in a worktree by house rule (D168). Full record: DELIVERABLES.md D205. |
| Log the Apify run id on every live pull (D204) | merged | branch `log-apify-run-id` - **found investigating a user-reported live discrepancy, 2026-09-09**: a Kentucky Downs pull via D202's UI showed only 9 of a real 14-race card. Traced through the app log and database: a manually-saved HTML page had correctly captured all 14 races hours earlier, but two later live Apify pulls each returned a different, smaller count (2, then 9) and each used `--replace`, which HARD-DELETES the day it replaces (see the new Gotchas entry) - the correct data and 3 cards/98 tickets built on it are now permanently gone. **This PR's own "root cause could not be confirmed" is now stale - D205 confirmed it** (the actor's own `maxItems` default) shortly after this merged; the diagnosability this PR shipped (`runId` logging) remains valuable independently for any future undercount from a different cause. `runActor()` returns `{items, runId}` instead of bare `items`; the UI route logs `apifyRunId` (stripped before the HTTP response) and both CLI scripts print a direct console.apify.com link and write it into `--write-report`. **VERIFIED**: `check-apify-equibase-client.js`/`check-equibase-apify-entries-preview.js` gained assertions that `runId` comes back correctly; `check-pull-apify-cli.js` re-run green, confirming `--fixture` mode's `runId: null` path is harmless. Full regression sweep green. `check-static-app` not run - out of scope in a worktree by house rule (D168). Full record: DELIVERABLES.md D204. |
| Data-driven deliverable-number allocation (D203) | in review | branch `deliverable-number-allocation-6c23dd` - **user request**: "Multiple agents repeatedly claim the same D number and are causing merge conflicts." Confirmed real, twice over, before writing any code: D200 was independently claimed by two concurrent sessions (renumbered to D201 on rebase - see that row), and `git log --oneline --all` across every worktree on this machine turned up a THIRD, still-unmerged branch that had already minted `D202` locally. New `scripts/lib/deliverable-numbers.js` + `scripts/allocate-deliverable.js` (`npm run allocate-deliverable -- --title "..."`): an atomic SQLite counter, in the shared `.git` COMMON directory (`git rev-parse --git-common-dir`, confirmed by `git worktree list` to be the one thing every worktree of this checkout shares) so every concurrent worktree agent on this machine claims from the same source without a path ever needing to be agreed on ahead of time, and the file is never git-tracked - it cannot itself cause the merge conflict it exists to prevent. Numbers are never recycled, even on `--release` (an annotation only) - the same reasoning as invariant 12. **The tool's own first seed reflects the D202 collision it was built to prevent**: seeded to 203, not 202, so it never reissues the number the still-unmerged branch already claimed by hand. **Dogfooded**: this deliverable's own D203 was claimed by running the finished tool against the real shared database, not assigned by eye. **VERIFIED**: new `scripts/check-deliverable-numbers.js` - path resolution with/without the `BETSHEET_DELIVERABLE_DB` override, seed-once idempotence, release-never-recycles, the `setNextNumber` force-guard, and the load-bearing case: 25 REAL concurrent child processes (not an in-process loop) claiming against one throwaway database at once, asserted to return 25 distinct, contiguous numbers with the persisted counter advancing by exactly 25. `npm run build` and `npm run check-module-bindings` both green. `check-static-app` not run - out of scope in a worktree by house rule (D168); no changed file is in the static app's import surface. Full record: DELIVERABLES.md D203. |
| Create a race day from the UI via a live Apify pull (D202) | in review | branch `apify-entries-live-pull-ui` - **user request 2026-09-09**: "Add a feature to create race day from the UI with apify data," out of the original four-phase CLI-only scope. Asked before writing code whether track/date needed selecting up front and whether a master track list existed; user chose **one track, one date, committed before the paid call is possible** - the UI equivalent of the CLI's `--tracks` filter, matching how a race day is already created one track at a time. `shared/track-codes.js` gained `listTracks()` (39 tracks, suggestions only) feeding a `<datalist>` on the Track input. New `server/equibase-apify-entries.js` (`previewApifyEntries`, client-injectable) and `POST /api/parse/equibase-apify-entries` - MAKES THE LIVE CALL itself, unlike the results-side preview route, since the browser holds no `APIFY_TOKEN`; returns the same shape `/api/parse/equibase-entries` does so the existing preview/save UI needed no new handling beyond a label case. `NewRaceDay.jsx` gained a third mode with a cost-warning notice and a pull button gated on both fields being filled. **Found and fixed a real, live safety gap while verifying this, unrelated to the feature itself** - see D201, shipped separately first. **VERIFIED**: new `scripts/check-equibase-apify-entries-preview.js` (fake-client unit tests plus the real route's validation/no-token paths, never a real billed call); full regression sweep (`check-schema`, `check-ingest`, `check-equibase-apify-parseforge`, `check-track-codes`, `check-module-bindings`, `build`) green; browser-verified in the agent's own preview stack - mode switching, datalist, button gating, warning text, no console errors, never triggering a real Apify call. `check-static-app` not run - out of scope in a worktree by house rule (D168). Full record: DELIVERABLES.md D202. |
| Fix: `check-pull-apify-cli.js`'s "no token" test was unsafe since D199 (D201) | merged | branch `fix-apify-cli-check-dotenv-leak` - **found during routine verification of an unrelated UI feature, not user-reported**. D199 restored `import 'dotenv/config'` in `pull-apify-entries.js`/`pull-apify-results.js`, but this check's own "no token, no `--fixture`" case only did `delete env.APIFY_TOKEN` on the spawned child - dotenv fills any key still missing from `process.env` by reading `.env` straight off disk regardless, so as merged this check would load the REAL token on any machine with one set (this one included) into the exact test case meant to prove no token means no call. Fixed identically to how `check-pull-apify-cli.js` already solved this same class of bug for its own pre-D199 case: `DOTENV_CONFIG_PATH` pointed at a path that cannot exist in the `clearToken` branch. **VERIFIED**: ran the full check with this fix and a real, populated `.env` present - the no-token case now genuinely refuses before any network call. Full record: DELIVERABLES.md D201. |
| Live entries/results CLI scripts - Phase 4, the final phase (D198) | in review | branch `apify-ingest-phase4-cli` - **user request 2026-09-09**, completing `docs/requirements/apify-equibase-ingest.md` (now marked COMPLETE): `npm run pull-apify-entries -- <date> [--yes] [--replace]` and `npm run pull-apify-results -- <date> [--yes]`. **One design point the plan got wrong, caught before writing any code**: the plan assumed direct DB writes, the way `pull-race-day.js`/`batch-import-equibase-entries.js` do - checked directly, and both of THOSE write to a throwaway temp database, structurally never the real corpus, because they're validation harnesses, not real ingestion paths. Since Phase 4's whole point IS a real ingestion path, both new scripts instead talk to the ACTUAL running server over HTTP like a browser client, reusing its conflict/409/`--replace` handling, D195's `entriesSource` validation and the superseded-day trace unchanged rather than reimplementing or bypassing them. Requires the server already running (checked via `/api/health` first). The results script looks up the day genuinely saved for a track/date rather than assuming one exists. **A genuinely useful addition beyond the plan**: both scripts accept `--fixture path.json`, replaying an already-downloaded dataset export with no live call and no token needed - real functionality (the same "someone already has a file" posture every ingest path here takes), and how both are verified without spending money. **A real bug this verification caught before a live, billed call ever could**: `pull-apify-results.js`'s first draft read the save response as `saveBody.counts.results`; `saveResults`'s actual shape spreads counts at the TOP level - this would have crashed on every real save. **VERIFIED, never with a real billed call**: new `scripts/check-pull-apify-cli.js` boots a real temp server and runs both scripts as actual child processes against it, using `--fixture` on the same real, same-day (Del Mar 2026-09-07) fixture pair D196 verified server-side - preview-only saves nothing, `--yes` saves with the real provenance value and hand-counted totals, a re-run without `--replace` conflicts rather than duplicating, `--replace` overwrites onto a NEW id (invariant 12 - also caught and fixed a stale-id bug in the CHECK script itself), the day-dependency guard fires with the real reason for a missing day, and no-server/no-token-no-fixture both refuse before any network activity. Full regression sweep green. `check-static-app` not run - out of scope in a worktree by house rule (D168). **Phase 5 needed no separate deliverable** - its planned coverage was already satisfied by D196/D197's own check scripts. Full record: DELIVERABLES.md D198. |
| Live Apify client, on-demand only (D197, Phase 3) | in review | branch `apify-ingest-phase3-client` - **user request 2026-09-09**, Phase 3 of `docs/requirements/apify-equibase-ingest.md`, resolved by a direct question earlier the same day: BetSheet calls Apify's API itself, on demand, never scheduled - a deliberate second exception to invariant 6 (the mobile surface is the first; see invariant 6's own text). `npm install apify-client --ignore-scripts` (a plain install tried to rebuild `better-sqlite3` from source and failed for lack of a native toolchain in this sandbox; skipping lifecycle scripts avoided touching it, `check-schema` confirmed it still worked). **Two corrections found once actually building this, not assumed from the plan**: (1) file location - the plan (inherited from a repo-blind external scope doc) put the client under `shared/`; a file holding an API token belongs under `server/`, exactly where `anthropic-client.js` already lives for the identical reason. (2) the real input schema - read from `parseforge/equibase-scraper`'s own live Store page rather than assumed: the plan's `dataMode`/`trackCodes` names belong to a DIFFERENT actor in the comparison table, mis-attributed to parseforge by the repo-blind doc; the real schema is `resultType`/`tracks`/`date`. **A load-bearing finding the plan never anticipated**: exotic payoffs are an opt-in, separately-billed field on this actor (`includeWagers`, OFF by default) - every real results sample this codebase verified against necessarily had it on, so `fetchResults` now defaults `includeWagers: true`, overriding the actor's own default; left alone, a live pull would have silently come back with every race missing exotic payoffs, which this codebase's grading depends on. New `server/apifyClient.js` (`hasToken()`/`getApifyClient()`, mirroring `anthropic-client.js`'s fail-fast pattern exactly) and `server/apifyEquibase.js` (`fetchEntries`/`fetchResults`, a thin actor-calling layer returning raw dataset items with no reshaping - a caller `JSON.stringify`s them back into the exact string `parseApifyParseforgeDataset`/`parseApifyResultsDataset` already take, so neither golden-verified parser changes). A non-`SUCCEEDED` run throws, naming the run id/status. **A related, previously-flagged gap corrected with newly-verified evidence in the same pass**: `shared/parsers/registry.js`'s `equibase-apify-parseforge` entry carried an empty placeholder `costModel` (the "prior evaluation" figures were never verifiable in this repo, finding 5); the actor's own live page supplied real, sourced pricing instead, and happens to independently confirm the one figure that overlapped ($0.675/full card) - a coincidence, not retroactive vindication of the uncitable source, and recorded as an amendment to finding 5. **VERIFIED, never with a real billed call** (that belongs to a person running a CLI script, Phase 4, not a check script): new `scripts/check-apify-equibase-client.js` confirms `hasToken()`/`getApifyClient()`'s fail-fast behavior and injects a fake client through the one seam `runActor()` exists to provide - the real actor id is called, `raceDate`/`tracks` map to `date`/`tracks`, an omitted `tracks` defaults to `[]` not `undefined`, `includeWagers` defaults true but is overridable, arbitrary filters pass through via `...rest`, a non-`SUCCEEDED` run throws naming the run id/status, and a fake live-fetched item round-trips through the real parsers correctly via `JSON.stringify`. Full regression sweep green: `check-apify-equibase-ingest`, `check-equibase-apify-parseforge`, `check-equibase-apify-results`, `check-compare-parsers`, `check-equibase-entries`, `check-schema`, `check-ingest`, `check-module-bindings`, `build`. `check-static-app` not run - out of scope in a worktree by house rule (D168); neither new file is among the static app's 7 documented reachable files. Full record: DELIVERABLES.md D197. |
| Wire both Apify parsers to real saves (D196, Phase 2) | in review | branch `apify-ingest-phase2-wiring` - **user request 2026-09-09**, Phase 2 of `docs/requirements/apify-equibase-ingest.md`, picked up the moment D195 unblocked it. `apifyParseforgeToPayload` stops throwing - `parse()`'s output already matched `insertRaceDay`'s shape field-for-field, so the real implementation is a two-line wrapper adding only `entriesSource`/`oddsCapturedAt`, not a reshaping adapter. **A planned piece was cut once building it proved it unnecessary**: the plan called for `apifyResultsToPayload` to stop throwing and return `saveResults`'s shape - built for real, that function had nothing left to do (`parse()`'s output already IS that shape), so it was deleted rather than kept as dead pass-through code, matching how `chart-parser.js` has never needed a `toPayload` either. New `server/equibase-apify-results.js`: a day-scoped preview route building `context.entriesByRace` from the day's saved entries in one query. **No new save route** - the plan called for a preview/confirm PAIR, but the existing `POST /race-days/:id/results` route already accepts the preview's exact shape, so a second endpoint would have duplicated it for nothing. **Found and fixed the identical finding-8-class bug on the results side**: `server/results.js`'s `SOURCE_KINDS` silently coerced an unrecognized `sourceKind` to `equibase_paste` - fixed the same way D195 fixed `ENTRIES_SOURCES` (a `resolveSourceKind` helper, refuse rather than coerce, 400 from the route) in the same pass rather than shipping a new value beside a live copy of the bug. Neither parser's `parse()` changed. **VERIFIED**: new `scripts/check-apify-equibase-ingest.js` boots the real server and runs the FULL entries -> results flow over HTTP using the two real fixtures, which happen to be the SAME real day (Del Mar, 2026-09-07) - the first genuinely matched real entries+results pair this codebase has had to wire end to end. Confirms: the day saves with `entries_source = equibase_apify` and all 123 entries/11 races survive; a bogus `entriesSource` is refused 400 for real; the results preview derives exactly the 4 real scratches in race 11 (a genuine program number in the saved entries absent from that race's real finishers) and zero for race 1; the confirmed preview saves through the existing `/results` route unmodified with all 106 finishers surviving and `source_kind = equibase_apify`; a bogus `sourceKind` is refused 400; day-lifecycle guards hold. `check-equibase-apify-parseforge`/`check-equibase-apify-results` updated (dead throw-tests replaced with real-wiring assertions) and green; full regression sweep (`check-schema`, `check-ingest`, `check-grading`, `check-dmtc-results`, `check-charts`, `check-equibase-entries`, `check-compare-parsers`, `check-module-bindings`, `build`) green. `check-static-app` not run - out of scope in a worktree by house rule (D168). Full record: DELIVERABLES.md D196. |
| Apify provenance schema + the entries_source silent-coercion fix (D195, Phase 1) | in review | branch `apify-ingest-phase1-schema` - **user request 2026-09-09**, Phase 1 of `docs/requirements/apify-equibase-ingest.md`. New migration 033 rebuilds `race_days` and `result_charts` in ONE file, adding `'equibase_apify'` to both CHECK constraints - the value D190/D192's `equibase-apify-parseforge.js` and D193's `equibase-apify-results.js` have both been refusing to save without since the day each was built. **Fixed a real bug in the same pass rather than leaving it beside a hardened one**: `server/ingest.js`'s `ENTRIES_SOURCES` allowlist used to silently coerce an unlisted `entriesSource` to `'program'` (D190's own "finding 8," never fixed until now); it's now module-scoped and exported so `insertRaceDay` and the `/race-days` route's validation share one list, an omitted value still defaults to `'program'`, and a present-but-unrecognized one is REFUSED - `insertRaceDay` throws (matching `getParser`'s own idiom), the route additionally 400s it through its existing `problems`-array pattern. **The disposable-corpus framing changed what "verified" means, not the migration's care**: no live corpus file exists in this environment, so verification runs against a freshly-migrated temp database rather than a `VACUUM INTO` copy of "the real corpus" - the rebuild still preserves data via INSERT...SELECT and the live index list was confirmed against a fresh migration (migration 030's lesson), just without the extra caution a disposable corpus doesn't need. **VERIFIED**: `npm run check-schema` gained 4 new assertions (both CHECK values accept `equibase_apify`, both still refuse an unrecognized one) - all pass, alongside every pre-existing `race_days`-rebuild assertion. `npm run check-ingest`, `check-equibase-entries`, `check-equibase-apify-parseforge`, `check-equibase-apify-results`, `check-entries-zip`, `check-grading`, `check-module-bindings`, `build` all green. **Found and isolated, not fixed**: `check-pl` has 4 pre-existing failures in its own LLM-card scenario, confirmed via a stashed before/after run to reproduce identically on the pre-Phase-1 baseline - unrelated to this migration, flagged separately. `check-static-app` not run - out of scope in a worktree by house rule (D168). Full record: DELIVERABLES.md D195. |
| The first real cross-parser comparison, and the fixture gap it closed (D194) | in review | branch `real-parser-comparison-dmr-0907` - **user request 2026-09-09**: supplied a real Equibase HTML entries page for Del Mar, 2026-09-07, asking to run the M-3 comparison against it - and this time it matched the track/date of D192's already-committed leaner Apify fixture exactly, the first genuinely matched pair either registered parser has ever had. **The comparison ran for real for the first time.** Result: race count matched (11/11), every horse matched by name in both directions (0 missing either way) - the strongest possible confirmation both parsers read the same real card correctly - and every one of 82 real field mismatches resolved to one of four explained causes, none a parser defect: **(1) weight (3)** - the real page itself prints a footnoted horse's weight as TWO tokens with no separator ("117 5"), which is exactly what the Apify actor's own "1175"-style data-quality glitch (flagged since D190) turns out to be - not a scraper typo, a genuine two-part printed field neither parser currently splits back out; **(2) medication (73)** - this Apify capture has none at all (D192's leaner variant), so the per-run gap `fieldsNotProvided` correctly does NOT mask as structural (finding 16) shows up as real value-mismatch noise, exactly as predicted and now measured; **(3) morningLine/morningLineDecimal (8 each)** - every one a SCRATCHED horse: the HTML parser nulls a scratch's odds, this Apify capture keeps whatever it last read - a real, open question about which convention is more useful, surfaced rather than resolved; **(4) claimPrice (20)** - an optional-claiming horse not entered to claim: the page prints `"$0"`, the Apify capture (correctly, by its own field semantics) gives `null` - both encode "not entered," as two different literal values. Both parsers' post-position-gap findings agreed EXACTLY (races 3, 5, 10, each a real scratch) and neither found a double-space name artifact on this real day. New fixture `tests/fixtures/equibase-entries/DMR090726USA-EQB.view-source.html` + its golden, with a new `check-equibase-entries.js` section (11 races, hand-counted entry/scratch pairs per race, the "117 5" weight-token assertion against the real page directly) and a new permanent section in `check-compare-parsers.js` asserting the real comparison's exact numbers - independently re-derived from the real CLI run's own output before being hardcoded, not copied from a first passing run. **VERIFIED**: `npm run check-equibase-entries` green (both goldens, old and new); `npm run check-compare-parsers` green (20 synthetic + 9 new real-fixture assertions); `npm run check-equibase-apify-parseforge` green (untouched); `npm run check-module-bindings` green; `npm run build` green. No schema or server change. `check-static-app` not run - out of scope in a worktree by house rule (D168). Full record: DELIVERABLES.md D194. |
| Second results source: `equibase-apify-results` (D193) | in review | branch `equibase-apify-results-parser` - **user request 2026-09-09**, scoped in `docs/requirements/equibase-apify-results-ingest.md` from a real Apify results export the user supplied directly, distinguished from the entries side purely by field shape (`rowType: "result"`, `finishPosition`, payoff fields) since an earlier file sharing the identical export naming convention, from the same session, carried no results at all. New `shared/parsers/equibase-apify-results.js`: pure, never throws, produces `{track, date, races}` DIRECTLY in `server/results.js`'s `saveResults` shape - no `toPayload` reshaping needed here, unlike the entries side, since this source's fields already line up one-to-one with what `race_results`/`exotic_payoffs` persist. Payout figures (`winPayoff`/`placePayoff`/`showPayoff`/exotic `payoff`) are plain per-$2 dollars, the same convention `shared/chart-parser.js`'s own `money()` already assumes - checked against that function, not assumed, and no unit-mismatch trap like D190 found. **Scratch derivation resolved by explicit user decision, not left open**: this source names no scratches at all (only finishers appear as rows), and `shared/grading.js`'s refund policy runs entirely off a `scratchedPgms` set per race - fed this source as-is, a ticket on a scratched horse would grade as a plain loss instead of the refund invariant 1 requires. Resolved: assume scratched - a program number present in the day's entries but absent from this race's finishers is scratched, no other state exists, safe because entries are always ingested before results for every race day this codebase handles. Implemented as a `context.entriesByRace` input (`{[raceNumber]: [{programNumber, horseName}]}`) the parser diffs against its own finisher list - kept OUT of the database, the same way `context.trackCode` already lets a caller supply what a source itself can't, so the parser stays pure with no DB access, matching every file under `shared/parsers/`. Reused `shared/chart-parser.js`'s own `BET_TYPES` map and "(N correct)" annotation-stripping convention for exotic combinations; this source's already-separated `wagerType`/`winningNumbers`/`payoff` fields make the parse strictly easier than the chart's single-line positional split, and a compound type name absent from the map (`Place Pick All`, `Consolation Pick 3`, `Consolation Double` - all real values in the fixture) falls back to a generic slug, the same fallback the chart parser already uses for its own unmapped types, never a guess. **`apifyResultsToPayload` throws unconditionally, matching D190's `toPayload` precedent**: `result_charts.source_kind`'s CHECK constraint (migration 010) admits only `equibase_paste`/`equibase_pdf`/`dmtc_html`, no value for an Apify-sourced results day, and this parser's shape needs no other adapter step - so the throw is the one deliberate place left to make "not wired to a save path yet" loud and intentional rather than an accident of nothing having called it. **VERIFIED**: `scripts/check-equibase-apify-results.js` (golden-diff plus independent hand-counted assertions against the raw JSON, mirroring `check-equibase-apify-parseforge.js`'s own established shape) - exact per-race finisher counts (106 total across 11 races), the two races (3 and 7) confirmed missing `finalTime` entirely with a non-blocking warning for each, `exoticWagers` confirmed to ride exactly one row per race (the winner's, hand-counted on the raw file), payout-cent conversion spot-checked at both small and large scale (a Pick 5 payoff of $205,306.75 -> 20530675 cents, its "(5 correct)" annotation stripped, multi-winner "/" legs preserved), the compound-wagertype fallback, a named-pool combo (`TURFPICK3(7-7-10)`) and an "N OF M" combo (`9 OF 10`) both preserved as printed, scratch derivation exercised against a synthetic entries context (an entry absent from the finisher list is reported scratched; no context supplied derives none, which is a correct empty result, not an error), `apifyResultsToPayload` throwing, and malformed input (non-JSON, a JSON object instead of an array, an empty array, a file carrying only entry-mode rows with no `rowType: "result"`) each returning a distinct warning rather than an exception - the "never throws" contract every parser here holds. `npm run check-equibase-apify-parseforge` and `npm run check-equibase-entries` both green (neither touched - only the shared fixtures directory gained a new file). `npm run check-module-bindings` green, `npm run build` green. No schema or server change - `check-ingest`/`check-schema` not applicable, and deliberately so (this deliverable is parser-only, per finding E). `check-static-app` not run - out of scope in a worktree by house rule (D168); the new file is not in the static app's import surface. Wiring a save path (a new preview route, a `SOURCE_KINDS` entry) and the `result_charts.source_kind` migration remain not scheduled, as does verifying this design against a second real sample. Distinct from D192 (a different concurrent deliverable, same day - IDs collided in flight and this one was renumbered on rebase). Full record: DELIVERABLES.md D193. |
| Parser comparison: `compare-parsers.js` + `shared/parsers/compare.js` (D191, M-3) | merged | PR [#239](https://github.com/KevinRaffay/betsheet/pull/239), branch `multi-parser-entries-m3` - **user request**, M-3 of `docs/requirements/multi-parser-entries-ingest.md`, picked up the same day D190 unblocked it. **No live fetching** (inherits M-2's decision): `scripts/compare-parsers.js <date> <TRACK_CODE> --dir <dir> [--parsers id1,id2,...]` locates one file per requested parser under `--dir` via `shared/parsers/registry.js`'s new `EXTENSIONS_BY_SOURCE_KIND` map, and reports a parser UNAVAILABLE (never fatal) when no file under it produces the requested track/date. The pure diff, `shared/parsers/compare.js`'s `compareParsedDays`, always baseline-vs-challenger (never symmetric), matches horses by `nameKey` rather than `programNumber` (the field itself can be the bug under test), and classifies every field by each side's `fieldsNotProvided`: skipped (neither provides it) / baseline-only (the challenger's gap) / challenger-only (the scope's own "additive value," reported separately from mismatches) / compared. Generalises the scope's two getascraper-specific data-quality examples (a post-position sequence gap, a double/triple-space name artifact) into checks any registered parser can trip, not one vendor's alone. Appends one row per comparison performed to `data/parser_comparisons.jsonl` (gitignored) - the decision rule for ever proposing a new default reads a SAMPLE from this ledger; nothing here applies that rule automatically. **No real matched track/date pair exists between the two registered parsers' fixtures** (the HTML set covers Sept 6/7/10, the Apify set covers Sept 9, zero overlap) - `shared/parsers/compare.js` is therefore unit-tested against hand-built synthetic parses engineered to hit every code path at once (`scripts/check-compare-parsers.js`), while the CLI's file-discovery and honest-unavailability reporting is exercised against the real fixture directories. **Two real bugs found and fixed DURING verification, not shipped and found later**: (1) the CLI's first draft passed the requested track/date as `context` to every parser during file discovery, but `equibase-html`'s `context` shape is a FALLBACK used only when a page's own markup can't be read, not a filter - passing the request there made the parser falsely "match" a real Del Mar page to a request for Indianapolis; fixed by passing only `context.trackCode` (harmless to `equibase-html`, which destructures a differently-named key; the Apify parser is the only one that reads it, and only to SELECT among rows already present, never to invent one). (2) Running the fixed CLI against a real HTML fixture and a small hand-built Apify-shaped file (constructed only to exercise the "compared" code path end to end - no real matched pair exists to build one from, so nothing here was committed as a fixture) surfaced that `equibase-html` prints `postPosition`/`weight` as STRINGS ("1", "124") while the Apify parser gives numbers - a strict `!==` flagged the identical real value on the identical real horse as two separate mismatches, and the same string/number gap had been silently disabling the post-position-gap check on the HTML side entirely (`Number.isInteger("1")` is `false`). Both fixed by coercing through `Number` when both sides look numeric before comparing (`valuesEqual`), re-verified to confirm the false-positive mismatches disappeared. **VERIFIED**: `scripts/check-compare-parsers.js` (20 hand-built assertions: race-count mismatch, per-race in-baseline/in-challenger flags, field-coverage classification in both directions, a real race-level mismatch vs. a coverage gap correctly NOT flagged as one, name-based matching surviving a scratched-status disagreement, missing-in-either-direction, the type-coercion fix proven on a "1" vs `1` postPosition, both data-quality checks firing on the correct side only, and a baseline/challenger role-swap sanity check) - all pass. The real CLI run against the real DMR fixture plus the synthetic Apify-shaped file: correctly reports `equibase-apify-parseforge` unavailable for `DMR`/2026-09-06 (no matching file) and `equibase-html` unavailable for `IND`/2026-09-09 (same reason, other direction) before the fix, then correctly reports 0 real mismatches for the one genuinely matched horse after it. An unknown `--parsers` id exits 2 naming the valid ones. `npm run check-equibase-entries`/`check-equibase-apify-parseforge` green (both parsers untouched by this PR's fixes - only `compare.js`/`compare-parsers.js` changed), `npm run check-module-bindings` green, `npm run build` green. No schema or server change. `check-static-app` not run - out of scope in a worktree by house rule (D168); none of the changed files are in the static app's import surface. Full record: DELIVERABLES.md D191. |
| `equibase-apify-parseforge` handles a second, leaner real capture from the same source (D192) | merged | PR [#242](https://github.com/KevinRaffay/betsheet/pull/242), branch `apify-parseforge-lean-schema` - **user request**: supplied a second real Apify dataset export (Del Mar, 2026-09-07) and asked to run the M-3 comparison against it. The file has NO `rowType`, `trackCode`, `isScratched` or `medication` anywhere - verified its fields are a strict subset of the first sample's, and it carries the same class of weight glitch (an extra digit: 1175/1165 here vs 1137 in the first sample), which is why this was treated as the SAME source in a leaner capture mode rather than a new registry entry. `parse()` now derives a track code from `trackName` via `canonicalizeTrack` when `trackCode` is absent, and infers scratch status from a missing `programNumber` when `isScratched` is absent (D180's precedent: absence means genuinely scratched, not a placeholder) - every inference named in one non-blocking `scratch_status_inferred` warning, never assumed silently. `medication` stays OUT of `fieldsNotProvided`: it's a gap in this one capture, not something the source structurally lacks, so it comes back `null` per entry like any other missing value rather than being reclassified as permanently absent. **The requested comparison itself could not run**: no Del Mar 2026-09-07 HTML fixture exists, so `compare-parsers.js` correctly reports the baseline `UNAVAILABLE` rather than fake a result - flagged to the user rather than silently producing nothing. **VERIFIED**: the original 100-row IND/KD fixture still parses byte-identically (golden-diffed, zero regression); the new 123-row Del Mar file resolves to 11 races with hand-counted entry/scratch pairs per race (13 inferred scratches total, matching an independent count against the raw file), the 3 real weight glitches flagged, `medication` confirmed `null` throughout rather than misclassified; `npm run check-compare-parsers` and `npm run check-equibase-entries` green (untouched), `npm run check-module-bindings` green, `npm run build` green. `check-static-app` not run - out of scope in a worktree by house rule (D168). Full record: DELIVERABLES.md D192. |
| Second registered parser: `equibase-apify-parseforge`, unblocking M-3's dependency (D190) | merged | PR [#238](https://github.com/KevinRaffay/betsheet/pull/238), branch `register-apify-parseforge-parser` - **user request**: "build a parser for this file," a real Apify dataset export the user supplied directly (never fetched - invariant 6). Identified as `parseforge/equibase-scraper`'s output from Apify's own default export filename convention plus content corroboration (scratches/medication/claiming price present, matching the incoming scope's own claim that only `parseforge` reports all three - finding 5's partial correction). **Registering this is what unblocks M-3** (held pending exactly this), but M-3 itself is not scheduled by this PR - a comparison harness is a separate deliverable from the parser it would compare against. **Found a real, load-bearing bug the scope never anticipated**: the source's own `morningLineDecimal` is European decimal odds (fraction+1 - "7/5" carries `2.4` in the real sample); this codebase's `morningLineToDecimal` returns the ratio alone (`1.4`, confirmed against D171's own stated convention). Trusting the source's field would have silently double-counted the `+1` on every payout estimate built from this source - the parser always discards it and recomputes from `morningLineOdds` instead. **The source spans multiple tracks in one file** (the real sample holds Horseshoe Indianapolis and Kentucky Downs together) - `parse(rawInput, {trackCode})` selects one via the `context` parameter the registry's own architecture decision already reserved for this; given more than one track and no `trackCode`, it refuses naming every track present rather than guessing. **`toPayload` THROWS unconditionally, deliberately** - `insertRaceDay`'s `entries_source` CHECK constraint (migration 024) has no value for an Apify-sourced day, and adding one is a schema-rebuild migration against `race_days` (CLAUDE.md's own "riskiest table to rebuild" caution) that is M-5's scope, not a parser deliverable's; throwing turns what would otherwise be a silent mislabel-to-`'program'` (finding 8) into a certain, loud failure instead. Also caught 3 genuine `weight: 1137` data-quality glitches in the real source data (non-blocking warnings) and confirmed the fixture's claim price/scratch/medication fields are real by hand-counting them independently of the parser. **VERIFIED**: `scripts/check-equibase-apify-parseforge.js` (golden + independent hand counts, mirroring `check-equibase-entries.js`'s own shape) - exact entry/scratch counts per race for both tracks (IND 9 races/81 entries/12 scratches total across its races, KD 2 races/19 entries/2 scratches), the multi-track-no-context refusal naming both tracks, an unknown-track refusal, the morning-line-decimal fix asserted against the shared function (not a literal), horse-name/age-sex composition matching the HTML parser's own conventions, the 3 weight glitches flagged non-blocking, `toPayload`'s throw, and malformed-input handling (non-JSON, non-array, empty array) all returning warnings rather than throwing - the "never throws" contract every parser here holds. `npm run check-equibase-entries` green (untouched), `npm run check-module-bindings` green, `npm run build` green. No schema or server change - `check-ingest`/`check-schema` not applicable. `check-static-app` not run - out of scope in a worktree by house rule (D168); none of the changed files are in the static app's import surface. Full record: DELIVERABLES.md D190. |
| Multi-track/day pull orchestration + `ingest_runs` ledger, no live fetch (D189, M-2) | in review | branch `multi-parser-entries-m2` - **user request**, M-2 of `docs/requirements/multi-parser-entries-ingest.md`. **The incoming scope's M-2, read literally, described exactly what invariant 6 forbids** - resolving "which tracks are racing" from Equibase's own index page and then fetching each track automatically. Asked before writing any code (`AskUserQuestion`, not decided unilaterally); the user chose "no live fetching, files only." New `scripts/pull-race-day.js <date> --dir <dir> [--tracks C1,C2] [--parser id] [--per-track-parser C=id,...] [--write-report f.json]` - `--dir` doesn't exist in the incoming scope at all; it exists only because a live fetch does not. Every file under `--dir` is parsed to learn its own track/date; a file whose date doesn't match `<date>` is out of scope for that run, not an error. Omitting `--tracks` pulls every track the directory holds for the date - the closest this codebase can honestly get to "every track racing that day" without an index-page fetch. A requested-but-absent track gets a `failed` row rather than being silently dropped (invariant 11). `--per-track-parser` resolves per track, falling back to `--parser`/the registry default; a resolved parser whose `sourceKind` isn't `html` fails that one track only, since file discovery here only scans HTML pages (the sole sourceKind any registered parser has - M-1 registered exactly one). One track's failure never aborts the run. Writes to a brand-new throwaway temp-directory SQLite DB, same SAFE-BY-CONSTRUCTION posture as `batch-import-equibase-entries.js`; a lightweight read-back check (day found, race count matches) catches a broken run. **`ingest_runs` is `data/ingest_runs.jsonl` (JSON-lines, gitignored), not a table** - the incoming scope offered either; a table would live inside the per-run throwaway DB and be deleted with it, which would defeat "the substrate M-3 and M-4 both read from" (that needs to persist ACROSS runs, which the temp DB structurally cannot). **Verified against the real 5-file fixture directory**: no `--tracks` on 2026-09-06 pulled exactly DMR (11 races/113 entries) and LBG (6 races/34 entries), correctly skipping the index page (no track/date) and the two other dates present in the same directory, named in the report; `--tracks DMR,BTP` pulled DMR and reported BTP `failed` ("no file found"), correctly excluding LBG since it wasn't requested; an unknown `--parser`/`--per-track-parser` id exits 2 naming the valid ones; a bad date and a missing `--dir` both refuse with a clear message; `data/ingest_runs.jsonl` accumulated the expected rows across repeated runs (append, never truncate). `npm run check-module-bindings` green, `npm run build` green (neither `shared/parsers/registry.js` nor `server/ingest.js` changed, so `check-equibase-entries`/`check-ingest`/`check-schema` are unaffected and weren't re-run). `check-static-app` not run - out of scope in a worktree by house rule (D168); this file is not in the static app's import surface. Full record: DELIVERABLES.md D189. |
| Entries parser registry + `--parser` flag on the batch harness (D188, M-1) | merged | PR [#235](https://github.com/KevinRaffay/betsheet/pull/235), branch `multi-parser-entries-m1` - **user request**, M-1 of `docs/requirements/multi-parser-entries-ingest.md`. New `shared/parsers/registry.js`: `{ id -> { label, isDefault, sourceKind, costModel, fieldsNotProvided, parse, toPayload } }`, one real entry (`equibase-html`, wrapping today's `equibase-entries.js`), following `shared/track-codes.js`'s own "registry entry, never a call-site special case" shape. `getParser(id)` throws naming every valid id on a typo rather than silently falling back to default - the exact rule M-1's doc states. `scripts/batch-import-equibase-entries.js` gained `--parser <id>` (default the registry's `isDefault`), and the per-run `toPayload`/`moneyToCents` adapter that used to live inline in that script MOVED into the registry entry unchanged, since a future parser's raw shape may need different (or no) shaping - the `UNMAPPED` list stayed in the script because it names gaps in `insertRaceDay`'s schema, not in any one parser. **No second parser is registered yet** - M-1's own doc (finding 7) flagged that the accessibility-tree adapter's field-anchoring approach was never verified against a real captured sample, so building it now would mean writing a golden for a format nobody has confirmed. Registering only the verified parser and leaving the registry trivially extensible is the scope this PR delivers; a11y-tree and the three Apify adapters are M-1's own "once built" qualifier, not this PR's job. **Verified**: `--parser bogus-id` exits 2 naming `equibase-html` as the only valid id; running the real 4-file Del Mar/Woodbine/Thistledown/hyphenated-track fixture batch through the default and through explicit `--parser equibase-html` produced byte-identical report JSON (diffed); `npm run check-equibase-entries` green (the underlying parser is untouched); `npm run check-module-bindings` green (code moved between modules); `npm run build` green. No schema change, no server change - `check-ingest`/`check-schema` not applicable. `check-static-app` not run - out of scope in a worktree by house rule (D168); this file is not in the static app's import surface. Full record: DELIVERABLES.md D188. |
| Bulk-select and delete betting cards on `/day` (D187) | merged | PR [#232](https://github.com/KevinRaffay/betsheet/pull/232), branch `claude/bulk-betting-card-deletion-9f0b01` - **user request**: a checkbox column on the day's card table plus "Delete selected", mirroring D143's race-day bulk delete. **No grading guard, deliberately** - the user asked for any card, graded or not, to be deletable this way; the single-card `DELETE /api/cards/:id` route (confirm-gated) is untouched. New `POST /api/cards/bulk-delete` hard-deletes each id independently (cascades already existed), reporting `{deleted, skipped}` the same shape `POST /race-days/bulk-delete` uses. Verified in the browser: seeded three HUMAN cards on a fresh day, selected two, confirmed the named warning, deleted them, confirmed the table and notice were correct and checkbox clicks didn't navigate into a card. Full record: DELIVERABLES.md D187. |
| Tip-sheet ranks are three toggle buttons, not a dropdown (D185) | merged | PR [#230](https://github.com/KevinRaffay/betsheet/pull/230), branch `tip-rank-buttons` - **user request**: 1/2/3 buttons that toggle, instead of a per-cell `<select>`. **The exclusion logic is untouched** - the buttons call the existing `setRank`, which already cleared on a falsy value and moved a rank off whoever held it, so there is no second copy of the rule; the server validates independently regardless. Beyond the click count, a dropdown hid the current value behind a control you had to open, so reading a column meant opening nine of them. Lit state is plain `.btn--primary` with `aria-pressed`. Verified: 0 selects, rank 1 moving between rows with the count unchanged, toggle-off clearing, and a horse held at rank 1 in one sheet and 2 in another saving and reopening correctly. Full record: DELIVERABLES.md D185. |
| HOUSE RULE: a race-specific input belongs in the Race UI; analyst notes moved there (D184) | merged | PR [#228](https://github.com/KevinRaffay/betsheet/pull/228), branch `notes-into-race-ui` - **user rule**, generalising D182. A note about ONE race is typed in that race's own panel; "Day Analyst Notes" writes the whole-day note alone. **The rule governs AUTHORING, not reading** - the same note still renders read-only on the card sheet, and the two stayed separate components rather than one with an `editable` flag. No schema, endpoint or server change. Full record: DELIVERABLES.md D184. |
| One "Stake all tip sheets into cards" button (D183) | merged | PR [#226](https://github.com/KevinRaffay/betsheet/pull/226), branch `stake-all-tip-sheets` - **user request**: drop the per-source buttons for a single one. **"All" is a convenience, never a merge** - each source is still previewed and saved through its own call and still gets its own three cards with its own `tip_source_label`, because pooling two sources would break invariant 13 (whether TrackMaster agrees with NumberFire is the thing being measured). The panel states that on screen rather than leaving it inferred. No total across variants or sources, which would have reintroduced the D175 bug in a new place; per-source outcomes reported by name, since a failing source does not stop the others. No server change. Verified with two real sources: 10 → 16 cards (3 × 2), six rows with distinct labels in SQLite, and a re-stake updating to 16 rather than 22. Full record: DELIVERABLES.md D183. |
| Tip sheets moved into the race UI they describe (D182) | merged | PR [#224](https://github.com/KevinRaffay/betsheet/pull/224), branch `tipsheets-into-race-ui` - each race's panel now owns its own tip sheets, beside its analyst notes. **Staking did not move, and could not**: it splits the bankroll across every race with picks, so a per-race stake button would have to invent a denominator. Removed a duplicate `listTipPicks` call on the way - the day loads rows once and passes them down. Full record: DELIVERABLES.md D182. |
| A program-less scratch is stored NULL, not 'SCR' (D180) | merged | PR [#220](https://github.com/KevinRaffay/betsheet/pull/220), branch `fix-scr-program-numbers` - **the investigation corrected the bug report, including my own from D178**. Not a parser defect: the parser returns `programNumber: null` correctly and the number is genuinely absent from the page. And it had corrupted nothing - re-measured against the SELECTIONS column alone, 0 of 3,156 program references were wrong. Migration 032 makes the column nullable; SQLite's UNIQUE permits many NULLs, so D122's suffix hack is dissolved rather than kept. Found a real hole on the way: `resolveToken`'s name-only path could return a NULL number past a scratch guard that keys on the number. Full record: DELIVERABLES.md D180. |
| Tipsheet and OTR picks as a baseline LLM input (D179) | merged | PR [#219](https://github.com/KevinRaffay/betsheet/pull/219), branch `llm-baseline-inputs` - the generator now sees what the day's other sources think, labelled per source. **Archaeology found the work half-done in history**: D112's deleted CONSENSUS block already solved the shape, including why OTR renders as tickets rather than ranks. It also found the heavier half of the scope unnecessary - the whole user prompt is already stored verbatim, so no migration. **Records its own consequence**: LLM cards are now derivative of the EQB_OTR and TIPSHEET buckets, so comparing them no longer measures what it did. Full record: DELIVERABLES.md D179. |
| Three dead inputs removed from the LLM prompt (D178) | merged | PR [#218](https://github.com/KevinRaffay/betsheet/pull/218), branch `llm-prompt-trim-dead-fields` - **arrived as a different proposal** (strip program numbers to stop the model thrashing), and the premise did not hold when measured against the corpus. What WAS dead: the prompt promised program rank, BEST BET and a Bottom Line that D113 deleted, plus consensus picks D112 deleted - **0 of 574 entries and 0 of 49 races on an active day carry any of them**. Removed for correctness first; the token saving was real but small. Full record: DELIVERABLES.md D178. |
| The tip-sheet screenshot path removed (D177) | merged | PR [#217](https://github.com/KevinRaffay/betsheet/pull/217), branch `remove-tipsheet-extraction` - **user decision** once D176's typed entry proved out: extraction cost an API call per race for three horses and three ranks. Deleted the vision call, its routes, the image archive and the test-mode bypass. **The writer and reader survived** - they were never part of the vision half - and the audit columns stay, since rows extracted earlier carry real values. Nothing downstream changed, which is the evidence the layering was right. Full record: DELIVERABLES.md D177. |
| Manual tip-pick entry: type the sheet instead of photographing it (D176) | merged | PR [#216](https://github.com/KevinRaffay/betsheet/pull/216), branch `tipsheet-manual-entry` - a per-race dialog writing the IDENTICAL payload extraction produced. **The grid shape came from the user's own data**: a one-tipsheet-dropdown-per-row design could not record one horse as TrackMaster 1 AND NumberFire 2, which both real screenshots showed. Extraction was left untouched here and removed separately, so the new path proved out before the old one went. Full record: DELIVERABLES.md D176. |
| TIPSHEET P/L counted three mutually-exclusive variants as one spend; plus P/L on the day view (D175) | merged | PR [#215](https://github.com/KevinRaffay/betsheet/pull/215), branch `tip-pl-variant-and-day-view` - found while answering a question about merging the three cards. Summing three ways to bet the SAME picks reported ~$598 wagered on a $200 bankroll. The total now counts one variant per (day, source), FIXED as `win-only` because picking the best performer per day would be cherry-picking. Distributions never had this bug - it takes one card per day per bucket. Same PR added a P/L column to the day's cards table, read from the view `/api/pl` uses. Full record: DELIVERABLES.md D175. |
| One tipsheet card per source, growing as races are added (D174) | merged | PR [#214](https://github.com/KevinRaffay/betsheet/pull/214), branch `tipsheet-one-card-per-source` - a tip sheet arrives race by race, and D171's append-only rule turned that into three MORE cards per stake. Now ONE card per (day, source, variant), reused and **recomputed whole** - required, not convenient, because the per-race budget is the bankroll split across races-with-picks, so a new race re-prices the old ones. Re-staking a graded card discards its grades and regrades: warned, never blocked. Full record: DELIVERABLES.md D174. |
| Fix: staked tipsheet cards needed a page reload to appear (D173) | merged | PR [#213](https://github.com/KevinRaffay/betsheet/pull/213), branch `fix-tip-cards-refresh` - **live bug report**, and the same defect D142 fixed for Equibase OTR: `RaceDayView` remounts `CardsPanel` via a `cardsVersion` key bumped from a sibling's `onSaved`, and D171's `TipPicksPanel` was never given that prop. Reproduced in a browser (server had 13 cards, the table still showed 10), fixed, re-proved (10 -> 13 with no reload). The stale comment claiming the OTR upload was the only such sibling is corrected, since that assumption is exactly what made this easy to miss. Full record: DELIVERABLES.md D173. |
| Fix: "Generate Card from LLM" blanked the whole page (D172) | merged | PR [#211](https://github.com/KevinRaffay/betsheet/pull/211), branch `fix-analyst-notes-blank-page` - **live bug report**. D167's consolidation left `export { NOTE_SOURCE_LABELS as SOURCE_SUGGESTIONS } from '@shared/source-labels.js'` in `AnalystNotesEditor.jsx`, which creates NO local binding, while the file still wrote `SOURCE_SUGGESTIONS.map(...)`. Rendering `NoteSourceDatalist` - which only happens inside the LLM modal - threw a ReferenceError and React unmounted the root. Reproduced in a browser with the exact stack, fixed, and re-proved by reverting the single file. `npm run check-module-bindings` added so the class cannot recur; it flags the real regression and passes on the fix. Full record: DELIVERABLES.md D172. |
| Fix: the /day page grew extra "Betting cards" panels on any re-render (D181) | merged | PR [#222](https://github.com/KevinRaffay/betsheet/pull/222), branch `fix-delete-day-duplicate-cards` - reported as a delete bug ("clicking delete race day results in multiple betting cards being displayed"); **delete was only the most visible state change**. Two sibling panels were both keyed on a remount counter that starts at `0` (`CardsPanel` from D142, `TipPicksPanel` from D176), so they collided on one key and React duplicated them - 2 panels on a hard reload, 4 after Delete, 5 after Cancel. Fixed by namespacing both keys; the D142/D173 remount-to-reload pattern is untouched. The rule is in Gotchas, because neither key was wrong alone and only ADDING the sibling created it. Full record: DELIVERABLES.md D181. |
| TIPSHEET staking: tip picks become graded cards, in three comparable variants (D171) | merged | PR [#209](https://github.com/KevinRaffay/betsheet/pull/209), branch `tip-picks-staking` - **the user supplied a drafted `shared/tipStaking.js`; running it proved it could not work here**: its input is an ML-vs-LIVE-odds gap, and `entries.live_odds` is filled on 0 of 13,710 rows, so it produced ZERO bets silently (every NaN comparison is false). Its one rule that works from the morning line alone was kept **and corrected** - its threshold of 9 assumed European decimal odds, while `morningLineToDecimal` returns the fractional ratio, so it would have skipped 8/1 exactly, the case invariant 1 names. Full record: DELIVERABLES.md D171. |
| TIPSHEET scoring: is a tip source worth reading at all? (D170) | merged | PR [#208](https://github.com/KevinRaffay/betsheet/pull/208), branch `tip-picks-scoring` - closes the loop D166/D169 left open: `tip_picks` had no consumer, so extraction produced data nothing read. Rank-based and **money-free** - nothing staked a tip sheet yet, so a P/L figure would have been invented. Judgement calls in the code: a scratched top pick promotes the next live one, an unknown program number is SURFACED as a likely misread rather than counted a loss, and anything unscorable returns NULL rather than zero. Full record: DELIVERABLES.md D170. |
| **Scope note 2026-09-08**: the static Pages app (D150-D158) is **not a current concern** - user decision. D168's rule already keeps `check-static-app` out of scope in a worktree; this widens it to the app itself. Do not raise static implications or spend effort on that target until the user says otherwise. | active | user decision, recorded during D170. |
| Review and correct extracted tip picks: the TIPSHEET HTTP surface and its edit path (D169) | merged | PR [#207](https://github.com/KevinRaffay/betsheet/pull/207), branch `tip-picks-review-ui` - D166 had left NO routes at all. **The design question was invariant 9**, which forbids hand-editing a parser's output - but a screenshot has no source to fix, and one misread number silently scores a tipsheet on picks it never made. **User decision: keep invariant 9 literally true** - the parse->save path stays read-only and correcting is a separate recorded act on a stored row (migration 029). Full record: DELIVERABLES.md D169. |
| HOUSE RULE: `check-static-app` is out of scope in a git worktree (D168) | merged | PR [#206](https://github.com/KevinRaffay/betsheet/pull/206), branch `static-app-worktree-house-rule` - **user rule 2026-09-08**, prompted by D167 spending effort to make the check run inside a worktree via a `node_modules` junction. It worked, and was still wrong: the failure is structural (a worktree has no local `node_modules`; the script spawns an absolute vite path), it reproduces identically on `main`, and the static app imports only two files from `client/` - so its import list answers "could this have moved?" faster and more reliably than the build does. Rule is recorded in Gotchas and beside the command itself; the stray junction D167 created has been removed. Full record: DELIVERABLES.md D168. |
| One owner for `source_label`: the two vocabularies D166 left behind, consolidated (D167) | merged | PR [#205](https://github.com/KevinRaffay/betsheet/pull/205), branch `source-label-consolidation` - the codebase answered "who said this" TWICE, with two catalogues, two fallbacks and only one of them normalized. `shared/source-labels.js` now owns the single normalizer; both catalogues live there **unmerged, because they answer different questions** (a KIND of commentary vs a named publisher), and both fallbacks stay distinct for a documented reason. Normalizing notes on write is provably inert for every value in the real corpus, asserted with a negative control. Full record: DELIVERABLES.md D167. |
| TIPSHEET: a third-party tip app's picks (D166; **screenshot path removed by D177 - picks are typed now, D176**) | merged | PR [#204](https://github.com/KevinRaffay/betsheet/pull/204), branch `claude/tipsheet-screenshot-extraction-14fc5e` - a NEW `tip_picks` table (migration 028), not a widened `cards`: a tip row is a ranked opinion, so `consensus_completeness` gained no TIPSHEET value. **No completeness column, deliberately** - every tip row has one signal, its ranking. Archaeology found the conversion this turns on: `morningLineToDecimal` cannot read the hyphenated `9-2` tip apps actually print. Full record: DELIVERABLES.md D166. |
| /card page: the same read-only Analyst Notes panel D164 put on /day (D165) | merged | PR [#203](https://github.com/KevinRaffay/betsheet/pull/203), branch `card-view-notes-panel` - user request to carry D164 onto the card sheet too. `CardView.jsx` now fetches the day's notes via `card.race_day_id` (already on the `GET /api/cards/:id` response) and renders one panel per race, right after Entries. D164's inline per-race markup was extracted into a shared `RaceNotes.jsx` (`RaceNotes({ note })`) used by both `RaceDayView.jsx` and `CardView.jsx`, rather than let a second hand-rolled copy exist - the same discipline as `EntriesTable.jsx`/`AnalystNotesEditor.jsx`. No schema/API/write-path change. Verification: presentation-only, `npm run build` green, browser-verified on a real LLM-generated card with a populated race note. Full record: DELIVERABLES.md D165. |
| /day page: read-only Analyst Notes panel on each race card (D164) | merged | PR [#202](https://github.com/KevinRaffay/betsheet/pull/202), branch `race-day-notes-readonly` - user request: the notes entered via D159's "Enter Analyst Notes" (or the LLM generator's own notes fields, same `llm_notes` draft) were writable in two places but not visible anywhere read-only. Each race's `<details>` in `RaceDayView.jsx` gained a nested, collapsed-by-default `Analyst Notes` panel reading the same `GET /api/race-days/:id/llm-notes`; no editing surface, no schema/API change. Closing the notes modal refetches so an edit is reflected without a page reload. Presentation-only: `npm run build` green, browser-verified on a real day with a populated race note and one with none. Full record: DELIVERABLES.md D164. |
| The per-race LLM bankroll was a number no legal wager could add up to (D163) | merged | PR [#201](https://github.com/KevinRaffay/betsheet/pull/201), branch `llm-per-race-bankroll-whole-dollars` - four races blocked, and **in every one the illegal stake was exactly the leftover** ($172.00/12 = $14.33 against a 50c wager step). The model was handed a target no combination of legal wagers can hit. `perRaceBankrollCents` now FLOORS the share to a whole dollar - floor, not round, since shares must never sum above the bankroll. The first fix in this series to move a generation INPUT rather than prompt text; still an un-versioned comparability boundary. Full record: DELIVERABLES.md D163. |
| LLM prompt fix: the box arithmetic D161 requires must equal the `<stake>` column it prices (D162) | merged | PR [#200](https://github.com/KevinRaffay/betsheet/pull/200), branch `llm-prompt-stake-matches-arithmetic` - live bug report the same evening D161 merged. **D161 worked and the ticket still failed**: the model wrote every factor out, reached the correct 24 combos and the correct $12.00, said in prose that $6 was invalid - and left `<stake>` reading $6, because `<stake>` is emitted BEFORE `<rationale>`, so showing the work happens after the number is committed. The arithmetic is now stated to BE the price: its `= $<total>` must equal `<stake>`, and a disagreement is fixed by rewriting the line, never by narrating it. Also fixes a latent spurious-warning bug in D161's own wording (`$<base>` -> `$<per-combo>`, which is what `STAKE_CHECK_RE` actually compares). Prompt text only. Full record: DELIVERABLES.md D162. |
| LLM prompt fix: box bets must show combo arithmetic in the rationale, after D160 alone didn't stop a recurrence (D161) | merged | PR [#199](https://github.com/KevinRaffay/betsheet/pull/199), branch `llm-prompt-box-arithmetic-shown` - one race after D160 merged, the SAME 4-horse trifecta box miscount recurred on a request confirmed (by `prompt_template_version`) to have read the post-D160 prompt - a worked example alone wasn't enough. Escalates to requiring the model to show its combo arithmetic as output tokens ("show your work"), which also activates the existing D84 teller-grammar cross-check for free since the LLM's `<rationale>` column is what that check scans. Prompt text only. Full record: DELIVERABLES.md D161. |
| LLM prompt fix: trifecta box combo count used the exacta-box formula, one factor short (D160) | merged | PR [#198](https://github.com/KevinRaffay/betsheet/pull/198), branch `llm-prompt-trifecta-box-combo` - live bug report: a real generation boxed 4 horses in a trifecta box four times and priced each as 12 combinations (exacta's formula) instead of the correct 24, plus once wrote a box selection under the bare (non-box) bet type name. Prompt text only, no parser/schema change. Full record: DELIVERABLES.md D160. |
| Race day notes entry: "Enter Analyst Notes" reachable before any card exists (D159) | merged | branch `race-day-notes-entry` - user-supplied scope doc's premise was stale (it described a card-scoped notes table needing migration to race-scoped; D92 already made `llm_notes` race-scoped). Built only the missing piece: a new `RaceDayNotesModal.jsx` on `RaceDayView.jsx` writing through the SAME `llm_notes` draft `LlmCardModal.jsx` reads/writes - no migration, no new endpoint. Shared editor UI extracted to `AnalystNotesEditor.jsx`. Full record: DELIVERABLES.md D159. |
| The at-track race screen fits a phone: no rank column, entries collapsed, no eligibility boilerplate (D158) | merged | branch `mobile-entries-trim` - all three were pushing the ticket builder below the fold. `EntriesTable` gained `showRank` (default TRUE, so the three desktop callers are untouched); the static payload carries no `program_rank` at all, so the column was a dash on every row. Entries collapse via a new `static/src/mobile.js` `useIsMobile`, since `<details open>` is DOM state CSS cannot close. Conditions removed from the RENDER only - the field stays in the payload, so no `payloadHash` moves. Full record: DELIVERABLES.md D158. |
| HOUSE RULE: a call to action must stay reachable without sideways scrolling on a phone (D157) | merged | branch `mobile-cta-visible` - **user rule 2026-09-07**, found on the live Pages builder. `.grid { overflow-x: auto }` stops a wide table stretching the page by pushing the RIGHTMOST column out of sight, and in every table here that column is the button. Descriptive columns now carry `col-detail` and are hidden below 720px; desktop is unchanged. Enforced by `check-static-app`, with a negative control. Full record: DELIVERABLES.md D157. |
| Fix: the Pages workflow segfaulted on its first run - node 20 vs dependencies requiring 22+ (D156) | merged | branch `fix-pages-workflow-node` - `npm ci` only WARNS on an engine mismatch, so a wrong runtime installs a native binding for the wrong ABI and `better-sqlite3` segfaults on load (exit 139, no output). Pinned to node 24, `engines.node` declared, and a guard step that refuses a bad runtime before any check runs. Also dropped `actions/configure-pages`, whose outputs this build ignores and which fails when Pages is not enabled - the `build` job is now Pages-independent and goes green today. Full record: DELIVERABLES.md D156. |
| Static Pages target: build HUMAN cards on a phone at the track, carry them home as files (D150-D155) | merged | branch `static-pages-target` - a build-only deploy of a card CONSTRUCTION surface: no corpus, no grading, no generation, no database. The payload hash covers the race day alone, so the home import can verify the entries have not moved; LLM/OTR exclusion is structural and proven against the BUILT bundle; import is idempotent on `cards.external_id`, which is what makes the rolling backup free. Browser and offline testing found five real bugs. **Not a current concern - see the scope note above.** Full record per ID: DELIVERABLES.md D150-D155. |
| LLM cards: capture generation inputs (prompt, response, notes, model, template version), not just outputs (D149) | merged | PR [#191](https://github.com/KevinRaffay/betsheet/pull/191), branch `llm-input-capture` - two cards generated from different notes payloads had no way to be reproduced or diffed. Widened `llm_card_requests` (migration 026, reused rather than a parallel table) with correlation id, prompt/notes hashes and a hash-derived template version; export bumped to `SCHEMA_VERSION` 3 with an `llmInputs` block (`null`, never `[]`, when unknown) and `?omitLlmInputs=1` for a redacted form. Full record: DELIVERABLES.md D149. |
| LLM prompt fix: forbid "part-wheel" straight bets - their true combination count was never computed (D148) | merged | PR [#190](https://github.com/KevinRaffay/betsheet/pull/190) `llm-prompt-no-part-wheel` - a real generation's comma-separated list within one straight-bet position multiplied to 18 real combinations the model never computed. Fixed by forbidding the construction outright rather than teaching the math; the parser itself is unchanged (a human's own paste can still use a part-wheel). Full record: DELIVERABLES.md D148. |
| LLM card modal: pick WHICH LLM card, not just the latest (D147) | merged | PR [#189](https://github.com/KevinRaffay/betsheet/pull/189) `llm-card-picker` - a card generated with one model became unreachable once a newer card existed. Added a card picker mirroring D140's human-card one; fixed a stray literal `0` rendering bug (SQLite's `EXISTS` returns a number, not a boolean) in both this new code and D140's original. Full record: DELIVERABLES.md D147. |
| LLM prompt fix: win/place/show's $2 minimum was never stated (D146) | merged | PR [#188](https://github.com/KevinRaffay/betsheet/pull/188) `llm-prompt-wps-minimum` - the `<stake>` rule covered exotic divisibility but never mentioned the WPS floor, which no wager menu can override. Prompt text only, no parser/schema change. Full record: DELIVERABLES.md D146. |
| LLM prompt fix: a straight exotic's total must also land on the wager type's base unit (D145) | merged | PR [#187](https://github.com/KevinRaffay/betsheet/pull/187) `llm-prompt-straight-exotic-increment` - the divisibility rule only ever said "for a BOX bet", so a straight exotic looked exempt. Prompt text only. Full record: DELIVERABLES.md D145. |
| UI fix: "Calling the model…" spinner moved beside the Generate button (D144) | merged | PR [#186](https://github.com/KevinRaffay/betsheet/pull/186) `llm-loading-beside-button` - the loading indicator rendered below the fold on a card with several entries. Presentation-only. Full record: DELIVERABLES.md D144. |
| Race-days list: bulk-select and delete, skipping graded days; new Graded column (D143) | merged | PR [#185](https://github.com/KevinRaffay/betsheet/pull/185) `bulk-delete-race-days` - "graded" is deliberately the simple day-level definition (results exist), scoped to bulk-delete only; the existing single-day delete is untouched. Refusal is enforced server-side and unconditionally. Full record: DELIVERABLES.md D143. |
| Fix: Equibase OTR confirm didn't refresh the Betting cards table without a page reload (D142) | merged | PR [#184](https://github.com/KevinRaffay/betsheet/pull/184) `otr-confirm-refresh-cards` - two sibling components had no wire between them; fixed with a version counter passed as a key. Full record: DELIVERABLES.md D142. |
| P-2.5: `/new` page's paste box retargeted at the Equibase HTML parser; the plain-text pasted-entries parser deleted (D141) | merged | PR [#183](https://github.com/KevinRaffay/betsheet/pull/183) `equibase-paste-parser` - the paste box now calls the same parser and route the file-upload button already used; the obsolete plain-text parser, its route, and its fixtures were removed. Full record: DELIVERABLES.md D141. |
| Build the card by hand: pick WHICH human card, not just the latest (D140) | merged | PR [#182](https://github.com/KevinRaffay/betsheet/pull/182) `human-card-picker` - a half-built human card became unreachable once a newer one was started. Added a card picker; browser verification found locking onto an already-graded card silently regrades it (now warned, not blocked). Full record: DELIVERABLES.md D140. |
| Human-card identity moved fully inside "Build the card by hand" (D139) | merged | branch `human-card-modal-owns-identity` - D137's card picker/name field moved from the calling panels into the modal itself, mirroring how the LLM modal already owns its own identity. No schema/API change. Full record: DELIVERABLES.md D139. |
| LLM prompt: forbid stacking straight tickets to fake a box (D138) | merged | branch `llm-prompt-no-fake-box` - two straight tickets covering both orders of the same two horses cost and cover exactly what one exacta box does. Prompt text only, no parser/grading change. Full record: DELIVERABLES.md D138. |
| Multiple HUMAN cards per race day, with an optional card name (D137) | merged, UI superseded by D139 | branch `human-card-names` - migration 025 adds nullable `cards.name`, frozen at creation; the schema/API half stands, the original UI placement was replaced by D139. Full record: DELIVERABLES.md D137. |
| LLM prompt: no more free-form reasoning paragraph - cuts response tokens (D136) | merged | branch `llm-prompt-terse-reasoning` - the per-ticket `<rationale>` column already carried the reasoning; the prose paragraph duplicated it at higher token cost. Un-versioned prompt-comparability boundary. Full record: DELIVERABLES.md D136. |
| ReplayRaceView's entries table consolidated onto the shared component (D135) | merged | branch `replay-entries-table-shared` - a third hand-rolled copy of the entries markup became the shared `EntriesTable.jsx`, which gained BEST BET/SCR tags for every caller in the process. Full record: DELIVERABLES.md D135. |
| Day builder: entries shown in the same collapsible dropdown as the LLM generator (D134) | merged | branch `day-builder-entries-dropdown` - extracted the LLM modal's entries dropdown into shared `EntriesTable.jsx` rather than copying it. Presentation-only. Full record: DELIVERABLES.md D134. |
| Modal backdrop click never closes/locks a dialog - a house rule (D131-D133) | merged | branches `llm-modal-no-backdrop-close`, `day-builder-no-backdrop-close`, `modal-backdrop-house-rule` - an accidental backdrop click was discarding an in-progress LLM generation (D131) and, worse, LOCKING races into the database on the day builder (D132, since its close path auto-locks previewed tickets). Fixed on both modals; D133 confirmed `ReplayRaceView` has no modal to fix and wrote the rule into Gotchas. Full record: DELIVERABLES.md D131, D132, D133. |
| Day builder: footer buttons moved to the right edge with more spacing (D130) | merged | branch `day-builder-footer-buttons` - presentation-only flex layout fix. Full record: DELIVERABLES.md D130. |
| Retroactive "If it hits" estimates on pre-D91 tickets (D96) | in review | branch `backfill-payout-estimates` - fills the gap D95 shipped with, using the same shared estimator the three writers call. Full record: DELIVERABLES.md D96. |
| GitHub API from local credentials + a local guard on main (D101) | in review | branch `github-api-access` - `npm run gh` reaches the API through the Git Credential Manager token that already authenticates pushes; `npm run install-hooks` refuses direct pushes to `main`. Full record: DELIVERABLES.md D101. |
| Scratch environment: betsheet-alt is a separate clone (D83) | in review | PR [#118](https://github.com/KevinRaffay/betsheet/pull/118), branch `alt-environment-docs` - a factory reset touches only two env-configured paths, so a separate clone is the only isolation that can't be forgotten. Full record: DELIVERABLES.md D83. |
| **Foundations, D01-D28** (scaffold, logging, schema+migrations, the first entries parser, ingest UI, card view, results-chart parser, chart PDF, results ingest, the grading engine, P/L views, trace export, distributions, soft delete, factory reset, card recipes) | merged | The loop everything since is built on: ingest -> card -> grade -> report. Collapsed 2026-09-08; each still has its own row, PR link and rationale in DELIVERABLES.md under its ID. The invariants they established are in Invariants above, not here. |
| **Provenance and sources, D34-D52** (engine versioning, track canonicalization, the dmtc results parser, browser routes D44-QA, card hard-delete D49-QA, the lean-1.1 findings doc D52) | merged | Where invariant 14's version stamping and `shared/track-codes.js` came from. Collapsed 2026-09-08; full record per ID in DELIVERABLES.md. |
| **Human cards and Replay, D54-D57, D60-D62, D84-D87, D95, D100-D103** (the paste parser and HUMAN bucket, blind lock/reveal and the standing table, the teller grammar and its reformat, the ticket builder inline and as a day modal, drafts, closing-locks-previews) | merged | The HUMAN half of the corpus and invariant 15's blindness rules. Collapsed 2026-09-08; full record per ID in DELIVERABLES.md. |
| **LLM cards, D63-D67, D70, D75-D76** (per-race generation, the modal, box-stake and payout-estimate fixes, model picker, model identity and the P/L `byModel` breakdown) | merged | The LLM_GENERATED bucket as it stands. Collapsed 2026-09-08; full record per ID in DELIVERABLES.md. |
| **Equibase OTR, D71-D73, D78** (the printed sheet as a picker, upload panel and batch CLI, the payout-estimate fix, archive isolation) | merged | The EQB_OTR bucket. Collapsed 2026-09-08; full record per ID in DELIVERABLES.md. |
| **Dev harness, D77-A, D80, D97** (content-hash watcher instead of `node --watch`, the port preflight and cleaner, the agent's own preview ports) | merged | Every trap these fixed is written up in Gotchas, which is the copy that matters. Collapsed 2026-09-08; full record per ID in DELIVERABLES.md. |
| **The pivot's rebuild, D110-D129** (the removals D110-D114, then the Equibase entries schema and ingest, staleness, the grader regression, the batch harness and the three parser defects it found, the track registry, surfaces, name suffixes, zip ingest, list filters) | merged | How the post-pivot ingest path was built and proved across 91 real pages. Collapsed 2026-09-08; full record per ID in DELIVERABLES.md. |
| **Retired by the 2026-09-05 pivot** (D05, D07, D08c, D09, D10, D18, D19, D25, D30, D31, D32, D33, D36, D40, D41, D43-D47, D48, D48-QA, D49, D50, D51, D53, D58, D59, D68, D69, D74, D77-B, D82) | deleted | Each of these shipped, worked, and is now GONE - the consensus fetch and D09 classification, the lean engine and its templates, the simulator, the Del Mar program and Bottom Line ingestion, the ML sheet, the dmtc crawler, the batch backfill runner and its four meet runs, SFTB, At The Races, and the OTR sheet's consensus half. **They are collapsed here rather than deleted because the stored corpus was PRODUCED under them** and cannot be read without knowing they existed: every PROGRAM_ONLY figure is a backfill figure, every `lean-*` card came from the deleted engine, and every UNANIMOUS/SPLIT/CHAOS value on a stored race is D09's. **Not one of them is a gap to fill.** Full record per ID: DELIVERABLES.md, and the pre-trim rows verbatim in docs/claude-md-pre-trim-2026-09-06.md. |

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
  cannot see this counter, so the eyeball-the-ledger fallback is still the
  right move there, carefully, until/unless this is ever made networked.
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
- **State that must track a prop is adjusted during RENDER, not in an effect**
  (D155). `RaceView.jsx` keeps a snapshot of a race's already-saved ticket
  text and composes the builder's output on top of it. Reading that text LIVE
  duplicates every ticket: the saved card flows back down as a prop, the
  snapshot becomes the sum, and the next render recomputes `$20 W 1` as
  `$20 W 1 / $20 W 1` - with no new event at all, the render alone does it.
  Moving the snapshot into a `useEffect` fixes that and breaks something
  worse: **child effects run before parent effects**, so `TicketBuilder`'s
  mount-time `onChange('')` fires while the parent still holds the previous
  (empty) snapshot and writes an empty race over saved text - re-opening a
  race erased the work in it. Both are fixed by React's documented pattern
  for this exact case: compare a key during render and `setState` right there,
  so the new value is in place before any child commits. Neither bug is
  reachable from a check script (they need a real render tree) and both were
  found by driving the app in a browser.
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
  !(handle->flags & UV_HANDLE_CLOSING), file src\winsync.c` and returned
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
  Vite entry and reaches outside `static/` in exactly seven places (verified
  2026-09-08, and the list is the thing to re-derive rather than trust):
  `@client/components/TicketBuilder.jsx`, `@client/components/EntriesTable.jsx`,
  `@client/styles.css`, `@shared/betmath.js`, `@shared/parsers/human-picks.js`,
  `@shared/static-export.js`, `@shared/static-payload.js`. A change touching
  none of those, nor `static/` itself, nor anything they transitively import,
  provably cannot move the static bundle. When a change DOES touch them, run
  the check from the primary checkout, where it works as designed. State plainly in the final message that it was skipped as
  out of scope per this rule - never imply the suite ran clean when this one
  did not run at all.
- **A race-specific input or edit belongs in the Race UI component - HOUSE
  RULE** (user rule, 2026-09-08, D182/D184). If a thing is an opinion about,
  or a property of, ONE race, the place to type it is that race's own panel,
  as tightly coupled to it as the code allows - not a day-level list, not a
  modal that enumerates every race, not a second screen. Analyst notes and tip
  sheets are both now entered exactly there, beside that race's entries.
  **The rule is about where a fact is AUTHORED, not about where it may be
  read**: the same note still renders read-only on the card sheet
  (`RaceNotes.jsx` in `CardView.jsx`), because a card is a record of what was
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
