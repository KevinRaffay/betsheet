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
   and a source that resists falls back to manual paste.
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

| file | owns |
| --- | --- |
| `server/index.js` | the HTTP server: serves `dist/`, the `/api/*` endpoints, loopback binding, `/api` request logging. |
| `server/logging.js` | structured JSON-lines logging: the three streams (`app`, `fetch-audit`, `decision-trace`), size+day rotation, gzip/retention sweep, correlation IDs, `readRecent`. Writes are synchronous and never throw. |
| `scripts/check-logging.js` | verification for logging: rotation, sweep, retention, torn lines, level gating. |
| `scripts/dev-watch.js` | the dev supervisor behind `npm run dev`: spawns `server/index.js` and restarts it only when a watched file's CONTENT hash moves (not `node --watch`, which restarts on Windows metadata-only filesystem events - AV scan, indexer, `git fetch` - and force-kills the child mid-request; see Gotchas). Watches `server/` + `shared/` recursively for `.js/.mjs/.cjs/.json/.sql`, skipping `logs*`/`node_modules`/`.git`. |
| `server/db.js` | SQLite via better-sqlite3: `openDb` (applies migrations, WAL, FKs on, tamper guard), `getDb` singleton. A migration headed `-- betsheet:schema-rebuild` runs outside the wrapping transaction with FKs OFF (table rebuilds; DROP TABLE on a parent with FKs ON cascades deletes) and must pass `foreign_key_check` before commit. |
| `server/migrations/` | append-only numbered SQL migrations; `001-initial.sql` is the FULL schema, Phase 2-4 tables included. **Shipped migrations are immutable** - a repair is the next number, never an edit. A `-- betsheet:schema-rebuild` header is needed whenever a CHECK constraint changes (CHECK cannot be ALTERed). **`race_days` is the riskiest table to rebuild** - ten `ON DELETE CASCADE` children - verified against a `VACUUM INTO` copy of the real corpus, never a fixture. Conventions everywhere: money is integer cents, program numbers are TEXT (`"1A"`), results key on race NUMBER, ids are AUTOINCREMENT where invariant 12 forbids reuse. |
| `scripts/check-schema.js` | verification for the schema: tables, constraints, cascades, idempotence, tamper guard, whole-graph smoke insert. |
| `server/source-audit.js` | the fetch audit trail: sources, and one row per attempt. **Nothing in this codebase fetches anything automatically any more** - no robots.txt guard, timeout wrapper or User-Agent left, since there is no fetcher to need them. Every ingest attempt still lands in BOTH `fetch_attempts` and the fetch-audit stream (invariant 11). |
| `shared/staleness.js` + `scripts/check-staleness.js` | how old are the entries in front of you. PURE and browser-safe; `now` is always PASSED IN, never read from the clock. One `odds_captured_at` per card means **later races are staler than earlier ones by construction**. The capture age is EXACT, but whether a race has already run is NOT claimed except where no timezone is needed (`ran: null` otherwise, `assumesViewerClock` flagged on the day itself). No capture time reads `unknown`, never `fresh`. `STALE_AFTER_MINUTES` (75) is exported and overridable. |
| `shared/track-codes.js` | track name canonicalization, pure. `canonicalizeTrack` maps every known spelling to one `{ code, display }`; a new track is a registry entry, never a call-site special case, and an unrecognized track still gets a derived (non-blocking) code. The ONE place `insertRaceDay`, the one-day-per-track+date check, the results-chart mismatch refusal and `meetForDay` all key on. Also owns `meetFor`/`meetForDay` (`race_days.meet`, read by the P/L and Distributions selectors) - Del Mar is the only track with named sub-meets. Registry covers 39 tracks, keyed on Equibase's OWN track id (never the derived first-three-letters fallback, which collides across tracks). `scripts/check-track-codes.js` pins the silent-failure properties: no shared codes, no ambiguous spellings, no unmatchable alias. |
| `tests/fixtures/days/` | parsed race-day DATA for fixture days the check suites build real-day scenarios on - not parser goldens, nothing here is diffed against a parser any more. `delmar-2026-08-30.entries.json` (10 races, 98 entries) and `dmtc-2026-09-03.entries.json` (8 races, 81 entries) are frozen outputs of two now-deleted parsers, kept because several check suites still need these exact days and downstream fixtures (chart, OTR sheet) are pinned to them. **Never regenerate either.** See the directory's README. |
| `tests/fixtures/graded-cards/` + `scripts/check-graded-card-fixtures.js` | 9 frozen card exports with grade summaries in an `expected.json` sidecar, chosen for the GRADING PATHS they exercise - all four completeness buckets, all four engine versions, three LLM models, 386 tickets. Phase 1 proves the fixtures are internally consistent; Phase 2 (P-6.1) RE-RUNS the real grader and requires an exact match to the cent, per ticket, with a negative control proving the check can fail. A phase-2 failure means grading BEHAVIOUR changed. No card in the corpus carries a multi-race ticket, so doubles/parlay grading has no fixture. |
| `scripts/check-equibase-entries.js` | verification for the Equibase entries HTML parser, PURE. Golden diff plus independent hand-counted assertions (races/entries/post-times/the 12-column claiming-race regression/scratches/also-eligibles) so regenerating the golden cannot bless a regression. `--write-golden` regenerates deliberately. |
| `scripts/batch-import-equibase-entries.js` | `npm run batch-equibase -- <dir>`: runs every saved Equibase page under a directory through the REAL parser and the REAL `insertRaceDay` writer into a throwaway temp-directory SQLite DB (structurally cannot touch `data/betsheet.sqlite`). Exits non-zero only on a parser crash or read-back mismatch; reports fields with no column, tracks missing from the registry, and distinct column counts seen. |
| `scripts/reformat-teller-calls.js` | one-off: re-derives every stored `tickets.teller_call` from the ticket's own `bet_type`/`selections`/`stake_cents` so exactly ONE teller format exists. Idempotent, dry run by default (`--yes` writes). |
| `scripts/backfill-payout-estimates.js` | one-off: fills `tickets.est_payout_*` for rows saved before their writer called the shared estimator. Scope is `engine_version IN ('human','llm','equibase-otr')` - engine cards are deliberately excluded (invariant 14). Only ever fills a NULL; a bet type with no validated formula is reported as declined, never guessed. Idempotent, dry run by default. |
| `scripts/archive-corpus.js` + `archive/` | freezes the pre-pivot corpus: a `VACUUM INTO` snapshot plus one trace export per card. The `.db` is not redundant - it carries `llm_card_requests`/`human_race_state`/`simulation_runs`/`llm_notes`, which a card export does not. Verifies row counts table by table; refuses to clobber without `--force`. **Nothing in the app reads from `archive/`** - it is frozen evidence. |
| `scripts/fix-grade-set-versions.js` | one-off: repairs grade sets stamped with the wrong version. Per card it REGRADES under the card's own version and only then drops the stale set (order is load-bearing - some cards had no correct set at all). Refuses to touch a card whose regrade doesn't reproduce the stale one cent for cent, since that would mean the grader changed. Dry run grades IN MEMORY. |
| `scripts/dev-ports.js` | dev port ownership, shared by the preflight and the cleaner: `probePort` (binds BOTH loopback families - the API binds 127.0.0.1, vite binds ::1) and `holderTree` (the listener's process chain walked UP to the topmost dev-stack ancestor, so a terminal is never named as a kill target). |
| `scripts/dev-preflight.js` | runs BEFORE `concurrently` in the `dev` script: if the api or vite port is taken, prints the holder, the tree root and the exact way to free it, then exits 1 so nothing half-starts. |
| `scripts/gh-api.js` | GitHub API access using the credential git already has (Git Credential Manager, `repo` scope) - `gh` is not installed and the repo is private. The token is never printed/written/placed in argv; every printed byte passes a redactor. **What it may do is fixed by an `ALLOW` allowlist**: GET, PR open/comment, PR merge - nothing that deletes, force-pushes, touches refs or changes repo settings. |
| `scripts/git-hooks/pre-push` + `scripts/install-hooks.js` | the local guard on `main` - server-side branch protection is unavailable on this Free/private-repo combination, so this is the approximation: a hook refusing any push to `refs/heads/main`. `install-hooks.js` points `core.hooksPath` at the TRACKED hooks dir so the hook cannot drift from the file under review. Local-only, bypassable with `--no-verify` by design. |
| `scripts/dev-preview.js` | `npm run dev:preview`: the dev stack an AGENT starts, on ports that are never the human's (api 8795, vite 5185) - `.claude/launch.json` points here instead of `dev`, so browser verification structurally cannot take 8788/5175. |
| `scripts/dev-clean.js` | `npm run dev:clean`: finds stale dev stacks BY PORT, groups by tree root, stops each with `taskkill /T`. Dry run by default, `--yes` kills; re-probes afterwards. A fallback port is only swept when the holding tree is provably this checkout's. |
| `shared/distribution.js` | distribution reporting, pure, browser + Node: `dependenceFor` (single-ticket dependence gross/net, net flag > 0.8), `maxDrawdown`, `distributionFor` (per completeness bucket: losing-day share, drawdown, dependence, refunds, per-day rows; never a pooled total). |
| `server/distribution.js` | `GET /api/distribution?engineVersion=&meet=`: selection rules (latest version by default, `all` pools on request, meet filter, deleted days out), ONE card per day per bucket, figures from the pure module. |
| `client/src/components/DistributionView.jsx` | the Distributions view: per-bucket cards (losing days, max drawdown with its window, dependence flags net vs gross) and a day table with a flagged-only filter. |
| `scripts/check-distribution.js` | drawdown shapes, gross vs net dependence, bucket isolation, the endpoint on a seeded DB. |
| `server/zip-read.js` + `scripts/check-zip-read.js` | a bounded ZIP reader with NO dependency. Reads the central directory and inflates entries, and **REFUSES what it cannot fully support** - encrypted, zip64, unknown compression, truncated, bad CRC. Three caps (entry count, per-entry output, total output) bound decompression, the per-entry one enforced DURING inflation via `maxOutputLength`, never after. **Nothing here writes to the filesystem and no entry name is ever treated as a path** - zip slip is structurally impossible. Verified byte-for-byte against Python's `zipfile`. |
| `server/entries-zip.js` + `scripts/check-entries-zip.js` | bulk entries ingest: one zip of saved Equibase pages -> every race day it holds. `POST /api/parse/equibase-entries-zip` previews and writes nothing (invariant 9); `POST /api/race-days/from-zip` saves, re-reading and re-parsing the archive from its own request body rather than trusting a client-shaped payload. Raw `application/zip` body. Policy A: zero blocking warnings saves, anything blocking is skipped and reported, one transaction PER DAY. An existing day is replaced only with `?replace=1`, which deletes its cards. |
| `server/ingest.js` | the ingest API: `POST /api/parse/equibase-entries` (the Equibase HTML preview, one endpoint serving both a saved-file read and a pasted-markup read), the three results previews, and race-day persistence - `POST /api/race-days` (validated, transactional, 409-on-duplicate with explicit replace), `GET /api/race-days[/:id]` (each row carries `graded`, an `EXISTS(race_results)` check), `DELETE /race-days/:id` (soft, logged), `POST .../restore`, `POST /race-days/bulk-delete` (`{ids:[...]}`, each id handled independently - not-found/already-deleted/graded are skipped with a reason, the grading refusal enforced server-side and unconditionally, scoped to bulk-delete only). Both delete routes share `softDeleteRaceDay(db, day)`. `ENTRIES_SOURCES` here is the SECOND gate on `entries_source` - a value missing from this array is silently coerced to `program` rather than refused. |
| `scripts/check-ingest.js` | end-to-end ingest verification: boots the real server on a temp DB, exercises parse -> save -> read-back -> conflict -> replace -> bad payloads. Also the factory reset's only end-to-end test - reads the table list OUT OF THE SCHEMA rather than naming tables, so the assertion cannot go stale. |
| `shared/parsers/equibase-entries.js` | Equibase entries page -> the entries structure. PURE and browser-safe (no `node:` import). **Columns are mapped from EACH RACE'S OWN HEADER ROW, never a fixed index** - a claiming race inserts an extra column and shifts every field after it. Scratches detected by ROW SHAPE. `parseHeaderBlock` anchors on the block's printed grammar; no track marker means a non-blocking warning, never a guessed split. **The wager menu is load-bearing** - a null one silently falls back to Del Mar's minimums. Never throws. Verified across 91 real pages, ~40 tracks, 3 countries: a card saved 3+ days out has a REDUCED table (no program number, no M/L - post position used instead, flagged PROVISIONAL); the page prints FOUR surface parentheticals (Turf/All Weather/Inner/Outer), stored VERBATIM; Dirt is never printed and is never inferred from absence. |
| `tests/fixtures/sources/` | `sftb-delmar-2026-08-30.expected.json` - a recorded external-source pick set kept as a canned second source several check suites build real-day goldens on. Frozen JSON, never fetched; the fetcher that captured it is gone. |
| `shared/dmtc-results-parser.js` | the dmtc.com results page -> the result structure, browser + Node, pure: header, WPS table, ALSO RAN finish order, SCRATCHED names, the full PAYOFFS grammar (exotics, multi-winner legs, consolations, carryovers), track condition + final time. Its `nameKey` delegates to the shared one in `shared/parsers/human-picks.js`. |
| `scripts/check-dmtc-results.js` | cross-source proof: the same tickets graded from the dmtc page and from the Equibase chart must return identical cents; page goldens + hand checks; save as dmtc_html replaces + regrades. |
| `shared/chart-parser.js` | Equibase results-chart parser (browser + Node): per-race finishers with W/P/S payoff tiers (the mutuel header decides the layout), every mutuel row, scratches with reasons, claimed notes. Unmodeled wagers warn, never guess. |
| `tests/fixtures/charts/` | the REAL Equibase chart for Del Mar 2026-08-30 (PDF + extracted paste-text) with the audited golden - same day as the program and SFTB fixtures. |
| `server/results.js` | results persistence: `POST /api/race-days/:id/results` (confirmed chart or dmtc-page parse; `sourceKind` recorded; also-ran finishers without a program number resolved by name; wrong-track/date refused whole; replace-on-resave; 410 on deleted days), `GET .../results`. Chart scratches carry names only, resolved against the day's entries at save (grading refunds key on them). A results save AUTO-GRADES every card of the day. |
| `shared/grading.js` | ticket grading, PURE: every bet type (WPS per $2, exotics per printed base, `/`-alternate chart legs, parlays chained off win prices, doubles/pick-N off the settling race's payoff row) and the scratch/refund policy. Outcomes: win/refund/partial/loss. The simulator replays this exact grader. |
| `server/grading.js` | grading persistence: `gradeAndPersist` (grade sets keyed by engine version - same version replaces, newer appends, invariant 14; the version defaults from the CARD, never from `ENGINE_VERSION`, since a HUMAN/LLM_GENERATED/EQB_OTR card has no such axis), `gradeAllCards` (the results-save auto-hook), `POST /api/cards/:id/grade` (409 until results land), `GET .../grades`. |
| `scripts/check-grading.js` | grading verification: hand-computed synthetic cases for every bet type and refund rule, a real day graded pure, and a server round-trip (409 before results, auto-grade on save, regrade-replaces, trace events on file). |
| `server/pl.js` | P/L reporting: `GET /api/pl` - per-completeness-bucket totals for ONE engine version (default the latest graded card's version, `all` pools on request), every graded card as a row, ungraded listed separately, deliberately NO pooled all-bucket total (invariant 13). `GET /api/race-days/:id/pl` - per-race × per-card breakdown. The LLM_GENERATED bucket entry also carries `byModel` (a breakdown by `cards.llm_model`, never a second pool) and `byNotes` (the same rows grouped by `cards.notes_present`, notes-first, deterministic order). |
| `client/src/components/PLView.jsx` | the P/L screen: bucket panels, per-day card tables (row click opens the card), an expandable race-by-race matrix comparing a day's cards, the not-graded-yet list. The per-card Engine column appends the model in parens for an LLM card; an "LLM_GENERATED by model" table renders `byModel` whenever it's non-empty. |
| `scripts/check-pl.js` | P/L verification against the real server: bucket-sum isolation, no-pooled-total shape check, cross-agreement with the grading endpoint, per-race cells summing to card totals, soft-delete dropping out of every aggregate and restore bringing it back. |
| `server/trace-export.js` | the analysis feed: `GET /api/cards/:id/export` builds one self-contained JSON per card - recipe, races + entries, sources, allocations, tickets joined with grades, results, and the card's full decision trace read back from the log files by correlation id / cardId. `traceStatus` (complete/partial/missing) cross-references the log against the DATABASE (`card_generated` present, a `ticket_added` for every ticket on file) rather than a self-reported counter, since no surviving producer can emit one honestly. `SCHEMA_VERSION` 3: a top-level `llmInputs` block (an LLM card's generation inputs, grouped by correlation id, one `requests[]` entry per race) - `null` for a non-LLM card or one that predates the capture, never `[]`. `?omitLlmInputs=1` drops the verbatim prompt/response/notes text, keeping hashes/chars. Schema documented in docs/trace-schema.md; bump SCHEMA_VERSION on shape or meaning changes. 410 on deleted days. |
| `scripts/export-trace.js` | CLI twin of the export endpoint (`npm run export-trace -- --card N [--out file] [--omit-llm-inputs]`); same document, no server needed. |
| `docs/findings/` | structure-layer findings per (engine version, bucket, corpus), written from run IDs; see "Findings" below. `llm-analyst-notes-v1.md` is a PRE-REGISTRATION written before the first notes-augmented card was played (three hypotheses, a pre-registered P/L threshold before any claim); it carries the prompt version alongside engine/bucket, since LLM cards have no version axis. |
| `docs/decisions/` | Decision records: what was decided, why, and what was checked - distinct from `docs/requirements/` (specifies work) and `docs/findings/` (reports results). `2026-09-05-simulator-pivot.md` is the first and largest: the consensus engine removed, pre-registration relaxed to "label everything, conclude nothing until n is stated", with which proposal claims verified and which did not, and the sequencing that had to be respected. |
| `docs/requirements/` | per-topic specifications for work that is SPECIFIED BUT NOT SCHEDULED. **Deliverable IDs are deliberately NOT claimed until the work is picked up.** Indexed from REQUIREMENTS.md. |
| `docs/trace-schema.md` | the trace event catalog (envelope, every event with fields) and the export document shape. `check-export` asserts every event type appearing in a real export is documented here. |
| `scripts/check-export.js` | export verification: the server runs with a tiny log-rotation threshold so one card's trace provably spans multiple rotated files; asserts grade joining, regrade appending, doc honesty, named download, 404/410 guards, CLI ≡ endpoint, honest partial/missing flagging when trace files are lost. |
| `server/templates.js` | seeds the three surviving templates - `human`, `llm`, `equibase-otr` - into `strategy_templates` so cards reference them by FK, serves `GET /api/templates` from the TABLE. Not renamed even though OTR never used the lean engine, to avoid churning every stored card's row. `rules` is `'{}'` for all three - none is rule-driven. |
| `client/src/components/ResultsPanel.jsx` | the results section of a stored day: chart paste + PDF upload, warnings-first read-only preview, save/replace, per-race finish/exotics/scratches view. |
| `server/pdf-text.js` | line-reconstructed text extraction from text-based PDFs - the chart PDF path feeds the SAME parser as a paste. `extractPdfLines` races pdfjs-dist against a 45s timeout, since a malformed PDF can wedge pdfjs's Node "fake worker" so the extraction promise never settles. |
| `scripts/check-charts.js` | chart-parser verification: golden + hand-checked payoffs + the program↔chart closure (every program entry is a finisher or a scratch). |
| `scripts/lib/test-cards.js` | card creation for the check scripts. Every check routes card creation through `makeHumanCard`, which locks races through the REAL `POST /race-days/:id/human-cards` writer, so a card made in a check is row-for-row a card a person makes. Tickets are deliberately dull - no script using it is testing ticket construction. |
| `tests/fixtures/engine-cards/` | `delmar-2026-08-30.lean-1.1.json` - a frozen 30-ticket lean-1.1 card, generated by the now-deleted engine immediately before its removal. Two real-day grading proofs build on this exact set. **Never regenerate it** - there is nothing left to regenerate it with. |
| `shared/version.js` | `ENGINE_VERSION` - a legacy label post-pivot. Once the engine is gone no new `lean-*` card is created, so the value stops being bumped; it survives to keep the stored corpus readable. `gradeVersionFor` still needs it as a fallback for a card carrying no `engine_version` of its own. |
| `shared/card-notices.js` | `FAILURE_MODE_WARNINGS`, rendered by `CardView.jsx` on EVERY card sheet - human, LLM and OTR included, not only engine-generated ones. |
| `shared/betmath.js` | every tunable number (`BET`), wager-menu parsing, payout math, teller-call formatting, combo/box costing, `morningLineToDecimal`. Change here, then run the check scripts. `tellerCall` is the ONE teller grammar this codebase emits and parses (`$10 W 5`, `$2 EX BOX 2-4-5`) - money as the PER-COMBO base, byte-identical between what the builder composes and what is stored. `estimateTicketPayouts` is the ONE "If it hits" dispatcher, shared by human/LLM/OTR writers, taking an `mlOf(pgm)` lookup so this file stays browser-safe. **A bet type with no validated formula or a selection with no morning line comes back UNCHANGED BY IDENTITY** - never a guessed multiplier. |
| `server/cards.js` | card API, READ side: `GET /api/race-days/:id/cards` (also `locked_races`/`revealed_races`/`graded` per card via correlated subqueries), `GET /api/cards/:id` (races, entries, Bottom Line, nested `results`), `DELETE /api/cards/:id` (confirmed hard-delete, cascading). Card ids are AUTOINCREMENT, never reused. No longer owns generation - the three surviving producers (`equibase-otr.js`, `llm-cards.js`, `human-cards.js`) each write their own rows. |
| `shared/parsers/human-picks.js` | human ticket parser, PURE: pasted text for ONE race -> a ticket shape. Never throws; each warning carries its own `blocking` boolean. **MUST STAY BROWSER-SAFE** - `TicketBuilder.jsx` imports it - no `node:` import, ever. TWO grammars (teller: a line leading with money; columns: `bet type | selections | stake`, which `server/llm-cards.js` also parses a model's response with), converging on one `buildTickets` tail. Always emits `estMin/Max/IsRange` null - the SERVER fills them. `nameKey`/`stripParens` are the ONE horse-name normalizer in the codebase, stripping a bred-country/state suffix before comparing. |
| `server/human-cards.js` | human cards API. `previewHumanRace` never writes; `persistHumanRace` is the ONE writer and re-parses `text` itself on save, refusing 422 on any blocking warning. `POST .../human-cards/preview` and `POST .../human-cards` (`{race, text, pass?, bankrollCents?, cardId?, name?}`) - an omitted `cardId` always starts a NEW card; `name` is frozen at creation, ignored on later calls. A locked race writes one `allocations` row and sets `race_days.replayed_at` on the day's first-ever lock. Grades immediately when the day has results, under `engine_version: 'human'`. `deleteHumanTicket` (delete, never edit - editing would re-stamp `picks_locked_at` and flip blindness) refuses on a REVEALED race or a card with ANY grade set. `loadRace`/`scratchedProgramNumbersFor` are exported for `server/llm-cards.js` to reuse. |
| `scripts/check-human-picks.js` | verification: a PURE teller-grammar phase before the server boots, including an executable inverse proof that every ticket re-parses from its own `tellerCall` to an identical ticket; then the full server round trip - every warning type, save-side blocking independent of preview, PASS, the append-only-on-conflict remedy, bucket isolation. |
| `docs/prompts/llm-card-v1.md` | LLM cards: the base-text origin, the v1 deviations (no search tool, per-race not per-day, structured ticket-block output reusing `shared/parsers/human-picks.js`), and the exact per-race system/user prompt template `server/llm-prompt.js` implements. Keep the doc and the code in sync when the template changes. This is the template `PROMPT_TEMPLATE_ID = 'llm-card-v1'` names; the recorded version is a hash of `SYSTEM_PROMPT`, not the doc's own filename suffix. |
| `server/anthropic-client.js` | `KNOWN_MODELS` is every model ever offered (retired entries flagged, since `server/pl.js` builds its `byModel` labels from this list); `SELECTABLE_MODELS` is the non-retired subset the picker reads. Thin Anthropic Messages API client (hand-rolled, no SDK, key never ships to the browser): `complete` (AbortController timeout, a prefill retry, `model` param override, echoes back the resolved `requestParams` `{maxTokens, temperature}`), `AnthropicError`, `hasKey()`. `ANTHROPIC_API_KEY` required; `BETSHEET_LLM_MODEL` sets the server default only. `DEFAULT_REQUEST_PARAMS` is exported for a call that never reached the API. |
| `server/llm-prompt.js` | LLM card prompt, PURE. Mirrors `docs/prompts/llm-card-v1.md`. `buildSystemPrompt({hasNotes})` and its `ANALYST_NOTES_CLAUSES` **must stay CONDITIONAL** - `buildSystemPrompt({hasNotes:false}) === SYSTEM_PROMPT` is asserted, since an LLM card has NO version axis (`engine_version` is the literal `'llm'`) and an unconditional prompt change would pool silently with every prior card. Every real prompt-content change is therefore an un-versioned, permanent boundary, checkable per card via `llm_card_requests.prompt_text` for a phrase that predates the change (the codebase's PR history is a long list of these; see DELIVERABLES.md for the individual fixes). `sanitizeNotesForPrompt` destroys marker-shaped text at the INPUT boundary. `extractTicketBlock` splits a response on the `<<<TICKETS>>>` markers, `null` when missing (hard failure). `PROMPT_TEMPLATE_ID`/`PROMPT_TEMPLATE_VERSION` identify which template rendered a stored prompt - the version is a hash of `SYSTEM_PROMPT` computed at module load, not a manually bumped counter. |
| `server/llm-notes.js` | analyst notes: the mutable DRAFT store plus the composition that turns a draft into the immutable per-call snapshot. Keyed by `(race_day_id, race_number)`, 0 = the day-level note - NOT by `card_id`, since notes belong to a RACE and the first preview of a brand-new card has no card id yet. `llm_notes` is the only mutable table in the LLM subsystem; the immutable record is the snapshot on `llm_card_requests`. `loadNotesForRace` also returns the composed/sanitized/truncated text it hashes, so a caller storing it doesn't recompute it. |
| `server/llm-cards.js` | LLM cards API. `previewLlmRace` calls the model, logs the attempt to `llm_card_requests` **regardless of outcome** (invariant 11) - correlation id, system/user prompt hashes, composed notes text, prompt template id/version and resolved request params all ride on the row - and parses a well-formed response through `shared/parsers/human-picks.js`; never persists (invariant 9). Traces `llm_request_sent`/`llm_response_received` around the call. `persistLlmRace` is the ONE writer: re-loads and re-parses the STORED response server-side, refuses 422 on any blocking warning, traces `race_regenerated` whenever it replaces tickets already on a race. **Card identity is frozen at creation** (`cards.llm_model`, 409 on a mismatched save); `cards.notes_present` LATCHES instead. Per-race bankroll recomputes on every call via the exported `perRaceBankrollCents`, which FLOORS the share to a whole DOLLAR (D163) - an even division lands on figures like $14.33 that no combination of legal wagers can spend, and flooring rather than rounding also keeps the shares from summing above the bankroll. An omitted `cardId` starts a NEW card. |
| `client/src/components/EntriesTable.jsx` | the `Entries (N)` dropdown (#/Horse/Jockey/Trainer/M-L/Rank, BEST BET/SCR tags), shared by `LlmCardModal.jsx`, `DayTicketBuilderModal.jsx` and `ReplayRaceView.jsx` so one race's entries list exists in exactly one rendering path. `normalizeEntry` accepts EITHER casing an entries array arrives in. |
| `client/src/components/AnalystNotesEditor.jsx` | D159: the shared analyst-notes editing UI (`NotesEditor`, `NoteSourceDatalist`, `NOTES_MAX`, `SOURCE_SUGGESTIONS`) - presentational only, no fetch of its own. Extracted from `LlmCardModal.jsx` so `RaceDayNotesModal.jsx` renders the identical caps/vocabulary rather than a second copy that could drift. |
| `client/src/components/RaceDayNotesModal.jsx` | D159: "Enter Analyst Notes" - a second entry point onto the SAME `llm_notes` draft (D92) `LlmCardModal.jsx` reads/writes, reachable from `RaceDayView.jsx` before any card exists. No new endpoint and no schema change: it calls the existing `GET/PUT /api/race-days/:id/llm-notes`, keyed by `(race_day_id, race_number)` same as always, so a note entered here is the same row the generator's own notes UI shows and edits - not a draft-vs-override pair. Flushes any pending edit on Close/Escape before calling `onClose`, matching the modal-backdrop house rule (no backdrop-click dismissal). |
| `client/src/components/LlmCardModal.jsx` | the LLM card generator, a modal over `CardsPanel.jsx`. One row per race (Generate/Regenerate -> preview -> explicit Save), each generated race in its own collapsible panel sourced from the card's SAVED tickets. An `LLM card` picker lists every LLM card on the day (newest first, "New card" included); `switchTo(id)` is the card-session boundary (drops preview/correlationId, keeps day-level notes). The model picker is **locked once a card with an `llm_model` is resumed**. A graded card gets a non-blocking silent-regrade warning before a lock. Every effect calls its loader inside a block body - see Gotchas. Its notes editor UI lives in the shared `AnalystNotesEditor.jsx` (D159). |
| `scripts/check-llm-cards.js` | verification for LLM cards: the pure prompt builder and ticket-block extractor, then a real server round trip with `BETSHEET_LLM_TEST_MODE=1` and no API key - `__stubResponse` carries a canned response through the exact preview/save path a real call would take. Covers preview -> save -> append, per-race bankroll math, a malformed response, an unknown-program-number response, model selection, `llm_model` locking, bucket isolation, analyst notes (draft/snapshot immutability, prompt-injection containment). |
| `shared/parsers/equibase-otr.js` | Equibase "Off to the Races" PDF parser, PURE: `parseEquibaseOtrTsv` takes `pdftotext -tsv` output and returns, per race, the four printed tickets as program numbers verbatim. **`-tsv` is required, not a preference** - other pdftotext modes interleave or scramble the two tiers. Words grouped by `(page, round(top))`, split into tiers by x-coordinate. A trivia-line guard prevents a `Race N:` header's trivia sentence from corrupting the following race. Box lists parsed BY their printed grammar; an unknown program number is `blocking` for that ONE ticket only. Never throws. |
| `server/equibase-otr.js` | Equibase "Off to the Races" ingest + the batch CLI's logic. `POST /race-days/:id/equibase-otr` archives the upload and returns a PREVIEW (never writes). `POST .../confirm {parseToken}` re-reads the ARCHIVED bytes, verifies the sha256, writes THREE cards in one transaction (`some-reward`/`higher-reward`/`both`, append-only, bucket `EQB_OTR`). `resolvePdftotextCommand` prefers the winget Poppler over this machine's PATH xpdf, which silently lacks `-tsv`. The day's track/date are checked against the sheet's header, refused 422 on a mismatch. `batchIngestEquibaseOtr` walks a folder under policy A, idempotent by `confirmed_sha256`. |
| `scripts/ingest-otr.js` | batch ingest CLI: `npm run ingest-otr -- [dir]`, a thin wrapper around `batchIngestEquibaseOtr` - one line per file plus a summary. |
| `client/src/components/EquibaseOtrPanel.jsx` | the Equibase OTR upload panel on `RaceDayView.jsx`: file input -> Preview (tickets per variant, warnings, totals) -> Confirm & save three cards. Shows an append-only notice when the day already has OTR cards. Takes an `onSaved` prop so the sibling `CardsPanel` refreshes without a page reload. |
| `scripts/check-equibase-otr.js` | verification: the pure parser against ALL real archived files (golden picks, zero warnings) plus synthetic edge cases, then a real server round trip - upload -> preview -> confirm -> three cards, append-only re-upload, per-ticket blocking, the track/date mismatch refusal, bucket isolation, the batch CLI run as an actual subprocess (idempotent on re-run). |
| `shared/replay.js` | Replay, PURE: `computeBlindness` (max over EVERY lock vs. the min reveal - a race locked after another race's reveal makes the whole card SEQUENTIAL; a card that isn't the day's first human card is NON_BLIND unconditionally), `isCardClosed`, `pickerAgreement`, and a re-export of `maxDrawdown`. |
| `server/replay.js` | Replay API. Day picker, day landing (one row per race with status/entries/wagerMenu/locked tickets), blind race view, reveal, close, standing. **Invariants**: pre-reveal, no `results`/`finishOrder`/`payoffs` key exists AT ALL. `close` uses ONE timestamp for the whole call, so a genuinely pre-committed day still reads PRE_COMMIT. Never constructs a human ticket itself - the lock/pass flow calls the human-cards endpoints. |
| `client/src/components/ReplayDayPicker.jsx` | the `/replay` day list: every stored day with results, "Random unplayed day", a link to Standing. |
| `client/src/components/ReplayDayLanding.jsx` | the `/replay/day/:id` landing page: a "Build tickets for the day" button, then every race in the day with status, resolving the day's own human card the same way `ReplayRaceView` does (a DISPLAY concern only - card SELECTION lives in the modal). Clicking a race row renders `ReplayRaceView` in place. Once the day is CLOSED it renders the final card embedded, gated on `summary.closed` (never "has results", since every Replay day has those by construction). |
| `client/src/components/ReplayRaceView.jsx` | the blind per-race screen: entries + Bottom Line, `TicketBuilder.jsx`, Preview/Lock/PASS, locked-ticket display, and Reveal (finish order, exotics, human vs lean side by side, the full graded-tickets table once the card is closed). Resumes the day's own latest human card on mount via its own `listCards` call. **Edit rule**: a locked race may be re-opened only while NOTHING on the card is revealed. |
| `client/src/components/TicketBuilder.jsx` | the ticket builder, mounted inline in `ReplayRaceView.jsx` and per race in `DayTicketBuilderModal.jsx`. A CONTROLLED TEXT PRODUCER: composes the teller grammar and hands the string up, posting nothing itself - the server still re-parses independently (invariant 9). Every number shown comes from the SAME code the server validates with. Not bidirectional: starts empty, never parses text back. No payout estimates in the builder - the server fills them at preview. |
| `client/src/components/DayTicketBuilderModal.jsx` | the day-level ticket builder, opened from `ReplayDayLanding.jsx` and `CardsPanel.jsx` - callers pass only `dayId`/`bankrollCents`/`context` (`'replay'`\|`'live'`, wording only). Owns its own card identity end to end: a `Human card` `<select>` lists every human card on the day (locked-race/ticket/spend counts, a `graded` marker) plus `New card`, so a half-built card is always reachable. **Switching is a card-SESSION boundary** - previews and `correlationId` drop, drafts persist (they belong to (day, race), not to a card). **Locking onto a GRADED card is warned about, never blocked** (it regrades and moves a reported P/L figure, with no in-app way back). **Closing the dialog LOCKS every race with a clean preview.** A locked race is DELETE-ONLY, never editable. Every `useEffect` here calls its loader inside a block body - see Gotchas. |
| `client/src/components/ReplayStanding.jsx` | `/replay/standing`: one row per (blindness, saw-classification) group - human P/L, ROI, vs-lean delta, drawdown, plus the picker-agreement summary. |
| `scripts/check-replay.js` | verification: pure `computeBlindness`/`isCardClosed`/`pickerAgreement` unit cases, then a server round-trip - the blind view's key-set discipline before/after reveal, close() idempotence, standing's meet pooling, bucket isolation. |
| `client/src/components/CardsPanel.jsx` | the cards section of a stored day: the cards on file, and the two ways to make one - "Generate Card from LLM" and "Build card by hand", each passed this panel's own `reload` as `onCardChanged`. Neither modal is told which card to open onto - each resolves and manages its own card identity. |
| `client/src/components/CardView.jsx` | the card sheet: per-race tables (bet type/selections-rationale/teller call/If-it-hits/cost), thesis + board-watch triggers, multi-race section, subtotals, footer (totals, sources, scratches, failure-mode warnings, the responsible-gambling line). Every race block is a collapsible `<details>`, open by default. An `embedded` prop drops the pagehead so the sheet can be mounted inside a view with its own header - the SAME component, so money/subtotal/grade-join logic can't drift into a second copy. **D165**: each race also renders the shared read-only `RaceNotes.jsx` panel, fetched via `card.race_day_id` against the same `GET /api/race-days/:id/llm-notes` `/day` uses. |
| `client/src/components/RaceNotes.jsx` | D164/D165: the shared read-only "Analyst Notes" collapsible, `RaceNotes({ note })` - one race's `{text, sourceLabel, updatedAt}` or none. No fetch of its own, no editing surface (that's `RaceDayNotesModal.jsx`/`AnalystNotesEditor.jsx`); used by both `RaceDayView.jsx` (`/day`) and `CardView.jsx` (`/card`) so the two pages can't render this panel two different ways. |
| `client/src/api.js` | client half of the ingest API; carries the session's correlation id on every call. `MODEL_LABEL`/`modelLabel()` and `BLINDNESS_LABEL`/`blindnessLabel()` live here so every view labels a model/blindness state consistently without a network round trip. `bulkDeleteRaceDays(ids)` posts to `/api/race-days/bulk-delete`. |
| `client/src/App.jsx` | root component, theme application, browser view routing (list/new/pl/simulate/day/card) via the History API. |
| `client/src/routes.js` | pure browser route parsing and formatting; UI paths stay separate from `/api` paths. |
| `client/src/components/NewRaceDay.jsx` | the ingest screen: track/date/bankroll form, two ways to bring in ONE Equibase entries page (upload the saved file, or paste its HTML) - both running the identical parser, warnings-first READ-ONLY preview, save with replace-on-conflict. "Upload" reads the file IN THE BROWSER and posts its markup as text, so the server never opens a file; the file's `lastModified` travels as `oddsCapturedAt`. A paste carries no file, so that field is simply absent. |
| `client/src/components/RaceDayList.jsx` | home: stored race days table, Show deleted toggle + restore, and the Danger zone (factory reset behind an explicit confirm). **The list effect guards against a stale/superseded response landing last** - see Gotchas. A checkbox column (active-days view) plus "Delete selected (N)" behind a two-step inline-confirm - "select all" only ever reaches ungraded rows in the currently FILTERED set; a graded row's checkbox is disabled (a convenience, the bulk-delete route refuses server-side regardless). A **Graded** column shown in both active and deleted views. |
| `server/reset.js` | factory reset shared by `POST /api/reset` (requires `{confirm:"RESET"}`) and the CLI: wipes every table, VACUUMs, restarts the race-day id sequence, removes every log file, logs `app_reset` as the new era's first event. **`WIPE_ORDER`'s ORDER is load-bearing** - several FKs are `ON DELETE NO ACTION`, so referencing rows must go first. **Its COMPLETENESS is no longer trusted** - a table the list has never heard of is deleted FIRST, and the wipe ASSERTS every table is empty before committing, rolling back and throwing rather than reporting a clean slate that is not one. `strategy_templates` is the ONE table non-empty afterwards, correctly. |
| `scripts/reset.js` | CLI factory reset; refuses without `--yes`. |
| `client/src/components/RaceDayView.jsx` | read-only view of a stored day - what landed in the DB, not what the parser proposed. A day-level staleness banner plus a per-race tag (`past post`/`entries Nm old`), ONE `now` for the whole render so banner and tags agree. A day with no `odds_captured_at` renders no banner. Holds a `cardsVersion` counter passed as `CardsPanel`'s `key` (remount = reload), bumped by `EquibaseOtrPanel`'s `onSaved` callback. **"Enter Analyst Notes" (D159)** opens `RaceDayNotesModal.jsx`, reachable the moment entries are in, before any card exists. **D164**: each race's `<details>` also carries a nested, collapsed-by-default read-only "Analyst Notes" panel (`notesByRace`, fetched via the same `GET /api/race-days/:id/llm-notes` the modal uses) - no editing here, and closing the modal refetches so an edit shows up without a page reload. |
| `client/src/prefs.js` | per-user UI preferences in `localStorage` (theme). Never card data - the ONE store that holds any is `client/src/drafts.js`, deliberately separate. |
| `client/src/drafts.js` | unlocked ticket drafts for the day-level builder, in `localStorage` keyed `betsheet:ticket-draft:v1:<dayId>:<race>` - a scratchpad for one browser, not a record the corpus carries. A draft is still TEXT that goes through preview -> lock -> the server's own re-parse (invariant 9) before a ticket exists. Every read/write is wrapped; an unreadable entry is dropped, never surfaced. Blank text clears a draft; it otherwise dies only on lock, PASS or an explicit Discard. |
| `client/src/styles.css` | all styles: Radix Mauve imports, semantic tokens, light/dark themes, desktop-first layout. |

| `shared/static-payload.js` | the static-payload shape (D150), PURE and browser-safe: `canonicalJson` (deterministic, key-sorted), `hashedRegion`/`canonicalPayloadText` and `validateStaticPayload`. **`payloadHash` covers the race day and NOTHING else** - `generatedAt` and `referenceCards` are excluded, so a payload rebuilt months later from an unchanged race day hashes identically and `scripts/import-static-cards.js` can verify it. Entries are carried in snake_case because `shared/parsers/human-picks.js` reads those rows directly. |
| `scripts/build-static-payload.js` + `scripts/check-static-payload.js` | `npm run build-static-payload -- <raceDayId> [--out <path>] [--reference-cards]`: one race day as a self-contained JSON file, default `static/public/payload.json` (the file the Pages deploy publishes, so building a payload and deploying a race day are one act). READ-ONLY - never writes to the database, never appears in a trace. No Equibase HTML, no parser input: parsing happens here, the browser gets structured data. A soft-deleted day is refused (invariant 12). |
| `static/` + `vite.static.config.js` | the at-the-track builder (D151): a SECOND Vite entry with no corpus, no grading, no generation and no database. `mobile.js` owns `MOBILE_MAX_WIDTH`/`useIsMobile` for the layout decisions CSS cannot make (`<details open>` is DOM state, not presentation) - the breakpoint is duplicated in `static.css` and `check-static-app` asserts the two agree. `app.jsx` (hash-routed shell, storage gate, `unexported: N` counter), `DayView`/`RaceView`/`CardsView`/`ReferenceCards`, `storage.js` (IndexedDB; every mutation writes; refuses to start when storage cannot keep a card; reports a refused `persist()` honestly), `card.js` (the browser's parse, through the REAL shared parser + estimator), `exchange.js` (downloads + the rolling backup). **It REUSES `TicketBuilder.jsx`/`EntriesTable.jsx` from `client/`, never a fork.** **Exclusion of LLM/OTR generation is structural** - no import path reaches it - and is asserted against the BUILT bundle, not by reading the import graph. `RaceView`'s committed-text snapshot is adjusted during RENDER, never in an effect; see Gotchas. |
| `shared/static-export.js` | the export document a phone hands home (D152) and its validation, shared by the browser writer and the home reader so they cannot drift. schemaVersion 3 and the card-trace-export vocabulary, but its OWN schema name: `trace`/`traceStatus`, `gradeSummary`/`results` cannot honestly exist on a device with no log files and no chart, and `cardId` is a device-namespaced STRING, not the integer row id. `llmInputs` is always `null`, never `[]`. |
| `static/public/sw.js` | the offline shell (D155). **`payload.json` and navigations are NETWORK FIRST; only content-hashed assets are cache-first** - a payload one day old is not a stale page, it is the wrong races. Reads the hashed bundle names out of `index.html` at install so ONE online visit is enough, and every cache lookup passes `ignoreVary` (see Gotchas). |
| `scripts/import-static-cards.js` + `scripts/check-static-import.js` | `npm run import-static-cards -- <path> [--yes]` (dry run by default): one export file or a directory of them, into the corpus. **Idempotency is load-bearing** - keyed on `cards.external_id` (migration 027), a re-import reports `already present` and writes nothing, which is what makes D152's rolling backup free and manual file transfer safe. Imported cards merge into the ordinary HUMAN bucket; `built_on` is fact, never a bucket. Re-parses the ticket TEXT through `persistHumanRace` (invariant 9 is not waived by the file) and re-stamps the DEVICE's lock times onto `human_race_state` (invariant 15 reads them; the import clock would be a lie). Seeds `strategy_templates` itself - it never boots the server. |
| `.github/workflows/deploy-pages.yml` | the Pages deploy (D154, fixed in D156), the repo's only workflow. Refuses to deploy without a valid `static/public/payload.json`, gates on `check-static-app`, and sets `BETSHEET_STATIC_BASE=/betsheet/`. **Pinned to node 24 and guarded against drift** - `better-sqlite3` requires >=22 and npm only WARNS on a mismatch, so a wrong runtime is a segfault, not an install error (see Gotchas). The `build` job asks GitHub nothing about Pages, so it goes green today; only `deploy` needs Pages enabled (Pro/Team on a private repo). |

Planned homes (each arrives with its PR — keep this table honest as they
land): the Equibase entries HTML ingest route and its UI, which wire up the
already-built `shared/parsers/equibase-entries.js` (D104) and then replace the
pasted-entries path that is currently the only way to create a race day.

---

## Commands

```bash
npm start              # build + serve on 127.0.0.1:8788
npm run dev            # vite :5175 + api :8788 (api restarts via scripts/dev-watch.js)
npm run dev:clean [-- --yes]  # find (and stop) stale dev stacks holding :8788 / :5175
npm run dev:restart    # D97: dev:clean --yes then dev, in one command - the two-step is why a stale stack stayed in the way
npm run dev:preview    # D97: the AGENT's dev stack, api :8795 / vite :5185, never the human's ports (.claude/launch.json runs this)
npm run gh -- pr 133 | pr list | pr create --title T --body-file f | pr merge N | checks [ref] | raw GET <path>  # D101: GitHub API via the git credential
npm run install-hooks  # D101: point core.hooksPath at the tracked hooks (pre-push refuses a direct push to main)
npm run check-logging  # logging: rotation, sweep, retention, torn lines
npm run check-schema   # schema: constraints, cascades, migrations, tamper guard
npm run check-staleness # D117: entries freshness - the exact part (capture age) and the parts it refuses to guess (has a race run, without the track's timezone)
npm run check-track-codes # D123: the track registry's silent-failure properties - no shared codes, no ambiguous spellings, no alias the lookup can never match; every display and alias round-trips
npm run check-graded-card-fixtures # D108 + D120 (P-6.1): the 9 fixtures are present and self-consistent, AND the real grader re-run over them reproduces every archived summary to the cent and all 386 per-ticket outcomes - with a negative control proving the check can fail
npm run check-equibase-entries # D104: Equibase entries HTML parser vs. the real Del Mar page (golden + hand counts; the 12-column claiming-race regression)
npm run check-zip-read # D127: the zip reader's refusals - bombs stopped during inflation, encrypted/zip64/truncated/bad-CRC named, and no filesystem access at all
npm run check-entries-zip # D127: the bulk path end to end on a temp DB - preview writes nothing, policy A skips a bad file without losing the good ones, replace only when asked
npm run batch-equibase -- <dir> [--write-report f.json]  # D121: every saved Equibase page in a folder through the real parser AND the real writer, into a throwaway DB that is deleted on exit
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
npm run check-static-app      # D151+D154+D155: payload rows and DB rows parse IDENTICALLY, the built bundle ships no LLM/OTR/grading/API code (with a positive control), the Pages base, the service-worker strategies
npm run import-static-cards -- <path> [--yes]  # D153: import phone-built cards (dry run by default; a directory of rolling backups is one safe import)
npm run check-static-import   # D153: migration 027, the same file imported three times producing ONE card, all four refusals, invariant 15's lock times
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
2. `CLAUDE.md` reflects any changed invariant, architecture entry, command
   or feature status.
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
and has a hard size limit. It has been trimmed three times, each time because
cells had grown into second copies of their ledger entries: on 2026-09-04 at
165k (feature rows), on 2026-09-06 at 168k (architecture cells, plus collapsing
the feature rows for what the pivot deleted), and on 2026-09-07 at 193k
(both sections again, after six weeks of D136-D149 work regrew them). Detail
belongs in DELIVERABLES.md, which has no such limit. The same rule governs the
architecture map: a cell says what a file OWNS and the invariants a reader must
not break, not the history of how it got that way.

**All three trims are reversible.** The rows as they read before each are
preserved verbatim in `docs/feature-notes.md` (2026-09-04),
`docs/claude-md-pre-trim-2026-09-06.md` (2026-09-06) and
`docs/claude-md-pre-trim-2026-09-07.md` (2026-09-07) - frozen snapshots, never
updated, for the rare case where a compressed cell dropped a detail its ledger
row words differently.

| feature | state | notes |
| --- | --- | --- |
| /card page: the same read-only Analyst Notes panel D164 put on /day (D165) | merged | PR [#203](https://github.com/KevinRaffay/betsheet/pull/203), branch `card-view-notes-panel` - user request to carry D164 onto the card sheet too. `CardView.jsx` now fetches the day's notes via `card.race_day_id` (already on the `GET /api/cards/:id` response) and renders one panel per race, right after Entries. D164's inline per-race markup was extracted into a shared `RaceNotes.jsx` (`RaceNotes({ note })`) used by both `RaceDayView.jsx` and `CardView.jsx`, rather than let a second hand-rolled copy exist - the same discipline as `EntriesTable.jsx`/`AnalystNotesEditor.jsx`. No schema/API/write-path change. Verification: presentation-only, `npm run build` green, browser-verified on a real LLM-generated card with a populated race note. Full record: DELIVERABLES.md D165. |
| /day page: read-only Analyst Notes panel on each race card (D164) | merged | PR [#202](https://github.com/KevinRaffay/betsheet/pull/202), branch `race-day-notes-readonly` - user request: the notes entered via D159's "Enter Analyst Notes" (or the LLM generator's own notes fields, same `llm_notes` draft) were writable in two places but not visible anywhere read-only. Each race's `<details>` in `RaceDayView.jsx` gained a nested, collapsed-by-default `Analyst Notes` panel reading the same `GET /api/race-days/:id/llm-notes`; no editing surface, no schema/API change. Closing the notes modal refetches so an edit is reflected without a page reload. Presentation-only: `npm run build` green, browser-verified on a real day with a populated race note and one with none. Full record: DELIVERABLES.md D164. |
| The per-race LLM bankroll was a number no legal wager could add up to (D163) | merged | PR [#201](https://github.com/KevinRaffay/betsheet/pull/201), branch `llm-per-race-bankroll-whole-dollars` - four races blocked on the post-D162 prompt, and **in every one the illegal stake was exactly the leftover**: $172.00/12 = $14.33, $85.50/6 = $14.25, $57.50/4 = $14.375, against a cheapest wager step of 50c and usually $1. The model was handed a target no combination of legal wagers can hit, and "must not exceed" reads as a target as easily as a ceiling, so it plugged the remainder illegally. **The first fix in this series to change server code**: the new exported `perRaceBankrollCents` in `server/llm-cards.js` floors the share to a whole dollar (FLOOR, not round - shares must never sum above the bankroll, and `Math.round` genuinely overspent on $57.50/4). Prompt half states the bankroll is a ceiling, forbids deriving a stake by subtracting spend, and requires dropping a ticket no legal price fits. Also fixes D162 backfiring - told the arithmetic must equal the stake, one response invented a $0.177 per-combo instead of changing the stake; the prompt now says the stake gives way, never the per-combo figure. No schema change, no `ENGINE_VERSION` bump (an LLM card has no version axis) - an un-versioned comparability boundary, the first that moves a generation INPUT rather than prompt text. Full record: DELIVERABLES.md D163. |
| LLM prompt fix: the box arithmetic D161 requires must equal the `<stake>` column it prices (D162) | merged | PR [#200](https://github.com/KevinRaffay/betsheet/pull/200), branch `llm-prompt-stake-matches-arithmetic` - live bug report the same evening D161 merged. **D161 worked and the ticket still failed**: the model wrote every factor out, reached the correct 24 combos and the correct $12.00, said in prose that $6 was invalid - and left `<stake>` reading $6, because `<stake>` is emitted BEFORE `<rationale>`, so showing the work happens after the number is committed. The arithmetic is now stated to BE the price: its `= $<total>` must equal `<stake>`, and a disagreement is fixed by rewriting the line, never by narrating it. Also fixes a latent spurious-warning bug in D161's own wording (`$<base>` -> `$<per-combo>`, which is what `STAKE_CHECK_RE` actually compares). Prompt text only. Full record: DELIVERABLES.md D162. |
| LLM prompt fix: box bets must show combo arithmetic in the rationale, after D160 alone didn't stop a recurrence (D161) | merged | PR [#199](https://github.com/KevinRaffay/betsheet/pull/199), branch `llm-prompt-box-arithmetic-shown` - one race after D160 merged, the SAME 4-horse trifecta box miscount recurred on a request confirmed (by `prompt_template_version`) to have read the post-D160 prompt - a worked example alone wasn't enough. Escalates to requiring the model to show its combo arithmetic as output tokens ("show your work"), which also activates the existing D84 teller-grammar cross-check for free since the LLM's `<rationale>` column is what that check scans. Prompt text only. Full record: DELIVERABLES.md D161. |
| LLM prompt fix: trifecta box combo count used the exacta-box formula, one factor short (D160) | merged | PR [#198](https://github.com/KevinRaffay/betsheet/pull/198), branch `llm-prompt-trifecta-box-combo` - live bug report: a real generation boxed 4 horses in a trifecta box four times and priced each as 12 combinations (exacta's formula) instead of the correct 24, plus once wrote a box selection under the bare (non-box) bet type name. Prompt text only, no parser/schema change. Full record: DELIVERABLES.md D160. |
| Race day notes entry: "Enter Analyst Notes" reachable before any card exists (D159) | merged | branch `race-day-notes-entry` - user-supplied scope doc's premise was stale (it described a card-scoped notes table needing migration to race-scoped; D92 already made `llm_notes` race-scoped). Built only the missing piece: a new `RaceDayNotesModal.jsx` on `RaceDayView.jsx` writing through the SAME `llm_notes` draft `LlmCardModal.jsx` reads/writes - no migration, no new endpoint. Shared editor UI extracted to `AnalystNotesEditor.jsx`. Full record: DELIVERABLES.md D159. |
| The at-track race screen fits a phone: no rank column, entries collapsed, no eligibility boilerplate (D158) | merged | branch `mobile-entries-trim` - all three were pushing the ticket builder below the fold. `EntriesTable` gained `showRank` (default TRUE, so the three desktop callers are untouched); the static payload carries no `program_rank` at all, so the column was a dash on every row. Entries collapse via a new `static/src/mobile.js` `useIsMobile`, since `<details open>` is DOM state CSS cannot close. Conditions removed from the RENDER only - the field stays in the payload, so no `payloadHash` moves. Full record: DELIVERABLES.md D158. |
| HOUSE RULE: a call to action must stay reachable without sideways scrolling on a phone (D157) | merged | branch `mobile-cta-visible` - **user rule 2026-09-07**, found on the live Pages builder. `.grid { overflow-x: auto }` stops a wide table stretching the page by pushing the RIGHTMOST column out of sight, and in every table here that column is the button. Descriptive columns now carry `col-detail` and are hidden below 720px; desktop is unchanged. Enforced by `check-static-app`, with a negative control. Full record: DELIVERABLES.md D157. |
| Fix: the Pages workflow segfaulted on its first run - node 20 vs dependencies requiring 22+ (D156) | merged | branch `fix-pages-workflow-node` - `npm ci` only WARNS on an engine mismatch, so a wrong runtime installs a native binding for the wrong ABI and `better-sqlite3` segfaults on load (exit 139, no output). Pinned to node 24, `engines.node` declared, and a guard step that refuses a bad runtime before any check runs. Also dropped `actions/configure-pages`, whose outputs this build ignores and which fails when Pages is not enabled - the `build` job is now Pages-independent and goes green today. Full record: DELIVERABLES.md D156. |
| Static Pages target: build HUMAN cards on a phone at the track, carry them home as files (D150-D155) | merged | branch `static-pages-target` - a build-only deploy of a card CONSTRUCTION surface: no corpus, no grading, no generation, no database. D150 the payload builder (hash covers the race day alone, so the home import can verify the entries have not moved). D151 the browser app, reusing `TicketBuilder`/`EntriesTable` rather than forking them, with LLM/OTR excluded structurally and proven against the built bundle. D152 export+restore as a pair, with a rolling backup that is free because D153's import dedupes. D153 the import, keyed on the new `cards.external_id` (migration 027), merging into the ordinary HUMAN bucket. D154 the Pages workflow. D155 the offline shell. **Archaeology first changed the design**: the named source the spec assumed (`emubets`/`drf`) does not exist - it is unscheduled requirement P-3.2 - and Kevin's call was to drop it from this scope. Browser and offline testing found five real bugs, all fixed and pinned. Full record per ID: DELIVERABLES.md D150-D155. |
| LLM cards: capture generation inputs (prompt, response, notes, model, template version), not just outputs (D149) | merged | PR [#191](https://github.com/KevinRaffay/betsheet/pull/191), branch `llm-input-capture` - two cards generated from different analyst-notes payloads had no way to be reproduced or diffed, and one card's grade moved through six mid-session regenerations reconstructable only by timestamp-diffing. Widened `llm_card_requests` (migration 026, reused rather than a parallel table) with correlation id, prompt/notes hashes, a hash-derived template version, and request params; added `llm_request_sent`/`llm_response_received`/`race_regenerated` trace events; export bumped to `SCHEMA_VERSION` 3 with a top-level `llmInputs` block (`null`, never `[]`, when unknown), `?omitLlmInputs=1` for a shareable redacted form. Kevin's call before merge: regeneration keeps mutating in place, even on a graded card - no new card id, no follow-up scheduled. Full record: DELIVERABLES.md D149. |
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
| Bulk entries ingest: a day's board as one zip (D127) | merged | branch `entries-zip-upload` - one upload creates every race day for a date. A bounded, dependency-free zip reader (verified byte-for-byte against Python's `zipfile`) refuses what it can't fully support and bounds decompression bombs during inflation. Full record: DELIVERABLES.md D127. |
| Race days list: date and track filters (D128) | merged | PR [#168](https://github.com/KevinRaffay/betsheet/pull/168), branch `race-day-filters` - two client-side `<select>`s, no new endpoint. Full record: DELIVERABLES.md D128. |
| Ticket builder: "Type it instead" raw-text escape hatch removed (D129) | merged | branch `remove-type-it-instead` - every race now composes through `TicketBuilder.jsx` alone. Full record: DELIVERABLES.md D129. |
| Horse names ignore a parenthetical suffix in comparisons and the LLM prompt (D125) | merged | branch `strip-horse-name-suffix` - consolidated five near-identical `nameKey` copies into one exported implementation in `shared/parsers/human-picks.js`; storage and every UI view keep the full name. Full record: DELIVERABLES.md D125. |
| Every surface the entries page prints (D124) | merged | branch `surface-variants` - surface was null on 637 of 803 imported races because the parser only recognized one of four printed parentheticals. `Dirt` is still never inferred from silence. Full record: DELIVERABLES.md D124. |
| The track registry filled out: 2 tracks to 39 (D123) | merged | branch `track-registry` - codes are Equibase's own ids rather than a colliding first-three-letters fallback. Found and fixed a fourth parser defect (`&` excluded from the header's character class) on the way. Full record: DELIVERABLES.md D123. |
| The entries parser proved across 91 tracks - and the three defects that found (D122) | merged | branch `equibase-multitrack-fixes` - imported 63 of 91 real pages on the first run; fixed a scratch-collision bug, a lead-time-dependent reduced table, and a track that spells itself two ways, to reach 91 of 91 with zero crashes. Full record: DELIVERABLES.md D122. |
| Batch regression harness for the entries parser, and the wrong page diagnosed (D121) | merged | branch `equibase-batch-regression` - the 93 test files turned out to be Equibase's race-card INDEX page, not the entries page; now its own named warning instead of a generic one. Full record: DELIVERABLES.md D121. |
| P-6.1: the grader still reproduces every archived summary (D120) | merged | branch `grader-regression` - the real grader re-run over all 9 frozen fixtures reproduces every summary and all 386 per-ticket outcomes exactly, with a negative control proving the check can fail. Full record: DELIVERABLES.md D120. |
| Factory reset: wipe every table, and say so (D119) | merged | branch `reset-wipe-completeness` - `WIPE_ORDER` had gone stale across three migrations, silently destroying 169 unaudited rows. Now a table the list has never heard of is swept first, and the wipe asserts completeness before committing. Full record: DELIVERABLES.md D119. |
| The legacy corpus soft-deleted, and the empty states that exposed (D118) | merged | branch `empty-state-honesty` - hiding the corpus (user decision, in place of a factory reset) surfaced three empty states still describing features the pivot had deleted, plus a latent stale-response race in the deleted-days list. Full record: DELIVERABLES.md D118. |
| P-2.4: entries staleness indicator (D117) | merged | branch `entries-staleness` - deliberate about what it refuses to claim: capture age is exact, "has this race run" needs a timezone nothing stores. Full record: DELIVERABLES.md D117. |
| P-2.1/P-2.3: the Equibase entries ingest, wired (D116) | merged | branch `equibase-entries-ingest` - a race day can now be created from a saved Equibase entries page. Wiring surfaced two real parser defects (a navigation-strip `conditions` bug, an unread `wagerMenu`). Full record: DELIVERABLES.md D116. |
| P-2.2: schema for the Equibase entries ingest (D115) | merged | branch `equibase-entries-schema` - migration 024, the riskiest rebuild in this schema (ten cascading children), verified against a copy of the real corpus. Full record: DELIVERABLES.md D115. |
| P-1.1 through P-1.6: the pivot's removals - SFTB/ATR (D110), the lean engine/simulator/templates (D111), consensus/D09 classification (D112), Del Mar program/ML ingestion/dmtc crawler (D113), and the docs purge (D114) | merged | the engine was removed FIRST (it is the consumer of program analysis and consensus, so removing it first is what made the other removals small); everything that depended on it was kept working rather than weakened. Full record: DELIVERABLES.md D109-D114. |
| Day builder: closing locks previewed races; locked tickets are delete-only (D103) | merged | PR [#138](https://github.com/KevinRaffay/betsheet/pull/138), branch `close-locks-previews` (carries D102) - delete-not-edit is the blindness rule (invariant 15), not squeamishness. Full record: DELIVERABLES.md D103. |
| Day builder: unlocked races are kept as drafts (D102) | merged | PR [#138](https://github.com/KevinRaffay/betsheet/pull/138), branch `builder-drafts` - drafts persist per (day, race) in `localStorage`, restored on reopen. Full record: DELIVERABLES.md D102. |
| Card sheet: each race collapsible (D100) | merged | PR [#136](https://github.com/KevinRaffay/betsheet/pull/136), branch `card-race-collapsible` - presentation-only `<details>` per race. Full record: DELIVERABLES.md D100. |
| Retroactive "If it hits" estimates on pre-D91 tickets (D96) | in review | branch `backfill-payout-estimates` - fills the gap D95 shipped with, using the same shared estimator the three writers call. Full record: DELIVERABLES.md D96. |
| Replay day landing: the final card, once the day is closed (D95) | merged | PR [#129](https://github.com/KevinRaffay/betsheet/pull/129), branch `replay-final-card` - renders `CardView` embedded once `summary.closed`. Full record: DELIVERABLES.md D95. |
| GitHub API from local credentials + a local guard on main (D101) | in review | branch `github-api-access` - `npm run gh` reaches the API through the Git Credential Manager token that already authenticates pushes; `npm run install-hooks` refuses direct pushes to `main`. Full record: DELIVERABLES.md D101. |
| Fix: grade sets stamped with the wrong engine version (D99) | merged | PR [#134](https://github.com/KevinRaffay/betsheet/pull/134), branch `fix-grade-set-version` - `gradeAndPersist` defaulted to `ENGINE_VERSION`, stamping `lean-1.1` onto non-engine cards. Full record: DELIVERABLES.md D99. |
| Build a card by hand from the /day view (D98) | merged | PR [#132](https://github.com/KevinRaffay/betsheet/pull/132), branch `day-ticket-builder` - the ticket builder was reachable only through Replay. Found and pinned D99 on the way. Full record: DELIVERABLES.md D98. |
| Dev harness: the agent's preview stack stops taking the human's ports (D97) | merged | PR [#130](https://github.com/KevinRaffay/betsheet/pull/130), branch `dev-preview-ports` - the session's own browser-verification server was taking the human's ports; moved to api 8795/vite 5185. Full record: DELIVERABLES.md D97. |
| Day-level ticket builder modal (D87) | merged | PR [#121](https://github.com/KevinRaffay/betsheet/pull/121), branch `day-builder-modal` - build several races in one modal then lock them together. Full record: DELIVERABLES.md D87. |
| Ticket builder, inline in the Replay race view (D86) | merged | PR [#120](https://github.com/KevinRaffay/betsheet/pull/120), branch `ticket-builder` - click horses into finishing-position strips; browser verification caught chart scratches invisible to the client. Full record: DELIVERABLES.md D86. |
| Stored teller calls reformatted into the D84 grammar (D85) | merged | PR [#119](https://github.com/KevinRaffay/betsheet/pull/119), branch `reformat-teller-calls` - 2321 tickets across 74 days re-derived. Full record: DELIVERABLES.md D85. |
| Teller-call grammar: parse it, emit it (D84) | merged | PR [#117](https://github.com/KevinRaffay/betsheet/pull/117), branch `teller-grammar` - one code path emitting `$10 W 5`/`$2 EX BOX 2-4-5`, parsed back as an exact inverse. Full record: DELIVERABLES.md D84. |
| Scratch environment: betsheet-alt is a separate clone (D83) | in review | PR [#118](https://github.com/KevinRaffay/betsheet/pull/118), branch `alt-environment-docs` - a factory reset touches only two env-configured paths, so a separate clone is the only isolation that can't be forgotten. Full record: DELIVERABLES.md D83. |
| Card sheet: per-race results panel (D81) | merged | PR [#113](https://github.com/KevinRaffay/betsheet/pull/113), branch `card-race-results` - a collapsible Results panel below each race's Entries panel. Full record: DELIVERABLES.md D81. |
| Dev harness: stale dev stacks silently steal the ports (D80) | merged | PR [#112](https://github.com/KevinRaffay/betsheet/pull/112), branch `dev-port-preflight` - two `npm run dev` stacks were up an hour apart, diagnosed from the live process tree. Full record: DELIVERABLES.md D80. |
| Dev harness: betsheet-alt's Equibase OTR archive isolated from main's (D78) | merged | PR [#109](https://github.com/KevinRaffay/betsheet/pull/109), branch `gitignore-alt-otr-archive` - `BETSHEET_OTR_ARCHIVE_DIR` was simply unset for the alt instance. Full record: DELIVERABLES.md D78. |
| Dev harness: phantom API restarts kill in-flight requests (D77-A) | merged | PR [#107](https://github.com/KevinRaffay/betsheet/pull/107), branch `fix-dev-watch-phantom-restarts` - `node --watch` restarts on Windows metadata-only filesystem events; replaced with a content-hash watcher (`scripts/dev-watch.js`). Full record: DELIVERABLES.md D77-A. |
| LLM cards: identify + display the generating model everywhere, compare by model in P/L (D76) | merged | PR [#106](https://github.com/KevinRaffay/betsheet/pull/106), branch `llm-model-identity`. Full record: DELIVERABLES.md D76. |
| LLM cards: "Start a New Card" + model picker (D75) | merged | PR [#104](https://github.com/KevinRaffay/betsheet/pull/104), branch `llm-model-picker` - the API already supported starting a fresh card, the modal never exposed the path. Full record: DELIVERABLES.md D75. |
| Equibase OTR cards: fix "If it hits" showing "—" for every ticket (D73) | merged | PR [#98](https://github.com/KevinRaffay/betsheet/pull/98), branch `fix-otr-card-est-payout` - an OTR ticket is Equibase's suggestion, not the user's own pick, so it needed the LLM/human estimate treatment, not the parser's null convention. Full record: DELIVERABLES.md D73. |
| Equibase OTR follow-up: upload panel, batch CLI, extraction fix (D72) | merged | PR [#95](https://github.com/KevinRaffay/betsheet/pull/95), branch `equibase-otr-ui` - a trivia-line guard fixed race 9 corrupting on every 10-race day, found by running the D71 method over all 16 archived files. Full record: DELIVERABLES.md D72. |
| Equibase "Off to the Races" PDF as a picker (D71) | merged | PR [#92](https://github.com/KevinRaffay/betsheet/pull/92), branch `equibase-otr` - the free at-track sheet's printed tickets, taken verbatim, become a card in the new `EQB_OTR` bucket. Full record: DELIVERABLES.md D71. |
| LLM cards: "Regenerate All Races" button in the modal (D70) | merged | PR [#90](https://github.com/KevinRaffay/betsheet/pull/90), branch `llm-regenerate-all`. Full record: DELIVERABLES.md D70. |
| LLM cards: fix "If it hits" column empty on the card sheet (D67) | merged | PR [#84](https://github.com/KevinRaffay/betsheet/pull/84), branch `fix-llm-card-est-payout` - the human-picks parser's null-estimate convention was wrong for an LLM's own picks. Full record: DELIVERABLES.md D67. |
| LLM cards: modal's saved races show a collapsible card panel per row; "Open card #N" removed (D66) | merged | PR [#83](https://github.com/KevinRaffay/betsheet/pull/83), branch `llm-card-collapsible-panels`. Full record: DELIVERABLES.md D66. |
| LLM cards: "Generate Card from LLM" as a modal; fixes the Betting cards row going stale (D65) | merged | PR [#82](https://github.com/KevinRaffay/betsheet/pull/82), branch `llm-card-modal`. Full record: DELIVERABLES.md D65. |
| LLM cards: box-bet prompt fix - total didn't divide evenly per combo (D64) | merged | PR [#81](https://github.com/KevinRaffay/betsheet/pull/81), branch `fix-llm-box-stake-prompt` - the prompt never explained box combination counts or the divisibility rule. Full record: DELIVERABLES.md D64. |
| LLM cards: manual per-race LLM picks as a third comparison point (D63) | merged | PR [#79](https://github.com/KevinRaffay/betsheet/pull/79), branch `llm-cards` - "Generate Card from LLM" alongside the engine's own button, per race, logged verbatim regardless of outcome. Full record: DELIVERABLES.md D63. |
| Hard-delete individual card (D49-QA) | merged | QA `qa` branch deliverable — confirmed `/card/:id` action and `DELETE /api/cards/:id` remove card-owned records through foreign-key cascades while preserving the race day and decision logs; validated with `npm run check-engine` and `npm run build` |
| **Retired by the 2026-09-05 pivot** (D05, D07, D08c, D09, D10, D18, D19, D25, D30, D31, D32, D33, D36, D40, D41, D43-D47, D48, D48-QA, D49, D50, D51, D53, D58, D59, D68, D69, D74, D77-B, D82) | deleted | Each of these shipped, worked, and is now GONE - the consensus fetch and D09 classification, the lean engine and its templates, the simulator, the Del Mar program and Bottom Line ingestion, the ML sheet, the dmtc crawler, the batch backfill runner and its four meet runs, SFTB, At The Races, and the OTR sheet's consensus half. **They are collapsed here rather than deleted because the stored corpus was PRODUCED under them** and cannot be read without knowing they existed: every PROGRAM_ONLY figure is a backfill figure, every `lean-*` card came from the deleted engine, and every UNANIMOUS/SPLIT/CHAOS value on a stored race is D09's. **Not one of them is a gap to fill.** Full record per ID: DELIVERABLES.md, and the pre-trim rows verbatim in docs/claude-md-pre-trim-2026-09-06.md. |
| Repo scaffold (D01) | merged | PR #1 — stack, styling system, server wiring, docs ledger |
| Logging foundation (D02) | merged | PR #2 — three JSONL streams, size+day rotation, gzip/retention sweep, correlation IDs, `/api` request log |
| SQLite schema + migrations (D03) | merged | PR #3 — full schema incl. Phase 2–4 tables, append-only migrations with tamper guard, money in cents |
| Entries parser — pasted text (D04) | merged | PR #4 — validated against a real Del Mar card (8 races, 81 entries, 0 warnings) |
| Ingest UI + API (D06) | merged | PR #6 — paste/PDF → warnings-first read-only preview → transactional save; migration 002 adds `races.wager_menu` |
| dmtc results HTML parser (D42) | merged | PR #37, branch `dmtc-results-parser` - second results source of record, cross-validated against Equibase; from-archive preview with the calendar race-count hard error; provenance vocabulary (migration 010) |
| Distribution reporting (D20) | merged | PR #51, branch `distributions` — shared/distribution.js + GET /api/distribution + Distributions view; per bucket: % losing days, max drawdown, single-ticket dependence gross and net (flag = net > 80%); one card per day per bucket; `npm run check-distribution` |
| Replay: day landing page listing every race with P/L before opening one (D62) | merged | PR [#80](https://github.com/KevinRaffay/betsheet/pull/80), branch `replay-day-landing` - clicking a day in `/replay` opens `ReplayDayLanding.jsx` (a table of every race, status, and human/lean P/L once revealed) instead of jumping straight into race 1; clicking a race row renders `ReplayRaceView` for that race in place, same `/replay/day/:id` URL, no route change. Full record: DELIVERABLES.md D62. |
| Replay: removed the DMR-2025-only default + "widen to every meet" checkbox (D61) | merged | PR #78, branch `replay-remove-meet-pool` - user request 2026-09-02. `/replay` now always shows every stored day with results; `GET /replay/days` and `GET /replay/random` (server/replay.js) dropped the `?pool=recent\|all` parameter and its `meet?.startsWith('DMR-2025')` filter entirely (not just hidden in the UI - removed server-side too, since nothing calls it anymore); `client/src/api.js`'s `getReplayDays`/`getRandomReplayDay` take no argument. Full record: DELIVERABLES.md D61. |
| Replay: the actual betting card, ticket by ticket, once the day is closed (D60) | merged | PR #77, branch `replay-show-graded-card` - user request 2026-09-02: after Finish Order, show the actual card with payouts, not just a one-line race P/L. Full record: DELIVERABLES.md D60. |
| Human ticket parser: pipe-delimited rows (D57) | merged | PR #73, branch `add-pipe-delimiter`, stacked on `fix-box-selection-separator`, merged to `main` via PR #74 — a plain browser textarea's Tab key moves focus rather than inserting a tab character, so the original tab/2+-space format was only reliably enterable by pasting from a spreadsheet, not by typing a row by hand. Full record: DELIVERABLES.md D57. |
| Human ticket parser: box selections accept '/' as well as ',' (D56) | merged | PR #72, branch `fix-box-selection-separator` - bug fix to D54, found live in Replay: `Exacta Box #1 / #6 $25` was read as ONE selection token (box types only split on ','), producing a spurious name-mismatch and a blocking "needs more horses". Box selections have no positional meaning, so '/' and ',' are now equivalent separators there; `npm run check-human-picks` grew a regression case. Full record: DELIVERABLES.md D56. |
| Replay: blind race view, lock/reveal, human-vs-lean standing (D55) | merged | PR #68, branch `replay`, stacked on `human-cards`, merged to `main` via PR #70 — shared/replay.js (`computeBlindness`, `isCardClosed`, `pickerAgreement`, pure) + server/replay.js (day picker, blind view with strict key-set discipline pre-reveal, reveal, `POST .../close`, standing grouped by blindness + classification-seen, never pooled), migration 017 (`cards.saw_classification`, one-way toggle), three new components (ReplayDayPicker/ReplayRaceView/ReplayStanding). Full record: DELIVERABLES.md D55. |
| Human cards: paste parser, preview, HUMAN bucket (D54) | merged | PR #67, branch `human-cards` - shared/parsers/human-picks.js (pure, per-warning `blocking`) + server/human-cards.js (previewHumanRace/persistHumanRace, the one writer), migration 015 (`tickets.rationale_text`/`odds_at_bet`, `race_days.replayed_at`, `human_race_state`) + 016 (rebuild: `consensus_completeness` admits HUMAN; verified against a copy of the real 70+-day DB, zero FK errors, every pre-existing row count unchanged), `template: 'human'` seeded outside shared/templates.js's TEMPLATES map (never engine-generated or simulated), invariant 13 extended, P/L gains ROI-on-bankroll beside ROI-on-wagered (a PASS-heavy card can't look better than full coverage by construction). Full record: DELIVERABLES.md D54. |
| Track name canonicalization (D35) | merged | PR #64, branch `track-canonicalization` - shared/track-codes.js (`canonicalizeTrack`, pure), migration 014 (`race_days.track_code`, backfilled), `insertRaceDay` canonicalizes at save, the one-day-per-track+date check and results-chart mismatch refusal key on `track_code`, `meetForDay` drops its ad hoc letters-only check for the shared one, parse previews warn (never block) on an unrecognized track; `npm run check-schema`, `check-ingest`, `check-consensus`, `check-sources`, `check-dmtc-fetch`, `check-backfill`, `check-ml`, `npm run build`. Full record: DELIVERABLES.md D35. |
| Findings: lean-1.1 on the PROGRAM_ONLY corpus (D52) | merged | PR #58, branch `findings-lean-1-1` (stacked on #57) — docs/findings/lean-1.1-program-only.md from runs #27-#50 (every template, both scratch modes, all meets and per meet, paired day counts); the "Findings" section above with the per-version rule; no code |
| Engine versioning (D34) | merged | PR #33, branch `engine-versioning` - `ENGINE_VERSION = lean-1.0`; migration 008; version on card rows, card header, P/L rows + version filter; trace events carry it; invariant 14 |
| Browser routes (D44-QA) | merged | History API routes for `/`, `/new`, `/pl`, `/simulate`, `/day/:id`, and `/card/:id`; production server serves the client shell for direct navigation; `npm run check-routing` — PRs #45, #48 from `qa` |
| Decision-trace export (D17) | merged | PR #25, branch `trace-export` — Phase 3 opens; per-card JSON feed (trace ⋈ grades ⋈ results), traceStatus honesty marker, CLI twin, docs/trace-schema.md |
| P/L views (D16) | merged | PR #24, branch `pl-views` — bucket panels + running card table + per-race variant-compare matrix; invariants 12/13 enforced by check-pl |
| Ticket grading engine (D15) | merged | PR #23, branch `grading` — shared/grading.js (pure) + server/grading.js; results save auto-grades every card; Result/P&L columns on the card view; validated on the real Del Mar day's printed payoffs |
| Results ingest UI (D14) | merged | PR #21, branch `results-ingest` — paste/PDF -> read-only preview -> persist; mismatched charts refused whole |
| Chart-PDF ingestion (D13) | merged | PR #20, branch `chart-pdf` — pdf-text extraction + results parse endpoints (preview-only) |
| Results-chart parser (D12) | merged | PR #19, branch `chart-parser` — Phase 2 opens; the real Equibase chart for the fixture day; program↔chart closure proven |
| Card recipes + append-only generation (D28) | merged | PR #17, branch `card-recipes` — migration 007 (cards rebuild: AUTOINCREMENT id, per-day card_number, per_race_min_cents, UNIQUE(day,variant) dropped); list shows the full recipe |
| Factory reset (D27) | merged | PR #16, branch `app-reset` — wipe all records + all logs behind explicit confirms (API token, CLI --yes, UI Danger zone); id sequence restarts; `app_reset` opens the new era's log |
| Race-day soft delete (D26) | merged | PR #15, branch `race-day-delete` — deleted_at + filter cascade (invariant 12), confirmation dialog with counts, deleted list + restore, 410 guards on mutations, deletion/restore logged to decision-trace, logs never touched |
| Desktop card view (D11) | merged | PR #14, branch `card-view` — the sheet per spec; GET /cards/:id now carries sources-used/unavailable + day scratches for the footer |

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
- **ANTHROPIC_API_KEY** (in `.env`, gitignored) is required for "Generate
  Card from LLM" (D63) - without it, preview shows a visible error
  ("ANTHROPIC_API_KEY is not set") rather than calling out; nothing
  crashes and nothing is persisted, verified live. `BETSHEET_LLM_MODEL`
  overrides the default model. `BETSHEET_LLM_TEST_MODE=1` is a
  check-script-only escape hatch (`scripts/check-llm-cards.js`) that lets
  a request body's `__stubResponse` bypass the real API call entirely -
  never set it outside a check script.
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
