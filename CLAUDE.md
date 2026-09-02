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
   never by hand-editing the parser's output in the preview.
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
    `consensus_completeness` level (FULL / PARTIAL / PROGRAM_ONLY) from the
    sources that actually contributed. All P/L, simulation, and distribution
    reporting buckets by this level — a program-only backfill card and a
    full-consensus card never share an aggregate. Structure-layer rules
    (place-money, hedge cuts, exotic construction, allocation curves) are
    benchmarkable on ANY bucket; signal-layer conclusions require the bucket
    that actually had the signal.

---

## Architecture map

| file | owns |
| --- | --- |
| `server/index.js` | the HTTP server: serves `dist/`, the `/api/*` endpoints, loopback binding, `/api` request logging. |
| `server/logging.js` | structured JSON-lines logging: the three streams (`app`, `fetch-audit`, `decision-trace`), size+day rotation, gzip/retention sweep, correlation IDs, `readRecent`. Writes are synchronous and never throw. |
| `scripts/check-logging.js` | verification for logging: rotation, sweep, retention, torn lines, level gating. |
| `server/db.js` | SQLite via better-sqlite3: `openDb` (applies migrations, WAL, FKs on, tamper guard), `getDb` singleton. A migration headed `-- betsheet:schema-rebuild` runs outside the wrapping transaction with FKs OFF (table rebuilds; DROP TABLE on a parent with FKs ON cascades deletes) and must pass `foreign_key_check` before commit. |
| `server/migrations/` | append-only numbered SQL migrations. `001-initial.sql` is the FULL schema, Phase 2–4 tables included. Money is integer cents; program numbers are TEXT ("1A"); results key on race *number* so a chart can land without a parsed program. |
| `scripts/check-schema.js` | verification for the schema: tables, constraints, cascades, idempotence, tamper guard, whole-graph smoke insert. |
| `shared/entries-parser.js` | pasted-entries parser (browser + Node): race headers, conditions, per-horse rows, scratches (SCR rows + SCRATCHED footer), also-eligibles, wager menus. Never throws; reports problems in `warnings` for the preview UI. |
| `tests/fixtures/entries/` | entries fixtures: `dmtc-2026-09-03.txt` is a REAL Del Mar card captured from dmtc.com; `synthetic-coupled.txt` covers coupled "1A" entries and tab-less stats lines. Each `.txt` pairs with an audited `.expected.json` golden. |
| `scripts/check-parsers.js` | parser verification: golden-file diffs PLUS independent hand-counted structural assertions on the real fixture, so regenerating a golden cannot bless a regression. |
| `server/program-parser.js` | program-PDF parser (Node, pdfjs-dist): race panels anchored by their "MM/DD/YYYY Race N" footer (simulcast pages have none), horse bands by nearest program-number y (never stream order), Bottom Line analysis → programRank + bestBet, alphabetical-index cross-validation incl. the printed-scratch/renumbered-index pattern. |
| `tests/fixtures/programs/` | the REAL Del Mar program PDF for 2026-08-30 (12.2MB, committed — same precedent as life-swipe's SSA archive) plus its audited golden. |
| `scripts/check-program.js` | program-parser verification: golden diff + hand-checked assertions (98 entries, scratch overlays, stakes header, AE forms, not-to-be-claimed, Best Bet, index cross-check). |
| `server/ingest.js` | the ingest API: `POST /api/parse/entries-text`, `POST /api/parse/program-pdf` (raw `application/pdf` body, no multipart dep), `POST /api/race-days` (validated, transactional, 409-on-duplicate with explicit replace; a soft-deleted tombstone for the same track/date is superseded), `GET /api/race-days[/:id]` (+`?deleted=1`), `GET .../deletion-preview`, `DELETE /race-days/:id` (soft, migration 005, logged to decision-trace), `POST .../restore`. Preview-first: parse endpoints never write. |
| `scripts/check-ingest.js` | end-to-end ingest verification: boots the real server on a temp DB and exercises parse → save → read-back → conflict → replace → bad payloads → the real program PDF over HTTP. |
| `server/fetchers/index.js` | the consensus-fetcher registry and interface contract; concrete fetchers register here (D08a–c). `BETSHEET_EXTRA_FETCHERS` loads stub fetchers for the check scripts. |
| `server/consensus.js` | the fetch runner: robots.txt respect (a disallowed path is never requested), backoff after repeated failures, track/date-mismatch discard, refresh-replaces semantics, resolution of picks to entries, the audit trail (fetch_attempts + fetch-audit stream), the manual paste preview/confirm routes. |
| `shared/picks-parser.js` | manual-picks text parser ("Race 1: 4, 2, 7 \| watch: 9 \| contrarian: Name"), browser + Node, warnings contract. |
| `client/src/components/ConsensusPanel.jsx` | the consensus section of a stored day: fetch/refresh, per-race picks by source, the manual paste fallback (read-only preview → confirm), and the always-visible fetch audit. |
| `scripts/check-consensus.js` | framework verification against stub sources on a local port: ok/robots/404/mismatch/backoff/refresh/manual/resolver/disabled paths, plus picks- and robots-parser units. Sets `BETSHEET_DISABLE_BUILTIN_FETCHERS` so it can never touch the network. |
| `server/fetchers/sftb.js` | Sports from the Basement fetcher: sitemap URL discovery (post URLs carry the publish date, not the race date), expected-order tables → top/second/third picks, full order in the top pick's note (D09 contrarian detection), SCRATCH rows excluded. |
| `tests/fixtures/sources/` | real captured source pages with audited goldens; `sftb-delmar-2026-08-30.html` is their post for the SAME day as the program-PDF fixture. |
| `shared/chart-parser.js` | Equibase results-chart parser (browser + Node): per-race finishers with W/P/S payoff tiers, every mutuel row (split at the first $ into WPS half + exotic half; payout/pool peeled from the end; named pools, OF-style combos, two-winner legs, jackpot payouts without cents), scratches with reasons, claimed notes. Unmodeled wagers warn, never guess. |
| `tests/fixtures/charts/` | the REAL Equibase chart for Del Mar 2026-08-30 (user-provided PDF + its extracted paste-text) with the audited golden — same day as the program and SFTB fixtures. |
| `server/results.js` | results persistence: POST /api/race-days/:id/results (confirmed chart parse -> race_results/exotic_payoffs/result_scratches in one transaction, result_charts provenance appended, wrong-track/date refused whole, replace-on-resave, 410 on deleted days), GET .../results. Chart scratches carry names only, so program numbers are resolved against the day's entries at save (grading refunds key on them). A results save AUTO-GRADES every card of the day. |
| `shared/grading.js` | ticket grading, PURE: every bet type (WPS per $2, exotics per printed base, `/`-alternate chart legs, parlays chained off win prices, doubles/pick-N off the settling race's payoff row) and the documented scratch/refund policy — WPS refund, single-race exotics pro-rata combo refunds, multi-race pools conservatively refunded whole on a scratched-out leg, parlay legs pass through at factor 1. Outcomes: win / refund / partial / loss. The simulator replays this exact grader. |
| `server/grading.js` | grading persistence: gradeAndPersist (replace-on-regrade into graded_tickets; `ticket_graded` per ticket + `card_graded` summary traced under the CARD's correlation id — the trace that recorded why a ticket exists also records what it earned), gradeAllCards (the auto-hook after a results save; card generation after results grades in-line too), POST /api/cards/:id/grade (409 until results land), GET .../grades. |
| `scripts/check-grading.js` | grading verification: hand-computed synthetic cases for every bet type and refund rule, the REAL day graded pure (program golden -> card, chart golden -> grades; hand-audited payoffs pin the math), and a server round-trip (409 before results, auto-grade on save, read-back, regrade-replaces, trace events on file). |
| `server/pl.js` | P/L reporting: GET /api/pl — per-completeness-bucket totals, every graded card as a row, ungraded cards listed separately, and deliberately NO pooled all-bucket total (invariant 13); GET /api/race-days/:id/pl — per-race × per-card breakdown for the variant compare (multi-race tickets under 'multi', 410 on deleted days). Every join filters `deleted_at IS NULL` (invariant 12). |
| `client/src/components/PLView.jsx` | the P/L screen: bucket panels (P/L, ROI, cards/tickets), per-day card tables (row click opens the card), an expandable race-by-race matrix comparing a day's cards side by side, and the not-graded-yet list. |
| `scripts/check-pl.js` | P/L verification against the real server: three-day scenario (FULL × 2 variants from the real fixtures, synthetic PROGRAM_ONLY, ungraded), bucket-sum isolation, no-pooled-total shape check, cross-agreement with the grading endpoint, per-race cells summing to card totals, soft-delete dropping out of every aggregate and restore bringing it back. |
| `server/trace-export.js` | the Phase 3 feed: GET /api/cards/:id/export builds one self-contained JSON per card — recipe, races + entries, consensus picks, sources, allocations, tickets joined with their grades, the day's results, and the card's full decision trace read back from the log files (active + rotated + gzipped) by correlation id / cardId. `traceStatus` (complete/partial/missing, proven by the engine's gap-free seq counter) flags log loss instead of exporting silence. Schema documented in docs/trace-schema.md; bump SCHEMA_VERSION on shape changes. 410 on deleted days. |
| `scripts/export-trace.js` | CLI twin of the export endpoint (`npm run export-trace -- --card N [--out file]`); same document, no server needed. |
| `docs/trace-schema.md` | the trace event catalog (envelope, every engine/grading/lifecycle event with fields) and the export document shape. check-export asserts every event type appearing in a real export is documented here. |
| `scripts/check-export.js` | export verification: the server runs with a tiny log-rotation threshold so one card's trace provably spans multiple rotated files; asserts seq contiguity across rotation and gzip, grade joining, regrade appending (log keeps every pass), doc honesty, named download, 404/410 guards, CLI ≡ endpoint, and honest partial/missing flagging when trace files are lost. |
| `shared/templates.js` | strategy templates (D18): 6 named rule bundles (lean / spread / no-fade / no-chaos-box / structure-only / no-place-money) + the RULE_LAYERS signal/structure map the simulator keys on (structure rules read prices and ranks, benchmarkable on any completeness bucket; signal rules consume consensus votes). Pure — the code is the source of truth. |
| `server/templates.js` | seeds the code-defined templates into the strategy_templates table (upsert by name, at boot and after factory reset) so cards reference them by FK, and serves GET /api/templates. |
| `scripts/check-templates.js` | template verification: hygiene (overrides name real knobs, layer map covers the rule set exactly), each template's signature behavior on the real day + a synthetic chaos/coverage race, place-money invariant under every non-simulation template, and the server round-trip (FK persistence, trace/export carry the template, invariant-1 422 guards, reseed after reset). |
| `client/src/components/ResultsPanel.jsx` | the results section of a stored day: chart paste + PDF upload, warnings-first read-only preview, save/replace, per-race finish/exotics/scratches view. |
| `server/pdf-text.js` | line-reconstructed text extraction from text-based PDFs (y-grouped, x-sorted) — the chart PDF path feeds the SAME parser as a paste. |
| `scripts/check-charts.js` | chart-parser verification: golden + hand-checked payoffs + the program↔chart closure (every program entry is a finisher or a scratch). |
| `scripts/check-sources.js` | per-source verification, one section per fetcher: golden + hand-checked assertions + URL-discovery units, no network. |
| `shared/classification.js` | the consensus table + UNANIMOUS/SPLIT/CHAOS call (invariant 4's 2-external-source floor, program-only defaults) and contrarian flags (`algo_fades_favorite` via the algo's full expected order, `corroborated_longshot` at 10-1+ from 2+ sources), plus per-horse source counts for the lean-mode coverage rule. Pure functions — the simulator replays them. |
| `scripts/check-classification.js` | unit verification for classification: every rule with a case that catches its inversion. |
| `shared/betmath.js` | every tunable number (`BET`), wager-menu parsing, payout math (win/parlay exact at ML; place/exotics as labeled ranges), teller-call formatting, combo/box costing. Change here, then `npm run check-engine`. |
| `shared/card-engine.js` | the card engine, PURE: lean allocation (UNANIMOUS heaviest, 2yo-maiden guesswork minimum, chaos toward exotics), ticket construction (fade-the-price, keep-stacks flips, longshot-on-top, hedge cuts, 2+-source coverage, mid-price coverage, parlay + doubles reserve), the MANDATORY place-money sweep, exact-bankroll balancing (the remainder is spread round-robin in $1 steps across every race's primary win ticket, largest allocations first, never parked on one ticket - traced as `remainder_distributed`), completeness, and the full decision trace. Structure-layer rules individually toggleable for simulation. |
| `server/cards.js` | card API: `POST /api/race-days/:id/cards` (classifies fresh, generates, persists APPEND-ONLY - every generation is a new card row with its full recipe: bankroll, per-race min, variant, completeness, and a per-day card_number - and streams every trace event to decision-trace under the card correlation id), `GET /api/race-days/:id/cards`, `GET /api/cards/:id`. Card ids are AUTOINCREMENT (migration 007), never reused. |
| `scripts/check-engine.js` | engine verification: the real Del Mar goldens end to end (fade-the-price fires on the real 4/5 favorite), synthetic guaranteed cases, structure-layer toggles, trace-shape assertions, and a server round-trip that finds the card's trace in the log file. |
| `client/src/components/CardsPanel.jsx` | the cards section of a stored day: recipe columns (# / variant / bankroll / per-race min / consensus / tickets / day total), variant field, Generate action (append-only — every run is a new numbered card). |
| `client/src/components/CardView.jsx` | the sheet: per-race tables (Bet type / Selections-rationale / Say to the teller / If it hits / Cost), thesis + board-watch triggers, multi-race section, subtotals, footer (totals, sources used with dates + unavailable, scratches, failure-mode warnings, responsible-gambling line). |
| `client/src/api.js` | client half of the ingest API; carries the session's correlation id on every call. |
| `client/src/App.jsx` | root component, theme application, view routing (list / new / day). |
| `client/src/components/NewRaceDay.jsx` | the ingest screen: track/date/bankroll form, paste box + PDF upload, warnings-first READ-ONLY preview (corrections = fix the source, re-parse), save with replace-on-conflict. |
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
npm run check-pl        # P/L views: bucket isolation, per-race sums, delete/restore
npm run check-export    # trace export: rotation/gzip read-through, loss flagging
npm run check-templates # strategy templates: layer map, per-template behavior, guards
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
| Repo scaffold (D01) | merged | PR #1 — stack, styling system, server wiring, docs ledger |
| Logging foundation (D02) | merged | PR #2 — three JSONL streams, size+day rotation, gzip/retention sweep, correlation IDs, `/api` request log |
| SQLite schema + migrations (D03) | merged | PR #3 — full schema incl. Phase 2–4 tables, append-only migrations with tamper guard, money in cents |
| Entries parser — pasted text (D04) | merged | PR #4 — validated against a real Del Mar card (8 races, 81 entries, 0 warnings) |
| Ingest UI + API (D06) | merged | PR #6 — paste/PDF → warnings-first read-only preview → transactional save; migration 002 adds `races.wager_menu` |
| Consensus-fetch framework (D07) | merged | PR #7 — fetcher registry, robots/backoff/mismatch handling, audit trail, manual paste fallback w/ read-only preview |
| Bankroll balancer remainder fix (D30) | in review | branch `balancer-remainder` - the balancer parked the whole per-card rounding remainder on the single biggest win ticket (card 16 R1: $37 allocated, $65 spent, a quarter of the bankroll on one horse). Now round-robin $1 steps per race per pass, largest allocations first, guesswork races last; `remainder_distributed` trace event; card view shows allocated AND spent per race |
| Strategy templates (D18) | in review | PR #26, branch `strategy-templates` — 6 named rule bundles + signal/structure layer map; allocationCurve made real (lean/spread); invariant-1 422 guard on the live endpoint; template on card rows, trace, P/L and export |
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
