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

---

## Invariants

Breaking any of these is a bug regardless of what the tests say.

1. **The place-money rule is mandatory.** Every win bet on a horse at 8-1 or
   higher automatically carries matching place money. No generated card may
   violate it. (Live longshots ran 2nd at $6.20 and $18.60 place prices with
   win-only money on them.)
2. **All allocations sum exactly to the stated bankroll.** If the user edits
   tickets past the bankroll, warn — never block.
3. **Missing consensus never blocks card generation.** Program handicapper
   analysis and morning lines alone are sufficient. Every sheet labels which
   sources were used and which were unavailable, per race.
4. **UNANIMOUS requires genuine multi-source agreement.** With fewer than 2
   external sources, confidence caps at SPLIT — one source agreeing with
   itself is not a consensus.
5. **Cut hedges, keep stacks.** Never dutch 3+ win bets in one race. Tickets
   covering different outcomes of the same thesis stay.
6. **Never scrape Equibase** (bot protection); results arrive as pasted chart
   text or downloaded chart PDFs. Respect robots.txt everywhere; back off any
   source that resists fetching and fall back to manual paste for it.
7. **Every generated card carries a complete decision trace.** Phase 3 must
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
    data only, never personal information.
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
    time, never engine-generated or simulated) from the sources that
    actually contributed. All P/L, simulation, and distribution reporting
    buckets by this level — a program-only backfill card and a
    full-consensus card never share an aggregate, and neither a HUMAN nor
    an LLM_GENERATED card ever shares one with any engine bucket or with
    each other. Structure-layer rules
    (place-money, hedge cuts, exotic construction, allocation curves) are
    benchmarkable on ANY bucket; signal-layer conclusions require the bucket
    that actually had the signal.
