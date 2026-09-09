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
| `shared/parsers/registry.js` | D188 (M-1, `docs/requirements/multi-parser-entries-ingest.md`): the registry of entries-ingest parsers, `{ id -> { label, isDefault, sourceKind, costModel, fieldsNotProvided, parse, toPayload } }` - the same "registry entry, never a call-site special case" shape `shared/track-codes.js` already uses. `equibase-html` (wrapping `equibase-entries.js`) is the sole real entry; `getParser(id)` throws naming every valid id rather than falling back to default on a typo. Each entry's own `toPayload` is its adapter from raw parse output to what `insertRaceDay` consumes - kept per-entry because a future JSON-native source may need none, while the HTML page's formatted claim-price strings do. |
| `scripts/batch-import-equibase-entries.js` | `npm run batch-equibase -- <dir> [--parser id]`: runs every saved page under a directory through a REGISTERED parser (default the registry's `isDefault` entry) and the REAL `insertRaceDay` writer into a throwaway temp-directory SQLite DB (structurally cannot touch `data/betsheet.sqlite`). Exits non-zero only on a parser crash or read-back mismatch; reports fields with no column, tracks missing from the registry, and distinct column counts seen; the report JSON and console summary both name the parser used. |
| `scripts/pull-race-day.js` | D189 (M-2, `docs/requirements/multi-parser-entries-ingest.md`): `npm run pull-race-day -- <date> --dir <dir> [--tracks CODE1,CODE2] [--parser id] [--per-track-parser CODE=id,...]` - pulls a full day's slate from a directory of ALREADY-SAVED per-track pages, never a live fetch (invariant 6; user decision 2026-09-09). Every file is parsed to learn its own track/date; a file whose date doesn't match is out of scope, not an error. Omitting `--tracks` pulls every track the directory holds for that date. One track's failure (no file found, a blocking warning, a `--per-track-parser` id whose `sourceKind` isn't `html`) never aborts the run. Writes to a throwaway temp-directory SQLite DB like `batch-import-equibase-entries.js`; appends one row per track to `data/ingest_runs.jsonl` (gitignored JSON-lines, not a table - a table would live inside the per-run throwaway DB and die with it). |
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
| `server/ingest.js` | the ingest API (**D180: a program-less scratch is stored NULL, not the literal `SCR`** - Equibase replaces the number cell with a `colspan="2"` SCR marker, so the number is genuinely absent, and migration 032 made the column nullable to say so. This DISSOLVED D122's `SCR`/`SCR-2` placeholders rather than keeping them: SQLite's UNIQUE permits any number of NULLs, so two scratches in one race need no suffix, no counter, and no dependence on parse order.): `POST /api/parse/equibase-entries` (the Equibase HTML preview, one endpoint serving both a saved-file read and a pasted-markup read), the three results previews, and race-day persistence - `POST /api/race-days` (validated, transactional, 409-on-duplicate with explicit replace), `GET /api/race-days[/:id]` (each row carries `graded`, an `EXISTS(race_results)` check), `DELETE /race-days/:id` (soft, logged), `POST .../restore`, `POST /race-days/bulk-delete` (`{ids:[...]}`, each id handled independently - not-found/already-deleted/graded are skipped with a reason, the grading refusal enforced server-side and unconditionally, scoped to bulk-delete only). Both delete routes share `softDeleteRaceDay(db, day)`. `ENTRIES_SOURCES` here is the SECOND gate on `entries_source` - a value missing from this array is silently coerced to `program` rather than refused. |
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
| `server/pl.js` | P/L reporting: `GET /api/pl` - per-completeness-bucket totals for ONE engine version (default the latest graded card's version, `all` pools on request), every graded card as a row, ungraded listed separately, deliberately NO pooled all-bucket total (invariant 13). `GET /api/race-days/:id/pl` - per-race x per-card breakdown. **The TIPSHEET bucket total counts ONE variant per (day, source)**: the three are mutually exclusive alternatives, only one of which is ever real money, and summing them reported ~$598 wagered on a $200 bankroll. The counted variant is FIXED (`TIP_HEADLINE_VARIANT`) because picking the best performer per day would be cherry-picking; the others ride along as `byVariant`, a breakdown never added to the total. The LLM_GENERATED entry also carries `byModel` and `byNotes` - breakdowns, never second pools. |
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
| `server/cards.js` | card API, READ side: `GET /api/race-days/:id/cards` (also `locked_races`/`revealed_races`/`graded` per card via correlated subqueries, plus **D175 `pl_cents`/`returned_cents` from `graded_tickets_latest` - the same view `/api/pl` reports from, so the day view and the P/L screen cannot disagree; NULL when ungraded, never 0**), `GET /api/cards/:id` (races, entries, Bottom Line, nested `results`), `DELETE /api/cards/:id` (confirmed hard-delete, cascading). Card ids are AUTOINCREMENT, never reused. No longer owns generation - the three surviving producers (`equibase-otr.js`, `llm-cards.js`, `human-cards.js`) each write their own rows. |
| `shared/parsers/human-picks.js` | human ticket parser, PURE: pasted text for ONE race -> a ticket shape. Never throws; each warning carries its own `blocking` boolean. **MUST STAY BROWSER-SAFE** - `TicketBuilder.jsx` imports it - no `node:` import, ever. TWO grammars (teller: a line leading with money; columns: `bet type | selections | stake`, which `server/llm-cards.js` also parses a model's response with), converging on one `buildTickets` tail. Always emits `estMin/Max/IsRange` null - the SERVER fills them. `nameKey`/`stripParens` are the ONE horse-name normalizer in the codebase, stripping a bred-country/state suffix before comparing. |
| `server/human-cards.js` | human cards API. `previewHumanRace` never writes; `persistHumanRace` is the ONE writer and re-parses `text` itself on save, refusing 422 on any blocking warning. `POST .../human-cards/preview` and `POST .../human-cards` (`{race, text, pass?, bankrollCents?, cardId?, name?}`) - an omitted `cardId` always starts a NEW card; `name` is frozen at creation, ignored on later calls. A locked race writes one `allocations` row and sets `race_days.replayed_at` on the day's first-ever lock. Grades immediately when the day has results, under `engine_version: 'human'`. `deleteHumanTicket` (delete, never edit - editing would re-stamp `picks_locked_at` and flip blindness) refuses on a REVEALED race or a card with ANY grade set. `loadRace`/`scratchedProgramNumbersFor` are exported for `server/llm-cards.js` to reuse. |
| `scripts/check-human-picks.js` | verification: a PURE teller-grammar phase before the server boots, including an executable inverse proof that every ticket re-parses from its own `tellerCall` to an identical ticket; then the full server round trip - every warning type, save-side blocking independent of preview, PASS, the append-only-on-conflict remedy, bucket isolation. |
| `docs/prompts/llm-card-v1.md` | LLM cards: the base-text origin, the v1 deviations (no search tool, per-race not per-day, structured ticket-block output reusing `shared/parsers/human-picks.js`), and the exact per-race system/user prompt template `server/llm-prompt.js` implements. Keep the doc and the code in sync when the template changes. This is the template `PROMPT_TEMPLATE_ID = 'llm-card-v1'` names; the recorded version is a hash of `SYSTEM_PROMPT`, not the doc's own filename suffix. |
| `server/anthropic-client.js` | `KNOWN_MODELS` is every model ever offered (retired entries flagged, since `server/pl.js` builds its `byModel` labels from this list); `SELECTABLE_MODELS` is the non-retired subset the picker reads. Thin Anthropic Messages API client (hand-rolled, no SDK, key never ships to the browser): `complete` (AbortController timeout, a prefill retry, `model` param override, echoes back the resolved `requestParams` `{maxTokens, temperature}`), `AnthropicError`, `hasKey()`. `ANTHROPIC_API_KEY` required; `BETSHEET_LLM_MODEL` sets the server default only. `DEFAULT_REQUEST_PARAMS` is exported for a call that never reached the API. |
| `server/llm-prompt.js` | LLM card prompt, PURE. Mirrors `docs/prompts/llm-card-v1.md` - keep the doc and the code in sync. Owns the BASELINE PICKS block (the day's tip sheets as ranks, OTR as printed TICKETS in its own vocabulary since it never claims a ranked 3rd pick), LABELLED per source, both when both exist. **`BASELINE_CLAUSES` and `ANALYST_NOTES_CLAUSES` must stay CONDITIONAL**: `buildSystemPrompt({hasNotes:false}) === SYSTEM_PROMPT` is asserted, because an LLM card has NO version axis (`engine_version` is the literal `'llm'`) and an unconditional prompt change would pool silently with every prior card. **Every real prompt-content change is therefore an un-versioned, permanent comparability boundary**, checkable per card via `llm_card_requests.prompt_text`. The rest of SYSTEM_PROMPT is load-bearing rules that each fixed a live bug - do not cut them. `sanitizeNotesForPrompt` destroys marker-shaped text at the INPUT boundary. `extractTicketBlock` splits on the `<<<TICKETS>>>` markers, `null` when missing (hard failure). `PROMPT_TEMPLATE_VERSION` is a HASH of `SYSTEM_PROMPT` computed at load, not a manually bumped counter. |
| `server/llm-notes.js` | analyst notes: the mutable DRAFT store plus the composition that turns a draft into the immutable per-call snapshot. `writeNote` normalizes `source_label` on the way IN via `shared/source-labels.js`, so `llm_notes` carries the same guarantee `tip_picks` does and grouping is exact; an empty label still stores NULL, and the `user` fallback is applied at READ time. Keyed by `(race_day_id, race_number)`, **0 = the day-level note** - NOT by `card_id`, since notes belong to a RACE and the first preview of a brand-new card has no card id yet. `llm_notes` is the only mutable table in the LLM subsystem; the immutable record is the snapshot on `llm_card_requests`. `loadNotesForRace` also returns the composed/sanitized/truncated text it hashes, so a caller storing it doesn't recompute it. |
| `server/llm-cards.js` | LLM cards API. **D179 `loadBaselineForRace`**: the race's tip picks plus the OTR sheet's tickets, read from the `both` VARIANT (the only one carrying all four printed tickets) and from its NEWEST card, since OTR ingest is append-only and joining every match would render the same sheet two or three times over. `previewLlmRace` calls the model, logs the attempt to `llm_card_requests` **regardless of outcome** (invariant 11) - correlation id, system/user prompt hashes, composed notes text, prompt template id/version and resolved request params all ride on the row - and parses a well-formed response through `shared/parsers/human-picks.js`; never persists (invariant 9). Traces `llm_request_sent`/`llm_response_received` around the call. `persistLlmRace` is the ONE writer: re-loads and re-parses the STORED response server-side, refuses 422 on any blocking warning, traces `race_regenerated` whenever it replaces tickets already on a race. **Card identity is frozen at creation** (`cards.llm_model`, 409 on a mismatched save); `cards.notes_present` LATCHES instead. Per-race bankroll recomputes on every call via the exported `perRaceBankrollCents`, which FLOORS the share to a whole DOLLAR (D163) - an even division lands on figures like $14.33 that no combination of legal wagers can spend, and flooring rather than rounding also keeps the shares from summing above the bankroll. An omitted `cardId` starts a NEW card. |
| `client/src/components/EntriesTable.jsx` | the `Entries (N)` dropdown (#/Horse/Jockey/Trainer/M-L/Rank, BEST BET/SCR tags), shared by `LlmCardModal.jsx`, `DayTicketBuilderModal.jsx` and `ReplayRaceView.jsx` so one race's entries list exists in exactly one rendering path. `normalizeEntry` accepts EITHER casing an entries array arrives in. |
| `client/src/components/AnalystNotesEditor.jsx` | D159: the shared analyst-notes editing UI (`NotesEditor`, `NoteSourceDatalist`, `NOTES_MAX`, and `SOURCE_SUGGESTIONS` - **D167: re-exported from `shared/source-labels.js`, not defined here**, so the datalist offers exactly the list the server normalizes against) - presentational only, no fetch of its own. Extracted from `LlmCardModal.jsx` so `RaceDayNotesModal.jsx` renders the identical caps/vocabulary rather than a second copy that could drift. |
| `client/src/components/RaceDayNotesModal.jsx` | the **WHOLE-DAY** analyst note (race 0) and nothing else - per-race notes are typed in each race's own panel under the house rule in Gotchas. A second entry point onto the SAME `llm_notes` draft `LlmCardModal.jsx` reads/writes, reachable before any card exists. No new endpoint and no schema change: `GET/PUT /api/race-days/:id/llm-notes`, keyed by `(race_day_id, race_number)`, so a note entered here is the same row the generator shows. Flushes any pending edit on Close/Escape before calling `onClose`, matching the modal-backdrop house rule. |
| `client/src/components/LlmCardModal.jsx` | the LLM card generator, a modal over `CardsPanel.jsx`. One row per race (Generate/Regenerate -> preview -> explicit Save), each generated race in its own collapsible panel sourced from the card's SAVED tickets. An `LLM card` picker lists every LLM card on the day (newest first, "New card" included); `switchTo(id)` is the card-session boundary (drops preview/correlationId, keeps day-level notes). The model picker is **locked once a card with an `llm_model` is resumed**. A graded card gets a non-blocking silent-regrade warning before a lock. Every effect calls its loader inside a block body - see Gotchas. Its notes editor UI lives in the shared `AnalystNotesEditor.jsx` (D159). |
| `scripts/check-llm-cards.js` | verification for LLM cards: the pure prompt builder and ticket-block extractor, then a real server round trip with `BETSHEET_LLM_TEST_MODE=1` and no API key - `__stubResponse` carries a canned response through the exact preview/save path a real call would take. Covers preview -> save -> append, per-race bankroll math, a malformed response, an unknown-program-number response, model selection, `llm_model` locking, bucket isolation, analyst notes (draft/snapshot immutability, prompt-injection containment). |
| `shared/parsers/equibase-otr.js` | Equibase "Off to the Races" PDF parser, PURE: `parseEquibaseOtrTsv` takes `pdftotext -tsv` output and returns, per race, the four printed tickets as program numbers verbatim. **`-tsv` is required, not a preference** - other pdftotext modes interleave or scramble the two tiers. Words grouped by `(page, round(top))`, split into tiers by x-coordinate. A trivia-line guard prevents a `Race N:` header's trivia sentence from corrupting the following race. Box lists parsed BY their printed grammar; an unknown program number is `blocking` for that ONE ticket only. Never throws. |
| `server/equibase-otr.js` | Equibase "Off to the Races" ingest + the batch CLI's logic. `POST /race-days/:id/equibase-otr` archives the upload and returns a PREVIEW (never writes). `POST .../confirm {parseToken}` re-reads the ARCHIVED bytes, verifies the sha256, writes THREE cards in one transaction (`some-reward`/`higher-reward`/`both`, append-only, bucket `EQB_OTR`). `resolvePdftotextCommand` prefers the winget Poppler over this machine's PATH xpdf, which silently lacks `-tsv`. The day's track/date are checked against the sheet's header, refused 422 on a mismatch. `batchIngestEquibaseOtr` walks a folder under policy A, idempotent by `confirmed_sha256`. |
| `scripts/ingest-otr.js` | batch ingest CLI: `npm run ingest-otr -- [dir]`, a thin wrapper around `batchIngestEquibaseOtr` - one line per file plus a summary. |
| `client/src/components/EquibaseOtrPanel.jsx` | the Equibase OTR upload panel on `RaceDayView.jsx`: file input -> Preview (tickets per variant, warnings, totals) -> Confirm & save three cards. Shows an append-only notice when the day already has OTR cards. Takes an `onSaved` prop so the sibling `CardsPanel` refreshes without a page reload. |
| `scripts/check-equibase-otr.js` | verification: the pure parser against ALL real archived files (golden picks, zero warnings) plus synthetic edge cases, then a real server round trip - upload -> preview -> confirm -> three cards, append-only re-upload, per-ticket blocking, the track/date mismatch refusal, bucket isolation, the batch CLI run as an actual subprocess (idempotent on re-run). |
| `shared/source-labels.js` | the ONE place this codebase answers **"who said this"**. PURE and browser-safe, imported by the server AND the client - which is the point, since the notes vocabulary used to live in a `.jsx` where the server could not enforce it. Owns the single `normalizeSourceLabel` (one lowercase slug; an unknown name keeps its OWN slug rather than being refused, so it stays countable) and `isNormalizedSourceLabel`. **The two catalogues are NOT merged, deliberately**: `NOTE_SOURCE_LABELS` answers what KIND of commentary a note is, `TIP_SOURCE_LABELS` answers WHICH APP published a pick set - `trackmaster` BELONGS TO the kind `public-handicapper`, so they are two axes, not two halves of one. **The two fallbacks stay distinct too**: a blank note is the USER's (`user`), while an unreadable tip sheet is not anyone's personal opinion (`tipsheet-other`). |
| `shared/tip-picks.js` | TIPSHEET picks (D166), PURE and browser-safe: the ranked-pick shape a tip-app screenshot extracts to. `normalizeOdds` converts a tote-printed price into the fraction string `morningLineToDecimal` reads - **the hyphen is the load-bearing case** (`9-2` -> `9/2`, `EVEN` -> `1/1`), since an unconverted price looks captured and reads back null - and NEVER invents one: anything that will not round-trip comes back null. `8/1` is deliberately not reduced to `8`, because the corpus stores the explicit denominator. `validateTipPicks` never throws and carries a per-warning `blocking` boolean: **a broken RANKING blocks** (no picks, a missing/zero/duplicated rank, one horse twice) because rank is this bucket's only signal; **anything about odds never does** - a sheet with no prices is an ordinary tipsheet. Odds are OMITTED from a pick, never null-filled. The source vocabulary and normalizer moved to `shared/source-labels.js` (D167) and are re-exported here; there is exactly ONE normalizer, so `tip_picks` and `llm_notes` cannot drift in the SHAPE of a label. |
| `shared/tip-staking.js` | TIPSHEET staking (D171), PURE and browser-safe: a ranked tip sheet -> tickets, in THREE variants (win-only / across-the-board / exacta box of the top two) so backtesting picks the structure rather than a guess - the D71 shape. Emits the HOUSE ticket shape (`betType`/`legs`/`stakeCents`), NOT snake_case: `estimateTicketPayouts` switches on `t.betType`, so snake_case makes it a silent no-op (the D67/D73/D91 bug class). Backs the top LIVE pick, matching how D170 scores. **Keeps ONE rule from the user's supplied draft** - matching place money on an 8/1+ win bet - and drops the rest, because the draft sized bets from an ML-vs-LIVE-odds gap and `entries.live_odds` is populated on 0 of 13,710 rows across 0 of 169 days (D113 removed every fetcher). **`LONGSHOT_DECIMAL` is 8, not the draft's 9**: `morningLineToDecimal` returns the fractional RATIO (`winPayout`'s `stake * (ml + 1)` proves it), so 9 would have skipped 8/1 - the exact case invariant 1 names. Never throws. |
| `server/tip-staking.js` | D171: `POST /race-days/:id/tip-cards/preview` (writes nothing) and `POST .../tip-cards` (three cards, ONE transaction). **D174: ONE card per (race day, source, variant)**, not append-only - a tip sheet arrives race by race, and appending minted three near-duplicates per stake. A re-stake REUSES the card (found via `cards.tip_source_label`, migration 031) and **recomputes it whole**, which is required rather than convenient: the per-race budget is `bankroll / races-with-picks`, so a fourth race re-prices races 1-3 too. Re-staking a GRADED card discards its grades (they cascade from tickets) and it regrades - preview returns `willUpdate`/`willRegrade` so the UI warns first; warned, never blocked (D149/D140). Bucket TIPSHEET, `engine_version` 'tipsheet'. Per-race budget via D163's exported `perRaceBankrollCents` (whole-dollar floor), reused not reimplemented. Stores `selections` as `{races, legs}` - the shape `server/grading.js` reads back. |
| `shared/tip-scoring.js` | TIPSHEET scoring (D170), PURE and browser-safe: how good a tip sheet's picks were, against results. **Carries NO MONEY, deliberately** - nothing stakes a tip sheet yet, so a dollar figure would be an invention; scoring is rank-based (did the top pick win/place/show, how much of the real top three it caught). `scoreTipRace` returns NULL - never a zero - when a race cannot be scored (no picks, no result, every pick scratched), because a zero is a claim. A SCRATCHED pick is never a miss: the top LIVE pick is scored, which is what a bettor would actually have backed, and the substitution is reported. A pick the result has never heard of is SURFACED as `unknownPicks` (an extraction misread), never silently counted a loss. **Every aggregate carries its `n` and every rate is NULL at n=0** - the "no figure without its n" rule. `byTipSource` is the ONLY total: sources are never pooled (invariant 13). |
| `server/tip-scoring.js` | D170: `GET /api/tip-scoring[?source=&meet=]` and `GET /api/race-days/:id/tip-scoring`. READ-ONLY - writes nothing, grades no ticket, touches no card. Filters `deleted_at IS NULL` (invariant 12) and emits no pooled all-source total (invariant 13). Also returns the per-race rows every rate is derived from, so a figure can be checked by hand rather than trusted. |
| `server/tip-picks.js` | the TIPSHEET HTTP surface: `GET /race-days/:id/tip-picks`, `POST .../tip-picks/manual` (picks typed from the printed sheet), `PATCH /tip-picks/:id` (the correction path) and `DELETE`. Horse NAMES come from the day's own entries, never the client. **No odds are captured** - the morning line already sits on `entries`, and a tip sheet's printed price is a different number that copying the ML would invent. **A sheet with no picks DELETES that source's row**, the same clear-by-emptying shape `writeNote` uses. The correction path validates through the same `validateTipPicks` manual entry passes, writes `picks_extracted` on the FIRST edit only (so it always holds the original, never the previous edit) and stamps `edited_at`. **Invariant 9 is intact, not excepted**: a save stores what was entered, and correcting is a separate, later, recorded act. Also owns `insertTipPicks` / `tipPicksForDay`. |
| `client/src/components/TipPicksEntryModal.jsx` | manual tip-pick entry for ONE race. The grid is horse ROWS by tipsheet COLUMNS, **each cell three toggle buttons 1/2/3** - **not one tipsheet dropdown per horse**, because a horse routinely appears in several sheets at different ranks and a per-row sheet picker cannot express that at all. Clicking a lit button CLEARS that rank; clicking any other MOVES the rank off whichever horse held it in that column, so a sheet cannot rank two horses first - one `setRank` rule, and the server validates it again through the same `validateTipPicks`. The lit state is `.btn--primary` with `aria-pressed`. **Every column is submitted on save including empty ones** - an empty sheet is how a column is cleared, and omitting it would leave stale picks. Opens seeded from the race's existing rows. Modal-backdrop house rule: no click handler. |
| `client/src/components/RaceTipPicks.jsx` | ONE race's tip sheets, inside that race's own panel - the house rule that a race-specific input belongs in the Race UI (see Gotchas). Owns the picks table, the score line, the correction editor and delete, and opens the entry dialog. **Two surfaces stay separate** (invariant 9): a save stores what was entered; correcting is a separate recorded act. Several sheets can rank one race, so each source gets its own block. Takes `rows`/`scoreFor` as PROPS and fetches nothing - `RaceDayView` loads the day's rows and scores once, so twelve races cost one request. `onChanged` refetches the day. |
| `client/src/components/TipStakingPanel.jsx` | the day-level staking panel: a tip source's ranked picks -> three comparable cards. **Staking is the ONE part of the tipsheet feature that is not per-race, and it is structural**: `planTipCards` sizes every ticket from `perRaceBankrollCents(bankroll, racesWithPicks.length)`, so race 1's price depends on how many OTHER races have picks and a fourth race re-prices the first three. **The single "Stake all" button is a CONVENIENCE, NEVER A MERGE** - each source is previewed and saved through its own per-source call and keeps its own cards under its own `tip_source_label`, because pooling sources would break invariant 13. Sources save SEQUENTIALLY and each outcome is reported by name. **No total across variants or sources**: the three variants are mutually exclusive ways to bet the same picks. Takes `rows` as a prop so it cannot disagree with the race panels. **`onSaved` remounts the sibling `CardsPanel`**, which self-fetches on mount. |
| `scripts/check-module-bindings.js` | D172: no module may USE a name it only RE-EXPORTS. `export { X as Y } from '...'` creates no LOCAL binding, so a file writing `Y` in its own body has a ReferenceError - and nothing else here catches it: esbuild compiles a bare unresolved identifier as a global so `npm run build` stays green, and every other check is server-side and never renders a component. Ships with a negative control, a not-used case, and a comment-only case. **Normalizes CRLF FIRST** - this repo stores CRLF and JS `.` will not cross `
`, so `//.*$` silently failed to strip comments and every commented mention counted as a use. |
| `scripts/check-tip-picks.js` | verification for TIPSHEET picks (was `check-tip-extraction`). Throwaway DB with the logger redirected there too. Covers migration 028's shape and refusals, every odds conversion re-checked through `morningLineToDecimal`, the blocking-vs-advisory rank split, the factory reset NAMING `tip_picks`, and the manual round trip (D176): one row per sheet, **the same horse ranked differently in two sheets**, horse names taken from the DAY not the client, no odds invented, the audit columns honestly empty, a duplicated rank refused 422 by the shared validator, and an empty sheet clearing one source while leaving the others. **D177 removed its two vision phases** - a stubbed extract->persist round trip and a phase that ran real screenshots through a paid model. What they guarded survives, because it was never about the model. |
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
| `client/src/components/RaceNotes.jsx` | the READ-ONLY "Analyst Notes" collapsible, `RaceNotes({ note })`. No fetch of its own. **Used by `CardView.jsx` alone**: `/day` edits a race's note in place (`RaceNotesEditor.jsx`), while a card sheet is a record of what was decided and must not offer to change it. The two are deliberately separate components rather than one with an `editable` flag - the read-only case has no day id, no save path and no dirty state, and giving it those to serve one caller is how a record surface quietly becomes an editor. |
| `client/src/components/RaceNotesEditor.jsx` | ONE race's analyst notes, EDITED in that race's own panel - the house rule that a race-specific input belongs in the Race UI (see Gotchas). Reuses `NotesEditor` from `AnalystNotesEditor.jsx` rather than forking it, and writes the same `llm_notes` draft the LLM generator reads: same endpoint, same row, no schema change. Flushes on blur, matching every other notes surface. **An unsaved local edit always beats an arriving refetch**, and the prop is adopted during RENDER, never in an effect (see Gotchas). A failed save KEEPS the text and stays dirty so the next blur retries. `postResult` is carried down so the not-blind warning appears where a note is actually typed. Takes `note` as a prop - the day loads every race's note in ONE call. |
| `client/src/api.js` | client half of the ingest API; carries the session's correlation id on every call. `MODEL_LABEL`/`modelLabel()`, `BLINDNESS_LABEL`/`blindnessLabel()` and **`plMoney`/`plClass` (D175 - one definition of P/L format and colour, used by both `PLView` and `CardsPanel`)** live here so every view labels a model/blindness state consistently without a network round trip. `bulkDeleteRaceDays(ids)` posts to `/api/race-days/bulk-delete`. |
| `client/src/App.jsx` | root component, theme application, browser view routing (list/new/pl/simulate/day/card) via the History API. |
| `client/src/routes.js` | pure browser route parsing and formatting; UI paths stay separate from `/api` paths. |
| `client/src/components/NewRaceDay.jsx` | the ingest screen: track/date/bankroll form, two ways to bring in ONE Equibase entries page (upload the saved file, or paste its HTML) - both running the identical parser, warnings-first READ-ONLY preview, save with replace-on-conflict. "Upload" reads the file IN THE BROWSER and posts its markup as text, so the server never opens a file; the file's `lastModified` travels as `oddsCapturedAt`. A paste carries no file, so that field is simply absent. |
| `client/src/components/RaceDayList.jsx` | home: stored race days table, Show deleted toggle + restore, and the Danger zone (factory reset behind an explicit confirm). **The list effect guards against a stale/superseded response landing last** - see Gotchas. A checkbox column (active-days view) plus "Delete selected (N)" behind a two-step inline-confirm - "select all" only ever reaches ungraded rows in the currently FILTERED set; a graded row's checkbox is disabled (a convenience, the bulk-delete route refuses server-side regardless). A **Graded** column shown in both active and deleted views. |
| `server/reset.js` | factory reset shared by `POST /api/reset` (requires `{confirm:"RESET"}`) and the CLI: wipes every table, VACUUMs, restarts the race-day id sequence, removes every log file, logs `app_reset` as the new era's first event. **`WIPE_ORDER`'s ORDER is load-bearing** - several FKs are `ON DELETE NO ACTION`, so referencing rows must go first. **Its COMPLETENESS is no longer trusted** - a table the list has never heard of is deleted FIRST, and the wipe ASSERTS every table is empty before committing, rolling back and throwing rather than reporting a clean slate that is not one. `strategy_templates` is the ONE table non-empty afterwards, correctly. |
| `scripts/reset.js` | CLI factory reset; refuses without `--yes`. |
| `client/src/components/RaceDayView.jsx` | read-only view of a stored day - what landed in the DB, not what the parser proposed. A day-level staleness banner plus a per-race tag, ONE `now` for the whole render so banner and tags agree; a day with no `odds_captured_at` renders no banner. **Loads the day's tip rows, tip scores and analyst notes ONCE** and passes them down to each race's panels and to the day-level staking panel - one request for the day rather than one per race, and no second copy that could disagree. Each race's `<details>` carries its own `RaceNotesEditor` and `RaceTipPicks`, the house rule in Gotchas. **`cardsVersion` is bumped by EVERY sibling that writes a card** - the OTR upload and tip staking; a new sibling that writes cards needs the same `onSaved` wire or its cards need a page reload to appear. **Its remount keys are NAMESPACED** (`cards-N`), because two siblings keyed on bare counters collided and React duplicated them - see Gotchas. |
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
npm run batch-equibase -- <dir> [--write-report f.json] [--parser id]  # D121: every saved Equibase page in a folder through the real parser AND the real writer, into a throwaway DB that is deleted on exit. D188: --parser selects a registered parser (shared/parsers/registry.js), default equibase-html; an unknown id is a hard error
npm run pull-race-day -- <date> --dir <dir> [--tracks C1,C2] [--parser id] [--per-track-parser C=id,...] [--write-report f.json]  # D189: a full day's slate from a directory of already-saved pages, no live fetch; appends one row per track to data/ingest_runs.jsonl
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
and has a hard size limit. It has been trimmed four times, each time because
cells had grown into second copies of their ledger entries: on 2026-09-04 at
165k (feature rows), on 2026-09-06 at 168k (architecture cells, plus collapsing
the feature rows for what the pivot deleted), on 2026-09-07 at 193k
(both sections again, after six weeks of D136-D149 work regrew them), and on
2026-09-08 at 178k (the 71 settled pre-D130 feature rows collapsed into seven
ERA rows, the way the pivot row already was, plus the fattest architecture
cells stripped of deliverable history - 178k to 148k). Detail belongs in
DELIVERABLES.md, which has no such limit. The same rule governs the
architecture map: a cell says what a file OWNS and the invariants a reader must
not break, not the history of how it got that way.

**All four trims are reversible.** The rows as they read before each are
preserved verbatim in `docs/feature-notes.md` (2026-09-04),
`docs/claude-md-pre-trim-2026-09-06.md` (2026-09-06),
`docs/claude-md-pre-trim-2026-09-07.md` (2026-09-07) and
`docs/claude-md-pre-trim-2026-09-08.md` (2026-09-08) - frozen snapshots, never
updated, for the rare case where a compressed cell dropped a detail its ledger
row words differently.

| feature | state | notes |
| --- | --- | --- |
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