14. **Graded results are immutable per (card, engine_version).** The engine
    version (`ENGINE_VERSION` in shared/card-engine.js, ONE place) is
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
| `server/db.js` | SQLite via better-sqlite3: `openDb` (applies migrations, WAL, FKs on, tamper guard), `getDb` singleton. A migration headed `-- betsheet:schema-rebuild` runs outside the wrapping transaction with FKs OFF (table rebuilds; DROP TABLE on a parent with FKs ON cascades deletes) and must pass `foreign_key_check` before commit. |
| `server/migrations/` | append-only numbered SQL migrations. `001-initial.sql` is the FULL schema, Phase 2–4 tables included. `010-result-sources.sql` (D42): result_charts.source_kind becomes equibase_paste / equibase_pdf / dmtc_html (rebuild; old paste/pdf rows mapped). `009-odds-only-tier.sql` (D40): `race_days.entries_source` (program / ml_sheet / both) and cards rebuilt so consensus_completeness admits ODDS_ONLY. `008-engine-version.sql` (D34): `cards.engine_version` (default `lean-0`), graded_tickets rebuilt with `engine_version` + UNIQUE(ticket_id, engine_version), and the `graded_tickets_latest` view every reporting surface reads (the most recently graded version's set per card). Money is integer cents; program numbers are TEXT ("1A"); results key on race *number* so a chart can land without a parsed program. `011-meet-backfill-queue.sql` (D43): `race_days.meet` (derived from track + date at save, backfilled for existing Del Mar rows) and the `backfill_queue` table. `012-race-bottom-line.sql`: nullable `races.bottom_line` stores the per-race Del Mar Bottom Line paragraph when program analysis is available. `013-fetch-attempts-discovery.sql` (D53, rebuild): fetch_attempts.outcome admits `not_published` (old "no published page found" http_error rows remapped) and gains the discovery columns sitemap_url / sitemap_status / candidate_slug / entries_scanned / nearest_slug. `014-track-canonicalization.sql` (D35, ordinary ALTER - no rebuild): `race_days.track_code`, backfilled for every known Del Mar spelling ("Del Mar" / "Delmar" / "DEL MAR" / "DelMarRacing.com" -> DMR) with a derived code for anything else; `track` itself is backfilled to the canonical display too, so the existing UNIQUE(track, date) already collides on the shared text. `015-human-cards.sql` (D54, ordinary ALTER/CREATE - no rebuild): `tickets.rationale_text` (the human's pasted rationale verbatim) + `tickets.odds_at_bet` (recorded, never used for math), `race_days.replayed_at` (set on the first-ever human lock for the day), and `human_race_state` (`card_id`+`race_number` unique, `picks_locked_at`, `results_revealed_at`, `passed`) - the two timestamps a later blindness computation (D55) derives from. `016-human-completeness.sql` (D54, rebuild): `cards.consensus_completeness` admits `HUMAN`; `allocations.confidence` needs no change (verified unconstrained `TEXT`). `017-replay-classification-toggle.sql` (D55, ordinary ALTER - no rebuild): `cards.saw_classification`, a one-way per-card toggle for whether the human opted to see the engine's D09 read of a race before locking it. `018-llm-cards.sql` (D63, rebuild): `cards.consensus_completeness` admits `LLM_GENERATED`; new `llm_card_requests` (`race_day_id` NOT NULL, `card_id` nullable - the first call for a brand-new card necessarily precedes that card's existence, invariant 9 - `race_number`, `prompt_text`, `response_text`, `model`, `requested_at`, `error`), one row per LLM call, never updated after insert (mirrors `fetch_attempts`' invariant-11 "every attempt visible" rule). |
| `scripts/check-schema.js` | verification for the schema: tables, constraints, cascades, idempotence, tamper guard, whole-graph smoke insert. |
| `shared/track-codes.js` | track name canonicalization (D35), pure: `canonicalizeTrack` maps every known spelling of a track ("Del Mar" / "Delmar" / "DEL MAR" / "DelMarRacing.com") to one `{ code, display }` (DMR / "Del Mar" today - a new track is a new registry entry, never a call-site special case); an unrecognized track still gets a derived code (never a block) so it saves and compares consistently. The ONE place `insertRaceDay` (server/ingest.js), the one-day-per-track+date check, the results-chart mismatch refusal (server/results.js) and `meetForDay` (server/dmtc-crawler.js) all key on. |
| `shared/entries-parser.js` | pasted-entries parser (browser + Node): race headers, conditions, per-horse rows, scratches (SCR rows + SCRATCHED footer), also-eligibles, wager menus. Never throws; reports problems in `warnings` for the preview UI. |
| `tests/fixtures/entries/` | entries fixtures: `dmtc-2026-09-03.txt` is a REAL Del Mar card captured from dmtc.com; `synthetic-coupled.txt` covers coupled "1A" entries and tab-less stats lines. Each `.txt` pairs with an audited `.expected.json` golden. |
| `scripts/check-parsers.js` | parser verification: golden-file diffs PLUS independent hand-counted structural assertions on the real fixture, so regenerating a golden cannot bless a regression. |
| `server/dmtc-crawler.js` | the dmtc.com crawler + raw archive (D41): calendar pages -> race days (date, race count, stakes, first post, results/program links; never blind date enumeration), the three artifact URLs per day, `meetFor` (DMR-<year>-summer Jul-Sep / -fall Oct-Dec), and `crawl()` - robots first per URL, one request at a time >= 1s apart, identifying User-Agent (BETSHEET_CONTACT), ETag / If-Modified-Since on --refresh, archived files never re-fetched without --refresh, 429/5xx backoff then halt after three straight failures, every request audited (fetch-audit stream always; fetch_attempts under the day's correlation id when the day exists). Archive: `data/raw/DMR/YYYYMMDD/{program.pdf, ml.pdf, results.html, manifest.json}` + `data/raw/DMR/calendar/YYYY-MM.html` (gitignored). The results page's Equibase embed link is NEVER followed. D47: `indexRaceDays` = index source order (calendar month with race days -> the committed `data/meets/<meet>.json` table when the month is dark -> `missingIndex`), `probeMeetWindow` = the bounded, audited probe that builds a table once (window inside the meet, <= 92 days, `--source` justifies it; race days' results pages archived on the spot), one polite client shared by crawl + probe. |
| `scripts/dmtc-probe.js` | `--meet --from --to --source [--dry-run]`: builds `data/meets/<meet>.json` from the published window; commit the table with its evidence. |
| `scripts/dmtc-fetch.js` | the crawler CLI: `--from --to [--what program,ml,results,calendar] [--refresh] [--dry-run]`; dry run derives the plan from ARCHIVED calendars only and lists months still to fetch. |
| `scripts/check-dmtc-fetch.js` | crawler verification against a stub site on a local port: calendar goldens (the real Aug + Sep 2026 pages), plan, dry run makes no requests, spacing, User-Agent, conditional requests + 304, manifest sha256/bytes, robots-disallowed path never requested + audited, 429 backoff, no re-download without --refresh, audit rows under the day's correlation id. |
| `server/backfill.js` | the batch backfill runner (D43): every ARCHIVED race day in date order -> ML sheet (record) + program (analysis) merged -> race day -> dmtc results -> one card under the CURRENT engine version -> graded; reads the D41 archive only. `BLOCKING_TYPES` is invariant 9 batch policy A in code (unparsed distance, race count vs the calendar on sheet / program / results page, index validation, program/ML conflicts on program numbers, document track/date mismatch): zero blocking -> `commitDay` (day -> results -> card in ONE transaction through the routes' own writers `insertRaceDay`, `saveResults`, `persistCard`); any blocking -> a `backfill_queue` row holding the exact save payload. Idempotent (a live day is skipped; `--regenerate` appends a card, never touches a grade). `dayPayload()` includes `analysis: parsed.merged.analysis ?? []` (D59 fix - dropped before, so `insertRaceDay`'s `bottomLineByRace` map was always empty and every backfilled day silently got no `races.bottom_line`, invisible until D55's Replay view made the gap obvious). Per-meet golden checkpoint: halts at the meet's FIRST archived race day until `tests/fixtures/backfill/<meet>/day.expected.json` exists (writes `day.candidate.json` + copies the artifacts), re-verifies it every run, halts on drift. A `chart.txt` / `chart.pdf` beside a day runs the D42 cross-source check in memory (never saved). Report per meet: `docs/backfill/<meet>.md` + `.json` sidecar merged across runs, regression line for the eight hand-graded days. Queue API: `GET /api/backfill/queue`, `GET /api/backfill/queue/:id`, `POST .../confirm` (= commitDay), `POST .../reject` (note required). |
| `scripts/backfill.js` | the runner CLI: `--from --to [--dry-run] [--regenerate] [--meet M] [--bankroll 200] [--min 5] [--raw-dir --golden-dir --docs-dir]`; one line per day, summary, regression line; exit 1 when halted. Resume = rerun the same command after the golden is audited. |
| `scripts/backfill-bottom-line.js` | D59 one-off: re-parses every already-saved day's archived program (via `parseArchivedDay`) and fills `races.bottom_line` for whatever `dayPayload()` silently dropped before the fix. Idempotent, dry run by default (`--yes` writes); real-corpus run 2026-09-02: 650 races across 70 days, zero skipped. |
| `scripts/check-backfill.js` | runner verification: pure (blocking set, meet boundaries, calendar index, regression labels, per-bucket summary), the runner on a FAKE archive with stub parsers (golden halt -> audit -> resume, drift halt, queue routing per blocking type, non-blocking saves, cross-source, dry run, idempotency, --regenerate preserves grades, report merge), the queue API on the real server (reject needs a note, confirm = the commit, 409s, P/L by meet), and the REAL parsers on the real 2026-08-30 archive with the Equibase chart (~90s). |
| `client/src/components/BackfillQueue.jsx` | the Backfill queue view: pending days with their blocking types, the read-only preview (`ParsePreview.jsx`, shared with New race day) + Confirm / Reject with a note; decided items link to the saved day. |
| `shared/distribution.js` | distribution reporting (D20, pure, browser + Node): `dependenceFor` (single-ticket dependence gross = top ticket / total returned incl. refunds, net = top ticket net / day net profit on winning days; the > 0.8 flag is NET), `maxDrawdown` (deepest peak-to-trough of the running P/L, dates + span), `distributionFor` (per completeness bucket: losing-day share, drawdown, dependence counts, refunds, mean day, per-day rows; never a pooled total). |
| `server/distribution.js` | `GET /api/distribution?engineVersion=&meet=`: the P/L selection rules (latest version by default, `all` pools by choice, meet filter, deleted days out), ONE card per day per bucket (latest card number), figures from the pure module. |
| `client/src/components/DistributionView.jsx` | the Distributions view (`/distribution`): per-bucket cards (losing days, max drawdown with its window, dependence flags net vs gross), the D51 "Simulated templates" section (per bucket: latest run per template and mode with losing-day share, max drawdown and P/L, each with its delta vs lean under the same meet selector) + a day table with a flagged-only filter. |
| `scripts/check-distribution.js` | drawdown shapes, gross vs net dependence (the 2026-08-28 shape, the strict 80% boundary, refunds), bucket isolation, the endpoint on a seeded DB (selection, latest card per day, deleted out, no pooled total). |
| `server/ml-sheet-parser.js` | the track's morning-line / changes PDF -> the D04 entries structure (D40): two-column page, races headed by ordinal titles, wager menu, summary line (distance abbreviations -> words, surface, type, purse, claiming price), one row per horse (pgm, name, meds, claim price / Waived, jockey, weight, ML, SCRATCHED, AE), track/date from the header. The ENTRIES SOURCE OF RECORD when present. |
| `shared/entries-merge.js` | `mergeMlAndProgram` (browser + Node, pure): the sheet is the record, the program is analysis-only (programRank, bestBet, trainer, owner, breeding) and must agree on pgm + name to contribute; scratches/odds/jockey/weight disagreements become `program_ml_disagreement` warnings, the sheet wins. |
| `server/fetchers/dmtc-ml.js` | the Del Mar ML-sheet source: predictable URL per date (past dates retained), robots-allowed, registered in the D07 registry as `produces: 'entries'` so it shares the audit trail and robots guard; the consensus runner skips it, `POST /api/fetch/ml-sheet` drives it (preview only, audited). |
| `scripts/check-ml.js` | ML ingest verification: the real 2026-08-16 sheet golden + hand checks, merge units, and a server round trip (parse/merge/fetch endpoints against a stub source, ML-only save -> ODDS_ONLY card -> its own P/L bucket). |
| `server/program-parser.js` | program-PDF parser (Node, pdfjs-dist): race panels anchored by their "MM/DD/YYYY Race N" footer (simulcast pages have none), horse bands by nearest program-number y (never stream order), Bottom Line analysis → programRank + bestBet, alphabetical-index cross-validation incl. the printed-scratch/renumbered-index pattern. Track: the spelled-out panel letters (D E L M A R) first, else the "<Track> Bottom Line" header (`trackFromBottomLine`; the 2026-08-22 program has no payoff box), else a `no_track` warning. Header fields are pure exported helpers: `distanceFromHeader` (number-word grammar anchored at an item start, line-wrap reunite; conditions text and stakes titles can never be the distance) and `stakesTitleFromHeader` (the line under "Nth Running of", sponsor clause dropped; /Stakes/ word match only as fallback). `splitFusedOwnerTrainer` (card-wide pass): when pdfjs fuses a long owner line with the trainer into one item, a trainer string parsed cleanly elsewhere on the card is peeled off the owner text; no match -> `owner_trainer_fused` warning, never a guess. |
| `tests/fixtures/programs/` | two REAL Del Mar program PDFs, each with an audited golden: 2026-08-30 (12.2MB, committed — same precedent as life-swipe's SSA archive) and 2026-08-22 (12.7MB; Pacific Classic day, a layout with no panel payoff box and stakes titles without the word "Stakes"; user decision 2026-09-02). |
| `scripts/check-program.js` | program-parser verification: golden diff + hand-checked assertions (98 entries, scratch overlays, stakes header, AE forms, not-to-be-claimed, Best Bet, index cross-check). |
| `server/ingest.js` | the ingest API: `POST /api/parse/entries-text`, `POST /api/parse/program-pdf` (raw `application/pdf` body, no multipart dep), `POST /api/race-days` (validated, transactional, 409-on-duplicate with explicit replace; a soft-deleted tombstone for the same track/date is superseded), `GET /api/race-days[/:id]` (+`?deleted=1`), `GET .../deletion-preview`, `DELETE /race-days/:id` (soft, migration 005, logged to decision-trace), `POST .../restore`. Preview-first: parse endpoints never write. |
| `scripts/check-ingest.js` | end-to-end ingest verification: boots the real server on a temp DB and exercises parse → save → read-back → conflict → replace → bad payloads → the real program PDF over HTTP. |
| `server/fetchers/index.js` | the consensus-fetcher registry and interface contract; concrete fetchers register here (D08a–c). `BETSHEET_EXTRA_FETCHERS` loads stub fetchers for the check scripts. |
| `server/consensus.js` | the fetch runner: robots.txt respect (a disallowed path is never requested), backoff after repeated failures (D53: `not_published` - a discovery miss, the source has not posted yet - is neither a success nor a failure and never counts toward the three-failure backoff), track/date-mismatch discard (track compared letters-only, `trackKey`: "Delmar" is "Del Mar"), refresh-replaces semantics, resolution of picks to entries, the audit trail (fetch_attempts + fetch-audit stream; every row carries url, httpStatus and the discovery fields sitemap_url / sitemap_status / candidate_slug / entries_scanned / nearest_slug so an attempt is auditable from the log alone), the manual paste preview/confirm routes. |
| `shared/picks-parser.js` | manual-picks text parser ("Race 1: 4, 2, 7 \| watch: 9 \| contrarian: Name"), browser + Node, warnings contract. |
| `client/src/components/ConsensusPanel.jsx` | the consensus section of a stored day: fetch/refresh, per-race picks by source, the manual paste fallback (read-only preview → confirm), and the always-visible fetch audit (D53: URL and Discovery columns - sitemap + status, entries scanned, the candidate slug, the nearest slug; `not_published` shown as a neutral tag, never counted as a failure). |
| `scripts/check-consensus.js` | framework verification against stub sources on a local port: ok/robots/404/mismatch/backoff/refresh/manual/resolver/disabled paths, plus picks- and robots-parser units. Sets `BETSHEET_DISABLE_BUILTIN_FETCHERS` so it can never touch the network. |
| `server/fetchers/sftb.js` | Sports from the Basement fetcher: sitemap URL discovery (post URLs carry the publish date, not the race date; the Jetpack index, newest three sitemaps), expected-order tables → top/second/third picks by ROW ORDER only (the ML / Expected / Value columns are placeholders on some posts - 0.00 / 1 / 2-1 on 2026-09-03 - and nothing keys on them; the favorite for algo_fades_favorite is the race day's own morning line), full order in the top pick's note (D09 contrarian detection), SCRATCH rows excluded. D53: `trackSlug` maps the track spellings ("Delmar" / "DEL MAR" / "DMR") to the site's word slug until D35 canonicalizes at save; `resolveUrl` answers { url, discovery } - sitemapUrl / sitemapStatus / candidateSlug / entriesScanned / nearestSlug (closest by track + date words, the near-miss) for the audit row. |
| `tests/fixtures/sources/` | real captured source pages with audited goldens; `sftb-delmar-2026-08-30.html` is their post for the SAME day as the program-PDF fixture. |
| `shared/dmtc-results-parser.js` | the dmtc.com results page -> the D12 result structure (D42), browser + Node, pure: header (stakes name, surface, distance words, class, purse, post time), WPS table for the top three with prices, ALSO RAN as finish order 4th onward (verified against the Equibase charts for 08-28/29/30 - names only, resolved to program numbers at save), SCRATCHED names, the PAYOFFS grammar (every exotic with base + winning numbers, multi-winner legs, "(N OF M)" consolations kept as `correct`/`of`, Place Pick All, TURFPICK3(...), 3X3) and CARRYOVERS, track condition + final time. The Equibase embed link is read for the date only, never fetched. |
| `scripts/check-dmtc-results.js` | the cross-source proof: for 08-28/29/30 the same tickets graded from the dmtc page and from the Equibase chart must return identical cents (a real card on 08-30 + a broad synthetic ticket set per day); page goldens + hand checks; the from-archive endpoint incl. the calendar race-count hard error; save as dmtc_html replaces + regrades. |
| `shared/chart-parser.js` | Equibase results-chart parser (browser + Node): per-race finishers with W/P/S payoff tiers (the mutuel header decides the layout - a tiny field with no show pool prints "Win Place" only and two prices are win/place; a Carryover column makes an unhit pool print pool + carryover with no payout - both found by the D42 dmtc cross-check), every mutuel row (split at the first $ into WPS half + exotic half; payout/pool peeled from the end; named pools, OF-style combos, two-winner legs, jackpot payouts without cents), scratches with reasons, claimed notes. Unmodeled wagers warn, never guess. |
| `tests/fixtures/charts/` | the REAL Equibase chart for Del Mar 2026-08-30 (user-provided PDF + its extracted paste-text) with the audited golden — same day as the program and SFTB fixtures. |
| `server/results.js` | results persistence: POST /api/race-days/:id/results (confirmed chart OR dmtc-page parse; `sourceKind` paste / pdf / dmtc_html recorded as equibase_paste / equibase_pdf / dmtc_html; also-ran finishers without a program number resolved by name against the day's entries -> race_results/exotic_payoffs/result_scratches in one transaction, result_charts provenance appended, wrong-track/date refused whole, replace-on-resave, 410 on deleted days), GET .../results. Chart scratches carry names only, so program numbers are resolved against the day's entries at save (grading refunds key on them). A results save AUTO-GRADES every card of the day. |
| `shared/grading.js` | ticket grading, PURE: every bet type (WPS per $2, exotics per printed base, `/`-alternate chart legs, parlays chained off win prices, doubles/pick-N off the settling race's payoff row) and the documented scratch/refund policy — WPS refund, single-race exotics pro-rata combo refunds, multi-race pools conservatively refunded whole on a scratched-out leg, parlay legs pass through at factor 1. Outcomes: win / refund / partial / loss. The simulator replays this exact grader. |
| `server/grading.js` | grading persistence: gradeAndPersist (grade sets keyed by engine version - same version replaces, newer appends, invariant 14; readers use graded_tickets_latest; `ticket_graded` per ticket + `card_graded` summary traced under the CARD's correlation id — the trace that recorded why a ticket exists also records what it earned), gradeAllCards (the auto-hook after a results save; card generation after results grades in-line too), POST /api/cards/:id/grade (409 until results land), GET .../grades. |
| `scripts/check-grading.js` | grading verification: hand-computed synthetic cases for every bet type and refund rule, the REAL day graded pure (program golden -> card, chart golden -> grades; hand-audited payoffs pin the math), and a server round-trip (409 before results, auto-grade on save, read-back, regrade-replaces, trace events on file). |
| `server/pl.js` | P/L reporting: GET /api/pl — per-completeness-bucket totals for ONE engine version (`?engineVersion=<v>`, default the latest graded card's version, `all` pools on request; response carries `engineVersions` + `selectedVersion`), every graded card as a row, ungraded cards listed separately, and deliberately NO pooled all-bucket total (invariant 13); GET /api/race-days/:id/pl — per-race × per-card breakdown for the variant compare (multi-race tickets under 'multi', 410 on deleted days). Every join filters `deleted_at IS NULL` (invariant 12). |
| `client/src/components/PLView.jsx` | the P/L screen: bucket panels (P/L, ROI, cards/tickets), per-day card tables (row click opens the card), an expandable race-by-race matrix comparing a day's cards side by side, and the not-graded-yet list. |
| `scripts/check-pl.js` | P/L verification against the real server: three-day scenario (FULL × 2 variants from the real fixtures, synthetic PROGRAM_ONLY, ungraded), bucket-sum isolation, no-pooled-total shape check, cross-agreement with the grading endpoint, per-race cells summing to card totals, soft-delete dropping out of every aggregate and restore bringing it back. |
| `server/trace-export.js` | the Phase 3 feed: GET /api/cards/:id/export builds one self-contained JSON per card — recipe, races + entries, consensus picks, sources, allocations, tickets joined with their grades, the day's results, and the card's full decision trace read back from the log files (active + rotated + gzipped) by correlation id / cardId. `traceStatus` (complete/partial/missing, proven by the engine's gap-free seq counter) flags log loss instead of exporting silence. Schema documented in docs/trace-schema.md; bump SCHEMA_VERSION on shape changes. 410 on deleted days. |
| `scripts/export-trace.js` | CLI twin of the export endpoint (`npm run export-trace -- --card N [--out file]`); same document, no server needed. |
| `docs/findings/` | structure-layer findings per (engine version, bucket, corpus), written from run IDs; see "Findings" below. `lean-1.1-program-only.md` (D52) is the first. |
| `docs/trace-schema.md` | the trace event catalog (envelope, every engine/grading/lifecycle event with fields) and the export document shape. check-export asserts every event type appearing in a real export is documented here. |
| `scripts/check-export.js` | export verification: the server runs with a tiny log-rotation threshold so one card's trace provably spans multiple rotated files; asserts seq contiguity across rotation and gzip, grade joining, regrade appending (log keeps every pass), doc honesty, named download, 404/410 guards, CLI ≡ endpoint, and honest partial/missing flagging when trace files are lost. |
| `shared/templates.js` | strategy templates (D18): 12 named rule bundles: lean / spread / no-fade / no-chaos-box / structure-only / no-place-money + the D48 simulation-only four (exacta-primary / no-exotics / box-depth-3 / best-bet-weighted) that vary what actually fires on PROGRAM_ONLY days + the D49 simulation-only pair (box-only = split exacta box kept, mid-price straight exacta off; straight-only = the reverse via `hedgeBoxDepth: 0`) that isolate WHICH exotic leaks + the RULE_LAYERS signal/structure map the simulator keys on (structure rules read prices and ranks, benchmarkable on any completeness bucket; signal rules consume consensus votes). Pure — the code is the source of truth. |
| `server/templates.js` | seeds the code-defined templates into the strategy_templates table (upsert by name, at boot and after factory reset) so cards reference them by FK, and serves GET /api/templates. |
| `shared/simulation.js` | the simulator core, PURE (D19): `simulateDay` = generateCard + gradeCard on one day under one rule set; `summarizeRun` rolls day rows up per completeness bucket with the bankroll-over-time series (running P/L, running bankroll when a starting bankroll is given). Deliberately no all-bucket total. |
| `server/simulate.js` | the simulation API: `POST /api/simulations` runs every template (or the named ones) over every non-deleted day that has results - engine input assembled by cards.js's `assembleEngineInput`, results by grading.js's `loadDayResultsFor`, so a simulated day IS the live computation; simulation-only templates allowed here. Run option `applyChartScratchesBeforeGeneration` (D50, default false): `applyChartScratches` hands the engine a COPY of the day with the chart's result_scratches (resolved to program numbers at save, the rows grading refunds key on) marked scratched, so the card is the at-the-window one; grading unchanged; the flag + `scratchesApplied` ride `simulation_runs.params` (no schema change). Runs persist APPEND-ONLY to simulation_runs/simulation_results; `GET /simulations`, `/simulations/compare?meet=` (D51: latest run per (template, scratch mode) - the two modes never pool - narrowed to one meet on request; every bucket row carries losing-day share, max drawdown and the vs-lean block from `compareRow`: P/L delta, paired better / worse / tied day counts, share and drawdown deltas against the lean row of the same bucket, mode and meet; `baseline` self on lean, none when the mode has no lean run), `/simulations/:id` (buckets + series + days, `mode` as_generated / chart_scratches_applied), `/simulations/:id/days/:dayId` (per-ticket outcomes). Reads filter deleted days (invariant 12) and re-roll buckets live. One `simulation_run` trace event per run, carrying the mode flag. |
| `client/src/components/SimView.jsx` | the simulator screen: run-everything button with the D50 "apply chart scratches before generation" checkbox, a Meet selector (D51), one compare table per bucket (latest run per (template, mode): Mode column "as generated" / "scratches applied (N)", days, losing days, drawdown with its delta, wagered, returned, P/L, ROI, vs lean = P/L delta + "better on N / worse on M / tied on T", blank on lean, "no baseline" when the mode has no lean run, hits), expandable bankroll-over-time table per bucket naming the run's mode. |
| `scripts/check-sim.js` | simulator verification on the real server (check-pl's three-day scenario): a simulated day equals the live card's grade, bucket isolation, series math, overrides, listing/compare/append-only, delete/restore, the trace event; D50: the synthetic day carries a name-only chart scratch and the real chart its eight - the at-the-window card names none of them and grades with zero refunds, the default mode still equals the live card, compare keeps the two modes on separate rows. |
| `scripts/check-templates.js` | template verification: hygiene (overrides name real knobs, layer map covers the rule set exactly), each template's signature behavior on the real day + a synthetic chaos/coverage race, place-money invariant under every non-simulation template, and the server round-trip (FK persistence, trace/export carry the template, invariant-1 422 guards, reseed after reset). |
| `client/src/components/ResultsPanel.jsx` | the results section of a stored day: chart paste + PDF upload, warnings-first read-only preview, save/replace, per-race finish/exotics/scratches view. |
| `server/pdf-text.js` | line-reconstructed text extraction from text-based PDFs (y-grouped, x-sorted) — the chart PDF path feeds the SAME parser as a paste. |
| `scripts/check-charts.js` | chart-parser verification: golden + hand-checked payoffs + the program↔chart closure (every program entry is a finisher or a scratch). |
| `scripts/check-sources.js` | per-source verification, one section per fetcher: golden + hand-checked assertions + URL-discovery units, no network. D53: the 2026-09-03 placeholder-column post as a second SFTB fixture (row order only; the favorite from the entries), live-shaped sitemap fixtures (the post found for "Del Mar" and "Delmar" two days before the race; a date with no post -> the audit fields + nearest slug; 503 index; one page failing), and the backoff rule on a temp DB (three / five not_published never back off; three real failures around one do; migration 013 columns). |
| `shared/classification.js` | the consensus table + UNANIMOUS/SPLIT/CHAOS call (invariant 4's 2-external-source floor, program-only defaults) and contrarian flags (`algo_fades_favorite` via the algo's full expected order, `corroborated_longshot` at 10-1+ from 2+ sources), plus per-horse source counts for the lean-mode coverage rule. Pure functions — the simulator replays them. |
| `scripts/check-classification.js` | unit verification for classification: every rule with a case that catches its inversion. |
| `shared/betmath.js` | every tunable number (`BET`), wager-menu parsing, payout math (win/parlay exact at ML; place/exotics as labeled ranges), teller-call formatting, combo/box costing. Change here, then `npm run check-engine`. |
| `shared/card-engine.js` | the card engine, PURE: lean allocation (UNANIMOUS heaviest, 2yo-maiden guesswork minimum, chaos toward exotics), ticket construction (fade-the-price, keep-stacks flips, longshot-on-top, hedge cuts, 2+-source coverage, mid-price coverage, parlay + doubles reserve), the MANDATORY place-money sweep with its allocation carve-out (D36: an 8-1+ win and its matching place are sized inside the race's allocation - win = place = floor((allocation − exotics) / 2) for a lone pick - so the race lands on its number; traced as `place_money_carve_out`), exact-bankroll balancing (deficits toward each race's allocation first, then the remainder spread round-robin in $1 steps across every race's primary win ticket, largest allocations first, never parked on one ticket - traced as `remainder_distributed`), completeness, and the full decision trace. Structure-layer rules individually toggleable for simulation; the D48 knobs (`exoticTickets`, `winStake`, `hedgeBoxDepth` - 0 = no split box, D49) are template-driven, never a hardcoded branch. |
| `server/cards.js` | card API: `POST /api/race-days/:id/cards` (classifies fresh, generates, persists APPEND-ONLY - every generation is a new card row with its full recipe: bankroll, per-race min, variant, completeness, and a per-day card_number - and streams every trace event to decision-trace under the card correlation id), `GET /api/race-days/:id/cards`, `GET /api/cards/:id` (includes races, entries, and saved Bottom Line text), `DELETE /api/cards/:id` (confirmed hard-delete of the card and its cascading dependents; race day and logs remain). Card ids are AUTOINCREMENT (migration 007), never reused. |
| `scripts/check-engine.js` | engine verification: the real Del Mar goldens end to end (fade-the-price fires on the real 4/5 favorite), synthetic guaranteed cases, structure-layer toggles, trace-shape assertions, and a server round-trip that finds the card's trace in the log file. |
| `shared/parsers/human-picks.js` | human ticket parser (D54), PURE: pasted text for ONE race -> the same ticket shape card-engine produces (bet type, legs, stakeCents, costCents, tellerCall - reusing shared/betmath.js's `tellerCall`/`parseWagerMenu`/`BET.minimums`). Columns split on `|` when the line has one (D57: a browser textarea's Tab key moves focus rather than inserting a tab, so `|` is the recommended hand-typed delimiter; detected per line, never mixed with the tab/2+-space fallback within one row, so an incidental double space inside a piped rationale is never mistaken for a column break), else the original tab/2+-space rule (spreadsheet paste already carries tabs). Vocabulary: win/place/show/exacta/exacta_box/trifecta/trifecta_box/superfecta/superfecta_box; Daily Double/Pick N match just far enough to reject with a pointer at D55. Combos are the cartesian product across `/`-legs with impossible repeats dropped; box-type selections (no positional meaning) split on either `,` or `/` (D56 fix: a box written "#1 / #6" used to be read as one bogus token). Each warning carries its own `blocking` boolean (a narrower, per-item convention than server/backfill.js's BLOCKING_TYPES policy map, since blocking here decides which ticket gets built, not a whole day's save): unknown program / scratched selection (program-time or chart) / below-minimum or non-multiple stake / an unsupported multi-race type are blocking; a name/program mismatch or a disagreeing `($N x M combos)` parenthetical are not - the stake column always wins. Never throws. Takes an optional `ruleTag` (D63, default `'human'`) stamped onto each ticket's `ruleTags` - `server/llm-cards.js` reuses this exact parser/validation for an LLM's ticket-block text with `ruleTag: 'llm'`, so a model's picks get the identical warnings and ticket shape a human's pasted ones do, with zero duplicated logic. |
| `server/human-cards.js` | human cards API (D54): `previewHumanRace` (never writes) + `persistHumanRace` (the one writer, mirrors `insertRaceDay`/`saveResults`/`persistCard`) - `POST /api/race-days/:id/human-cards/preview` and `POST /api/race-days/:id/human-cards` (`{race, text, pass?, bankrollCents?, cardId?}`; omitted `cardId` always starts a NEW human card, so replaying an already-revealed day is a new card, not an edit - the D28 rule; 409 refuses a re-lock on a race already `results_revealed_at` on the named card). Re-parses `text` itself on save and refuses (422) on any `blocking` warning rather than trusting a client-shaped payload. A locked race also writes one `allocations` row (confidence `'HUMAN'`, so CardView.jsx renders it with no changes) and sets `race_days.replayed_at` on the day's first-ever human lock. Grades immediately via the existing grader when the day already has results, under `engine_version: 'human'` (never `lean-*`) - invariant 14 isolates it from every engine version by default, `?engineVersion=all` (or `=human`) surfaces it. `template: 'human'` is a real `strategy_templates` row (seeded in server/templates.js, deliberately outside shared/templates.js's TEMPLATES map so it never appears in the live-generate dropdown, resolveTemplate(), or a simulation run). `loadRace`/`scratchedProgramNumbersFor` are exported (D63) so `server/llm-cards.js` reuses the identical race/scratch resolution rather than a second copy. |
| `scripts/check-human-picks.js` | verification for D54: the exact design-note ticket table end to end (5 tickets, $100 total, teller calls), every warning type incl. multi-race rejection, save-side blocking enforcement independent of the preview, PASS, the D28 409 + new-card remedy, `replayed_at` set once, bucket isolation (invariant 13) against an engine card on the same day, and the no-version-bump identity (ENGINE_VERSION unchanged, a live engine card still generates under it). |
| `docs/prompts/llm-card-v1.md` | LLM cards (D63): the base-text origin, the three v1 deviations (no search tool - already-fetched consensus provided instead; per-race not per-day, dynamic per-race bankroll; structured ticket-block output reusing `shared/parsers/human-picks.js` rather than a new JSON schema), and the exact per-race system/user prompt template `server/llm-prompt.js` implements. Keep the doc and the code in sync when the template changes. |
| `server/anthropic-client.js` | thin Anthropic Messages API client for LLM cards (D63), reusing life-swipe's `server/anthropic.js` pattern exactly (hand-rolled, no SDK, so the key never ships to the browser): `complete` (AbortController timeout, a 400 naming "prefill" retries once without one), `AnthropicError`, `hasKey()`. `ANTHROPIC_API_KEY` (required) / `BETSHEET_LLM_MODEL` (default `claude-sonnet-5`). No provider-switch/Ollama seam - one local user, one model, so only the client wrapper is reused, not life-swipe's full `provider.js`. |
| `server/llm-prompt.js` | LLM card prompt (D63), PURE: `buildLlmRaceUserPrompt` (entries with scratch/best-bet/rank annotations, the program Bottom Line if present, the consensus table from `shared/classification.js`'s `buildConsensusTable`, the per-race bankroll line) and `extractTicketBlock` (splits a response into `reasoningText` + `ticketBlockText` on the `<<<TICKETS>>>`/`<<<END TICKETS>>>` markers; `null` when the markers are missing entirely - a hard failure, nothing safe to preview). Mirrors docs/prompts/llm-card-v1.md exactly. |
| `server/llm-cards.js` | LLM cards API (D63): `previewLlmRace` (calls the model, logs the attempt to `llm_card_requests` regardless of outcome - invariant 11 - then parses a well-formed response through `shared/parsers/human-picks.js` with `ruleTag: 'llm'`; never persists a ticket/card, invariant 9) + `persistLlmRace` (the one writer - re-loads and re-parses the STORED response for a given `requestId` server-side, same "never trust a client-shaped payload" rule D54 follows, refusing 422 on any blocking warning). `POST /api/race-days/:id/llm-cards/preview` (`{race, cardId?}`; test-only `__stubResponse` bypasses the real API entirely when `BETSHEET_LLM_TEST_MODE=1`, so CI never calls out) and `POST /api/race-days/:id/llm-cards` (`{race, requestId, bankrollCents?, cardId?}`; omitted `cardId` starts a new card, same D28 append-only convention as human cards). Per-race bankroll = `(card bankroll - spent on OTHER races) / (races still without a ticket, including this one)`, recomputed fresh on every call - see the DELIVERABLES.md ledger row for the two rejected alternatives (a flat split; a user-editable amount). No lock/reveal state machine (unlike human cards) - an LLM card isn't a Replay blind-play feature, so regenerating an already-ticketed race simply replaces it. `template: 'llm'` is a real `strategy_templates` row, seeded the same way and for the same reason as `'human'`. `GET /api/cards/:id/llm-requests` serves every logged call for a card (reasoning + raw response, per race, success or failure). |
| `client/src/components/LlmCardPanel.jsx` | the LLM card section on a race day's view (`RaceDayView.jsx` → `CardsPanel.jsx`'s "Generate Card from LLM" toggle, alongside the existing "Generate card" button): resumes the day's own latest `template: 'llm'` card on mount (same resume rule Replay's `ReplayRaceView` uses for human cards, D60), one row per race (status: Not generated / Generated) with a Generate/Regenerate action that previews (shows the model's reasoning, the parsed tickets, and any warnings - blocking ones disable Save) before an explicit Save, exactly like D54's human paste flow with the "typing" step replaced by a network call. |
| `scripts/check-llm-cards.js` | verification for D63: the pure prompt builder and ticket-block extractor (Phase 1), then a real server round trip with `BETSHEET_LLM_TEST_MODE=1` and no API key set at all - `__stubResponse` carries a canned model response straight through the exact preview/save path a real call would take, so the real API is never hit in CI. Covers: preview → save → append across races, per-race bankroll math as it depletes (and as it recomputes when a race is regenerated), a malformed response (no ticket-block markers - hard error, nothing persisted, the attempt still logged with `error` set), an unknown-program-number response (not a hard error - previews with a blocking warning like a human's bad paste, save refuses 422), reasoning/raw response retrievable per race, bucket isolation in P/L (invariant 13), and the no-version-bump identity. |
| `shared/replay.js` | Replay (D55), PURE: `computeBlindness` (max over EVERY lock on the card, PASS rows included, vs. the min reveal - a race locked after another race's reveal makes the whole card SEQUENTIAL even if that race is never itself revealed; a card that isn't the day's first human card is NON_BLIND unconditionally, the D28 replay-of-a-replayed-day case), `isCardClosed` (every race passed or revealed), `pickerAgreement` (human's largest win ticket vs. the program rank-1 pick and the SFTB top pick, over every considered race - a race with no win ticket or a stakes tie is EXCLUDED and counted, never guessed), and a re-export of `maxDrawdown` from shared/distribution.js. |
| `server/replay.js` | Replay API (D55): the day picker (`GET /replay/days`, `GET /replay/random` - every stored day with results, no meet filter since D61 removed it), the blind view (`GET /replay/days/:id/races/:number?cardId=` - raw `buildConsensusTable` picks only, never `classifyRace`'s derived call/flags, unless the card's `saw_classification` is set; **no** `results`/`finishOrder`/`payoffs`/`leanTickets` key exists at all pre-reveal, and the same revealed payload re-appears on GET once a race actually is revealed, via `revealedPayload` shared with the reveal route; each `humanGraded`/`leanGraded` entry's `ticket` carries `tellerCall`/`rationaleText`/`oddsAtBet` alongside the grader's own fields - D60 - so the client can render the actual ticket, not just its outcome), `POST .../reveal-classification` (one-way toggle), `POST /replay/cards/:id/races/:number/reveal` (`leanGraded`/`leanRacePl` are `null`, never a throw, when the day has no lean card), `POST /replay/cards/:id/close` (every unlocked race -> explicit PASS, every locked-unrevealed race -> revealed, ONE timestamp for the whole call so a genuinely pre-committed day still reads PRE_COMMIT afterward), `GET .../summary`, and `GET /replay/standing?meet=` (mirrors P/L's `?meet=` default-`all` convention; only CLOSED cards count; groups by `(blindness, sawClassification)` - always split, never pooled - each with human-vs-lean P/L/ROI-both-ways/paired day counts/drawdown, plus one `pickerAgreement` line across every race in scope). Never constructs a human ticket itself - the paste/lock/pass flow calls D54's own `/human-cards/preview` and `/human-cards` endpoints directly. |
| `client/src/components/ReplayDayPicker.jsx` | the `/replay` day list: every stored day with results, "Random unplayed day", a link to Standing. D61: the original DMR-2025-*-only default + "widen to every meet" checkbox is gone - `GET /replay/days`/`GET /replay/random` (server/replay.js) always return every day. |
| `client/src/components/ReplayRaceView.jsx` | the blind per-race screen: entries + Bottom Line (D58: open by default, not collapsed - the same paragraph CardView.jsx shows) + raw consensus (with an opt-in "reveal the engine's read" once a card exists), paste box + Preview/Lock/PASS (D54's endpoints), locked-ticket display, Reveal results (finish order + exotic payoffs + human vs. lean allocation/P-L side by side). D60: on mount, resumes the day's own latest human card via `listCards` (a fresh visit - a reload, a different tab, back from Standing - would otherwise show every day as never-played); `summary.closed` is fetched from the server (`getReplaySummary`, refreshed after every reveal and on mount), never just "did I click Close in this tab", so the day-closed banner and the full ticket-by-ticket `GradedTicketsTable` (bet type, selections/rationale, teller call, cost, outcome + returned, P/L, race subtotal - one for human, one for lean) appear whenever the card is GENUINELY closed, reload or not. |
| `client/src/components/ReplayStanding.jsx` | `/replay/standing`: one row per (blindness, saw-classification) group - human P/L, ROI wagered and bankroll, vs-lean delta with paired better/worse/tied, drawdown - plus the picker-agreement summary. |
| `scripts/check-replay.js` | verification for D55: pure `computeBlindness`/`isCardClosed`/`pickerAgreement` unit cases (incl. the exact lock-then-reveal-then-lock-again sequence the SEQUENTIAL fix targets), then a server round-trip - the blind view's key-set discipline before AND after reveal, the classification toggle (one-way, card-wide), reveal on a day with no lean card, close() (idempotent, PASSes the unlocked race, a genuinely pre-locked FIRST card on its own day still reads PRE_COMMIT while a SECOND card on the same day is NON_BLIND regardless), standing's meet pooling and never-pooled dimensions, bucket isolation and the no-version-bump identity. |
| `client/src/components/CardsPanel.jsx` | the cards section of a stored day: recipe columns (# / variant / bankroll / per-race min / consensus / tickets / day total), variant field, Generate action (append-only — every run is a new numbered card). "Generate Card from LLM" (D63) toggles `LlmCardPanel.jsx` inline below - a separate flow since LLM generation is per-race with a preview step, not a one-click whole-day action like the engine's. |
| `client/src/components/CardView.jsx` | the sheet: per-race tables (Bet type / Selections-rationale / Say to the teller / If it hits / Cost), thesis + board-watch triggers, multi-race section, subtotals, footer (totals, sources used with dates + unavailable, scratches, failure-mode warnings, responsible-gambling line). |
| `client/src/api.js` | client half of the ingest API; carries the session's correlation id on every call. |
| `client/src/App.jsx` | root component, theme application, browser view routing (list / new / pl / simulate / day / card) via the History API. |
| `client/src/routes.js` | pure browser route parsing and formatting; UI paths stay separate from `/api` paths. |
| `client/src/components/NewRaceDay.jsx` | the ingest screen: track/date/bankroll form, paste box + PDF upload, warnings-first READ-ONLY preview (corrections = fix the source, re-parse), save with replace-on-conflict. Save needs Track + Date; when the parse could not supply them the preview says which field is missing instead of a silently disabled button. |
| `client/src/components/RaceDayList.jsx` | home: stored race days table, Show deleted toggle + restore, and the Danger zone (factory reset behind an explicit confirm). |
| `server/reset.js` | factory reset shared by `POST /api/reset` (requires `{confirm:"RESET"}`) and the CLI: wipes every table in FK order, VACUUMs, restarts the race-day id sequence, removes every log file (`resetLogs` in logging.js), then logs `app_reset` as the new era's first event. |
| `scripts/reset.js` | CLI factory reset; refuses without `--yes`. |
| `client/src/components/RaceDayView.jsx` | read-only view of a stored day — what landed in the DB, not what the parser proposed. |
| `client/src/prefs.js` | per-user UI preferences in `localStorage` (theme). Never card data. |
| `client/src/styles.css` | all styles: Radix Mauve imports, semantic tokens, light/dark themes, desktop-first layout. |

Planned homes (each arrives with its PR — keep this table honest as they
land): `server/fetchers/` — one module per consensus source (Wayback D08d
pending). The Phase 3 trace export / templates / simulator arrive with
their PRs.

---

## Commands

```bash
npm start              # build + serve on 127.0.0.1:8788
npm run dev            # vite :5175 + api :8788
npm run check-logging  # logging: rotation, sweep, retention, torn lines
npm run check-schema   # schema: constraints, cascades, migrations, tamper guard
npm run check-parsers  # entries parser vs. fixtures (golden + hard assertions)
npm run check-program  # program-PDF parser vs. the real Del Mar program (~30s)
npm run check-ingest   # boots the real server on a temp DB; full API flow (~30s)
npm run check-consensus # fetch framework vs. stub sources on a local port
npm run check-sources   # concrete fetchers vs. real captured fixtures
npm run check-classification # consensus table + UNANIMOUS/SPLIT/CHAOS rules
npm run check-engine    # card engine vs. the real goldens + server round-trip
npm run check-charts    # results-chart parser vs. the real Equibase chart
npm run check-grading   # ticket grading vs. hand-computed + real-day payoffs
npm run check-human-picks # D54: human ticket parser, lock/save/grade, D28 refusal, bucket isolation
npm run check-replay    # D55: blindness/close pure units, blind-view key-set discipline, standing
npm run check-llm-cards # D63: prompt builder + ticket-block extraction, stubbed preview/save round trip, per-race bankroll math, bucket isolation
npm run check-pl        # P/L views: bucket isolation, per-race sums, delete/restore
npm run check-export    # trace export: rotation/gzip read-through, loss flagging
npm run check-templates # strategy templates: layer map, per-template behavior, guards
npm run check-sim       # simulator: sim == live grade, buckets, series, delete/restore, trace
npm run check-routing   # browser routes, SPA deep links, and API JSON boundary
npm run check-ml        # ML sheet: real 08-16 sheet golden + hand checks, merge, endpoints, ODDS_ONLY tier
npm run check-dmtc-fetch # crawler vs. a stub site: calendar, politeness, conditional requests, robots, backoff, audit
npm run check-dmtc-results # dmtc results page vs. Equibase chart: identical cents per ticket on 08-28/29/30
npm run dmtc-fetch -- --from YYYY-MM-DD --to YYYY-MM-DD [--what program,ml,results,calendar] [--refresh] [--dry-run]  # archive dmtc.com artifacts
npm run dmtc-probe -- --meet DMR-2025-summer --from 2025-07-18 --to 2025-09-07 --source "..."  # index a past meet whose calendar is dark (one audited request per date)
npm run backfill -- --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run] [--regenerate] [--meet DMR-2026-summer]  # batch backfill from the archive (halts for each meet golden)
npm run check-distribution  # distributions: losing days, drawdown, single-ticket dependence gross vs net, bucket isolation
npm run backfill-bottom-line [-- --yes] [--raw-dir dir]  # D59: retroactively fill races.bottom_line from the archived program (dry run by default)
npm run check-backfill  # backfill runner: policy A routing, golden halt/resume/drift, idempotency, regenerate, queue API, real 08-30 day (~90s)
npm run export-trace -- --card N [--out f]  # the LLM feed for one card
npm run reset -- --yes  # FACTORY RESET: wipe every record AND every log file
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
  **The user reviews and merges — Claude never merges.**
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

| feature | state | notes |
| --- | --- | --- |
| LLM cards: manual per-race LLM picks as a third comparison point (D63) | in review | PR [#79](https://github.com/KevinRaffay/betsheet/pull/79), branch `llm-cards` — "Generate Card from LLM" alongside the existing "Generate card" button, per race: preview (the actual model call, logged verbatim to the new `llm_card_requests` table regardless of outcome) then an explicit Save, same D54 preview-first shape. New `LLM_GENERATED` completeness bucket (migration 018 rebuild) and `engine_version: 'llm'`/`template: 'llm'` (never pools with any engine bucket or with HUMAN). The response's ticket block reuses `shared/parsers/human-picks.js` unmodified (new optional `ruleTag` param) rather than a new JSON schema/parser. Per-race bankroll defaults to `(card bankroll - spent so far) / (races remaining)`, recomputed on every call - flagged for review, two alternatives (flat split; user-editable) rejected, see docs/prompts/llm-card-v1.md. `server/anthropic-client.js` reuses life-swipe's `server/anthropic.js` client pattern exactly (no SDK, no provider-switch seam - not needed here). `npm run check-llm-cards` (new) never calls the real API - `BETSHEET_LLM_TEST_MODE=1` lets a request carry a stubbed response straight through the real preview/save/parse path; `check-schema`, `check-human-picks`, `check-pl`, `check-distribution`, `check-templates`, `check-routing`, `check-replay`, `check-sim`, `check-export`, `check-grading`, `check-ingest`, `npm run build` all pass. Browser-verified the no-key failure path live (no `ANTHROPIC_API_KEY` configured in this environment): "Generate" on a race shows a visible error, "LLM call failed: ANTHROPIC_API_KEY is not set." — no crash, no partial card; the success path is covered by the stubbed server round trip instead |
| Per-race Del Mar Bottom Line on card view (D48-QA) | merged | QA `qa` branch deliverable — migration 012 stores nullable race-level Bottom Line text; ingest preserves parser analysis, the card API returns it with races and entries, and `/card/:id` renders available text in collapsed panels; validated with `npm run check-schema`, `npm run check-ingest`, `npm run check-program`, `npm run check-engine`, and `npm run build` |
| Hard-delete individual card (D49-QA) | merged | QA `qa` branch deliverable — confirmed `/card/:id` action and `DELETE /api/cards/:id` remove card-owned records through foreign-key cascades while preserving the race day and decision logs; validated with `npm run check-engine` and `npm run build` |
| Repo scaffold (D01) | merged | PR #1 — stack, styling system, server wiring, docs ledger |
| Logging foundation (D02) | merged | PR #2 — three JSONL streams, size+day rotation, gzip/retention sweep, correlation IDs, `/api` request log |
| SQLite schema + migrations (D03) | merged | PR #3 — full schema incl. Phase 2–4 tables, append-only migrations with tamper guard, money in cents |
| Entries parser — pasted text (D04) | merged | PR #4 — validated against a real Del Mar card (8 races, 81 entries, 0 warnings) |
| Ingest UI + API (D06) | merged | PR #6 — paste/PDF → warnings-first read-only preview → transactional save; migration 002 adds `races.wager_menu` |
| Consensus-fetch framework (D07) | merged | PR #7 — fetcher registry, robots/backoff/mismatch handling, audit trail, manual paste fallback w/ read-only preview |
| Program track fallback (D31) | merged | PR #28, branch `program-track-fallback` - the 2026-08-22 Del Mar program has no panel payoff box, so the parser returned track null and "Save race day" sat disabled with no explanation. Parser now falls back to the "<Track> Bottom Line" header (else warns `no_track`); the ingest preview names the missing field. Known follow-ups on that program (not fixed here): stakes race titles without the word "Stakes" (Green Flash Handicap, Del Mar Oaks, Del Mar Mile) fall back to the conditions text; R3 distance null, R7/R11 distance mis-picked |
| Bankroll balancer remainder fix (D30) | merged | PR #27, branch `balancer-remainder` - the balancer parked the whole per-card rounding remainder on the single biggest win ticket (card 16 R1: $37 allocated, $65 spent, a quarter of the bankroll on one horse). Now round-robin $1 steps per race per pass, largest allocations first, guesswork races last; `remainder_distributed` trace event; card view shows allocated AND spent per race |
| Place-money carve-out (D36) | merged | PR #38, branch `place-money-carve-out` - engine `lean-1.1`: the pair is sized inside the allocation, the balancer tops deficits up toward each allocation before spreading, `remainder_distributed` names skipped races; check-engine allocation-integrity assertions |
| dmtc results HTML parser (D42) | merged | PR #37, branch `dmtc-results-parser` - second results source of record, cross-validated against Equibase; from-archive preview with the calendar race-count hard error; provenance vocabulary (migration 010) |
| Batch backfill runner + Backfill queue (D43) | merged | PR #41, branch `backfill-runner` — migration 011 (`race_days.meet`, `backfill_queue`), server/backfill.js (policy A in code, commitDay through the routes' own writers, golden checkpoint per meet, cross-source in memory, per-meet report), queue API + view, P/L by meet, `npm run backfill`, `npm run check-backfill`; the routes now call the shared `insertRaceDay` / `saveResults` / `persistCard` |
| Backfill run DMR-2026-summer (D44) | merged | PR #42, branch `backfill-dmr-2026-summer` — 27 days Jul 17 - Aug 30 saved under lean-1.1, zero queued, golden 2026-07-17 committed, cross-source identical on 08-28/29/30, report docs/backfill/DMR-2026-summer.md; every backfilled card is PROGRAM_ONLY (no consensus source runs on archived days) |
| Index source order + meet-dates table (D47) | merged | PR #43, branch `backfill-dmr-2025-summer` — indexRaceDays / probeMeetWindow / dmtc-probe, three-way race-count rule in the runner, dark 2025-07 calendar fixture |
| Backfill run DMR-2025-summer (D45) | merged | PR #44, branch `backfill-dmr-2025-summer-run` — meet-dates table from the probe (31 race days), parser fixes for the 2025 print run (ad slug overprint, footer-anchored panel edge, 8pt numbers on 15-horse fields), golden 2025-07-18 committed, 31 saved / 0 queued, report docs/backfill/DMR-2025-summer.md |
| Backfill run DMR-2025-fall (D46) | merged | PR #47, branch `backfill-dmr-2025-fall` — meet-dates table from the probe (14 race days), foreign_program detection (the Breeders' Cup official program on BC days; blocks -> queue -> confirmed sheet-only as ODDS_ONLY), golden 2025-10-31 committed (BC program by digest only), 12 saved + 2 resolved then dropped, report docs/backfill/DMR-2025-fall.md |
| Distribution reporting (D20) | merged | PR #51, branch `distributions` — shared/distribution.js + GET /api/distribution + Distributions view; per bucket: % losing days, max drawdown, single-ticket dependence gross and net (flag = net > 80%); one card per day per bucket; `npm run check-distribution` |
| Replay: removed the DMR-2025-only default + "widen to every meet" checkbox (D61) | in review | PR #78, branch `replay-remove-meet-pool` — user request 2026-09-02. `/replay` now always shows every stored day with results; `GET /replay/days` and `GET /replay/random` (server/replay.js) dropped the `?pool=recent\|all` parameter and its `meet?.startsWith('DMR-2025')` filter entirely (not just hidden in the UI - removed server-side too, since nothing calls it anymore); `client/src/api.js`'s `getReplayDays`/`getRandomReplayDay` take no argument. `npm run check-replay`, `check-routing`, `npm run build` all pass; browser-verified all three stored days (incl. a 2026 one) show with no checkbox |
| Replay: the actual betting card, ticket by ticket, once the day is closed (D60) | in review | PR #77, branch `replay-show-graded-card` — user request 2026-09-02: after Finish Order, show the actual card with payouts, not just a one-line race P/L. `server/replay.js`'s `revealedPayload` now carries `tellerCall`/`rationaleText`/`oddsAtBet` on each graded ticket (grading itself untouched - the display fields ride along, never read by `gradeCard`); client renders a new `GradedTicketsTable` (bet type, selections/rationale, teller call, cost, outcome + returned, P/L, subtotal) for human and lean, plus the exotic payoffs table (fetched since D55, never rendered until now) - all gated on `summary.closed`, not merely `revealed`, per the request. Fixed a real gap surfaced while building this: `summary` was previously only ever set by clicking Close IN THAT TAB, so a genuinely closed day would show as never-played after a reload or on a fresh visit; `ReplayRaceView.jsx` now fetches `summary` from the server on mount and after every reveal, and resumes the day's own latest human card via `listCards` on mount too - both necessary for "after the day is closed" to mean anything across a real browsing session, not just one uninterrupted paste-lock-reveal-close run. `npm run check-replay` grew an assertion that a graded ticket's `tellerCall` survives the round trip; `check-human-picks`, `check-schema`, `check-routing`, `npm run build` all pass; browser-verified against the real closed card built during D55/D58 testing (both cards' full tickets rendered correctly, resumed after a fresh page load with no prior session state) |
| Backfill: races.bottom_line was silently dropped, now fixed + retroactively filled (D59) | in review | PR #76, branch `fix-backfill-bottom-line-drop` — root cause of D58's "no stored day has bottom_line" observation: `server/backfill.js`'s `dayPayload()` built the save payload from `parsed.merged` but never copied `parsed.merged.analysis` onto it, so `insertRaceDay`'s `bottomLineByRace` map (keyed on `payload.analysis`) was always empty for every batch-backfilled day - the live single-day flow (NewRaceDay.jsx) was never affected, only the D43 batch runner. One-line fix (`analysis: parsed.merged.analysis ?? []`); `scripts/backfill-bottom-line.js` (new, one-off, idempotent, dry-run by default) retroactively re-parses each already-saved day's archived program and fills the column. Run against the real corpus 2026-09-02: 650 races across 70 days, zero skipped (archive fully intact); DB backed up first (`data/betsheet.sqlite.pre-d59-backup`). `npm run check-backfill` grew an assertion on the real 08-30 day proving `bottom_line` now populates; `check-schema`, `check-ingest`, `check-pl`, `npm run build` all pass; browser-verified on betsheet-alt against the real backfilled 2026-08-30 data |
| Replay: Bottom Line shown open by default (D58) | in review | PR #75, branch `replay-bottom-line-visible` — user request 2026-09-02: the blind race view already returned and rendered `bottom_line`, but inside a `<details>` with no `open` attribute (matching CardView.jsx's own convention), so it read as missing unless clicked open. Now `open` in ReplayRaceView.jsx only - a cosmetic, one-attribute fix; no server/schema change. Verified visually against injected test data on the betsheet-alt instance (no stored day in either DB currently has bottom_line populated) since real ingest hasn't hit that path in this corpus yet; `npm run check-replay`, `check-routing`, `npm run build` all pass |
| Human ticket parser: pipe-delimited rows (D57) | merged | PR #73, branch `add-pipe-delimiter`, stacked on `fix-box-selection-separator`, merged to `main` via PR #74 — a plain browser textarea's Tab key moves focus rather than inserting a tab character, so the original tab/2+-space format was only reliably enterable by pasting from a spreadsheet, not by typing a row by hand. `|` is now an accepted column delimiter, detected per line (never mixed with the tab/2+-space fallback in one row, so an incidental double space inside a piped rationale is never mistaken for a column break); ReplayRaceView.jsx's paste box now recommends it. `npm run check-human-picks` grew 3 cases (parity with the tab-delimited design-note table, a rationale with an internal double space, the plain tab fallback still works); browser-verified typing a pipe-delimited row directly into the textarea |
| Human ticket parser: box selections accept '/' as well as ',' (D56) | merged | PR #72, branch `fix-box-selection-separator` — bug fix to D54, found live in Replay: `Exacta Box #1 / #6 $25` was read as ONE selection token (box types only split on ','), producing a spurious name-mismatch and a blocking "needs more horses". Box selections have no positional meaning, so '/' and ',' are now equivalent separators there; `npm run check-human-picks` grew a regression case |
| Replay: blind race view, lock/reveal, human-vs-lean standing (D55) | merged | PR #68, branch `replay`, stacked on `human-cards`, merged to `main` via PR #70 — shared/replay.js (`computeBlindness`, `isCardClosed`, `pickerAgreement`, pure) + server/replay.js (day picker, blind view with strict key-set discipline pre-reveal, reveal, `POST .../close`, standing grouped by blindness + classification-seen, never pooled), migration 017 (`cards.saw_classification`, one-way toggle), three new components (ReplayDayPicker/ReplayRaceView/ReplayStanding). No schema/behavior change to D54's writer - the UI calls its endpoints directly. Invariant 15 added. Browser-verified end to end on a fresh fixture day: paste → preview → lock → reveal (human vs. lean side by side) → classification toggle → PASS → close (correctly computed SEQUENTIAL) → standing table. `npm run check-replay` (new), `check-human-picks`, `check-schema`, `check-routing`, `npm run build` all pass |
| Human cards: paste parser, preview, HUMAN bucket (D54) | merged | PR #67, branch `human-cards` — shared/parsers/human-picks.js (pure, per-warning `blocking`) + server/human-cards.js (previewHumanRace/persistHumanRace, the one writer), migration 015 (`tickets.rationale_text`/`odds_at_bet`, `race_days.replayed_at`, `human_race_state`) + 016 (rebuild: `consensus_completeness` admits HUMAN; verified against a copy of the real 70+-day DB, zero FK errors, every pre-existing row count unchanged), `template: 'human'` seeded outside shared/templates.js's TEMPLATES map (never engine-generated or simulated), invariant 13 extended, P/L gains ROI-on-bankroll beside ROI-on-wagered (a PASS-heavy card can't look better than full coverage by construction). No engine/grader change — `npm run check-engine` stays byte-identical. `npm run check-human-picks`, `check-schema`, `check-pl`, `check-distribution`, `check-templates`, `check-sim`, `npm run build` |
| Track name canonicalization (D35) | in review | PR #64, branch `track-canonicalization` — shared/track-codes.js (`canonicalizeTrack`, pure), migration 014 (`race_days.track_code`, backfilled), `insertRaceDay` canonicalizes at save, the one-day-per-track+date check and results-chart mismatch refusal key on `track_code`, `meetForDay` drops its ad hoc letters-only check for the shared one, parse previews warn (never block) on an unrecognized track; `npm run check-schema`, `check-ingest`, `check-consensus`, `check-sources`, `check-dmtc-fetch`, `check-backfill`, `check-ml`, `npm run build` |
| SFTB discovery fix + not_published (D53) | merged | PR #62, branch `sftb-discovery` — found live 2026-09-02: a Del Mar 2026-09-03 fetch logged http_error "no published page found" with no URL, status or discovery detail while the post existed; cause = the track spelling ("Delmar" slugs to delmar-..., the site says del-mar-...; D35 is the real fix). Fetcher normalizes the track for now, every attempt row carries url / httpStatus / sitemap / candidate slug / entries scanned / nearest slug, the miss is `not_published` (migration 013) and never counts toward the backoff; `npm run check-sources`, `check-consensus`, `check-schema` |
| Findings: lean-1.1 on the PROGRAM_ONLY corpus (D52) | merged | PR #58, branch `findings-lean-1-1` (stacked on #57) — docs/findings/lean-1.1-program-only.md from runs #27-#50 (every template, both scratch modes, all meets and per meet, paired day counts); the "Findings" section above with the per-version rule; no code |
| SimView compare follow-up (D51) | merged | PR #57, branch `sim-compare-view` (stacked on #56) — meet selector, vs lean column with paired day counts, drawdown deltas, the Simulated templates section on Distributions; read-side only, no schema change, ENGINE_VERSION lean-1.1; `npm run check-sim` +8 |
| Simulator chart-scratch mode (D50) | merged | PR #56, branch `sim-chart-scratches` (stacked on #55) — run option `applyChartScratchesBeforeGeneration`: cards built at the window, grading unchanged, mode stored on the run and grouped in the compare (never pooled), Mode column in SimView, trace flag; no engine change, ENGINE_VERSION lean-1.1; `npm run check-sim` +7 |
| Exotic-isolation templates (D49) | merged | PR #55, branch `exotic-isolation-templates` — two simulation-only templates, box-only (`midPriceCoverage: false`) and straight-only (`hedgeBoxDepth: 0`, the one engine edit: depth 0 declines the split box as `disabled_by_template`, lean's depth-2 path untouched); four distinct ticket sets with lean and no-exotics on the PROGRAM_ONLY fixture, D36 tolerance held, lean byte-identical, ENGINE_VERSION stays lean-1.1 |
| Program-rank templates + rule_suppressed (D48) | merged | PR #52, branch `program-rank-templates` — four simulation-only templates (exacta-primary, no-exotics, box-depth-3, best-bet-weighted) on new template-driven knobs; rule_suppressed with machine-readable reasons at every evaluation site; lean byte-identical, no version bump |
| dmtc.com crawler + raw archive (D41) | merged | PR #36, branch `dmtc-crawler` - calendar-indexed, polite, conditional, audited crawler; raw archive with manifests; `npm run dmtc-fetch`; the two real calendar pages are fixtures |
| ML sheet as entries source of record (D40) | merged | PR #34, branch `ml-sheet-ingest` - ML/changes PDF parser + fetcher, program becomes analysis-only via the merge, ODDS_ONLY tier, engine `lean-1.0.1` (morning-line ranking fallback on rank-less races) |
| Engine versioning (D34) | merged | PR #33, branch `engine-versioning` - `ENGINE_VERSION = lean-1.0`; migration 008; version on card rows, card header, P/L rows + version filter; trace events carry it; invariant 14 |
| Simulator (D19) | merged | PR #31, branch `simulator` - every template replayed over every stored day with a chart; per-bucket compare + bankroll over time; runs append-only; `npm run check-sim` |
| Browser routes (D44-QA) | merged | History API routes for `/`, `/new`, `/pl`, `/simulate`, `/day/:id`, and `/card/:id`; production server serves the client shell for direct navigation; `npm run check-routing` — PRs #45, #48 from `qa` |
| Fused owner/trainer split (D33) | merged | PR #30, branch `owner-trainer-split` - 08-22 R9 #9 Kensington Lane arrived with "Philip D' Amato(M. Donald)" fused into the owner item and trainer null (pinned as a known gap by D32). Card-wide dictionary pass; the 08-22 golden changes in exactly that entry's owner/trainer, 08-30 byte-identical |
| Program header fields (D32) | merged | PR #29, branch `program-header-fields` - on the 2026-08-22 program, stakes titles without the word "Stakes" (Green Flash Handicap, Del Mar Oaks, Pacific Classic, Del Mar Mile) fell back to conditions text as the race type, and three distances were wrong (R3 null on a line wrap, R7 read from conditions text, R11 from the title) plus R10 truncated to "One Mile" (Pacific Classic is a mile and a quarter). Rules rewritten as pure helpers pinned by the exact pdfjs text items; the 08-22 program is now the SECOND committed fixture with its own golden + 19 hand-checked assertions (branch carries D31 merged in, since the golden needs the track fallback) |
| Strategy templates (D18) | merged | PR #26, branch `strategy-templates` — 6 named rule bundles + signal/structure layer map; allocationCurve made real (lean/spread); invariant-1 422 guard on the live endpoint; template on card rows, trace, P/L and export |
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
| Card engine + decision trace (D10) | merged | PR #13 — lean allocation, all ticket rules, mandatory place-money sweep, exact bankroll, completeness, full trace to the decision-trace stream; conditions-text interleave fix in the program parser (goldens regenerated) |
| Consensus table + classification (D09) | merged | PR #12 — chips + contrarian flags on the day view; classification re-runs after every fetch and manual confirm; migration 004 (`races.contrarian_flags`) |
| SFTB fetcher (D08c) | merged | PR #9 — sitemap discovery + expected-order parsing; real fixture matches the program-PDF day. D08a CLOSED (dmtc picks page is a directory; covered by D05's Bottom Line extraction) and D08b CLOSED (ATR bot challenge; manual-paste only) — both by user decision 2026-09-01 |
| Backtesting addendum encoding (D25) | merged | PR #8, branch `backtest-addendum` — `cards.consensus_completeness` (migration 003), invariant 12 (buckets never pool), Wayback fetcher planned as D08d, signal/structure layer split planned into D18/D19. Completeness boundary user-confirmed 2026-09-01: FULL = every race ≥2 external sources |
| Program-PDF parser (D05) | merged | PR #5 — real Del Mar program (10 races, 98 entries, Bottom Line, index validation); found the printed-scratch/renumbered-index pattern in the wild |

---

## Findings

Structure-layer findings live in `docs/findings/`, one file per
**(engine version, bucket, corpus)** - `docs/findings/lean-1.1-program-only.md`
is the first (D52: engine `lean-1.1`, bucket PROGRAM_ONLY, the 70-day DMR
2025-2026 corpus, runs #27-#50). Rules:

- A findings file is written from simulation run IDs, both scratch modes
  (D50), all meets and per meet (D51), and every number in it cites its run.
  It states what is NOT concluded and the exact question the next corpus
  must answer.
- A findings file is **never edited after the engine version it describes
  is superseded**. A new engine version gets a new file; the old one stays
  as the record of what the old engine did. Corrections to a live file are
  fine while its version is current, with the date.
- No engine change is proposed without a findings file for the version it
  would replace (REQUIREMENTS, backtest hygiene). `lean-1.2`, if it comes,
  bumps the version, regenerates append-only under D34 and is compared by
  version against `lean-1.1` - never by overwriting.

---

## Gotchas

- **This machine's Bash tool quirks** (inherited from life-swipe, they apply
  here too): `PATH` needs exporting before node/git resolve; `/tmp` means two
  different directories (bash → AppData, node → `C:\tmp`) so use full Windows
  paths for anything node opens; heredocs truncate near 8KB — write long
  files in chunks; git identity may not resolve from the global config —
  this repo carries a local `user.name`/`user.email`.
- **Ports**: BetSheet uses api :8788 / vite :5175. life-swipe owns :8787 and
  :5173/:5174 on this machine — don't squat on them.
- **Two instances, two log dirs.** The betsheet-alt test instance (port 8902, its own DB) sets BETSHEET_LOG_DIR=server/logs-alt in C:/repos/.claude/launch.json. It used to share server/logs with the main instance - either side's factory reset silently wiped the other's decision traces (found live: exports came back traceStatus=missing). Never point two instances at one log dir.
- **Equibase blocks scripted fetching.** Confirmed. Don't retry cleverly;
  the paste/PDF path is the design, not a fallback.
- **BETSHEET_CONTACT** (in `.env`, gitignored) is the human named in the
  crawler's User-Agent - set it before any `dmtc-fetch` run; the UA says
  "set BETSHEET_CONTACT" otherwise.
- **ANTHROPIC_API_KEY** (in `.env`, gitignored) is required for "Generate
  Card from LLM" (D63) - without it, preview shows a visible error
  ("ANTHROPIC_API_KEY is not set") rather than calling out; nothing
  crashes and nothing is persisted, verified live. `BETSHEET_LLM_MODEL`
  overrides the default model. `BETSHEET_LLM_TEST_MODE=1` is a
  check-script-only escape hatch (`scripts/check-llm-cards.js`) that lets
  a request body's `__stubResponse` bypass the real API call entirely -
  never set it outside a check script.
- **On Breeders' Cup days the Del Mar program URL serves the Breeders' Cup
  official program** (104 pages, 42MB, no Bottom Line, no horse index).
  program-parser.js flags it `foreign_program` and hands back no races; the
  runner saves such a day sheet-only (ODDS_ONLY) and only after a human
  confirms it in the Backfill queue (the type blocks). The golden records a
  foreign program by digest only (program.digest.json), never its bytes;
  a day confirmed from the queue and soft-deleted later stays out on every
  rerun (the 2025 BC days were dropped this way).
- **The 2025 programs carry an advertisement's print slug in the text layer**,
  overprinted (every item twice at the same coordinates). program-parser.js
  drops exact overprints before reading a panel and anchors the panel edge
  on the footer x; a new print run that breaks either assumption halts at
  the meet golden, never degrades silently (D45 found it exactly there).
- **dmtc.com renders past seasons' calendars dark.** Every 2025 month parses to
  zero race days while the artifacts are still served. Index order (D47):
  calendar with race counts, else the committed meet-dates table from ONE
  bounded probe of the published window (`npm run dmtc-probe`). A dark month
  with no table is `missingIndex` - never enumerate dates outside a
  published window.
- **Backfilled days are PROGRAM_ONLY by construction.** No consensus fetcher
  runs on an archived day (D07/D08 sources are live-day only), so a backfill
  corpus measures Bottom Line + morning line; FULL/PARTIAL buckets stay empty
  until a historical picks source exists (D08b Wayback). Never read a
  PROGRAM_ONLY corpus figure as the live methodology's.
- **Backfill resume = rerun.** The runner keeps no state of its own: it halts
  (golden checkpoint, golden drift, un-audited meet) and the fix is to audit,
  commit and run the same command again; a live day is always skipped and a
  pending queue row is never duplicated. The regression line prints
  "no baseline" unless `docs/backfill/hand-graded-baseline.json` exists -
  the hand-graded figures for the eight 2026-08 days are gone (2026-09-02).
- **A day's Equibase chart goes beside its archive as `chart.txt`** (paste
  format) or `chart.pdf`: the runner grades the day's tickets against it in
  memory and reports agreement. dmtc_html stays the saved results source of
  record; the chart is never written by the runner.
- **Backfill (D41-D43) runs only under a recorded engine version.** D34 is
  merged (#33): every backfilled card carries `engine_version`; a run before
  it would have stamped the whole corpus `lean-0`. Land D36 (carve-out) and
  D35 (canonical track) before the first run too - see the D43 ledger row.
  `race_days.meet` (D43 migration) is derived from the calendar date -
  Del Mar runs summer (Jul-Sep) and fall (Nov) meets only - so summer and
  fall corpora stay separable in P/L and distributions.
