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

---

## Architecture map

| file | owns |
| --- | --- |
| `server/index.js` | the HTTP server: serves `dist/`, the `/api/*` endpoints, loopback binding, `/api` request logging. |
| `server/logging.js` | structured JSON-lines logging: the three streams (`app`, `fetch-audit`, `decision-trace`), size+day rotation, gzip/retention sweep, correlation IDs, `readRecent`. Writes are synchronous and never throw. |
| `scripts/check-logging.js` | verification for logging: rotation, sweep, retention, torn lines, level gating. |
| `server/db.js` | SQLite via better-sqlite3: `openDb` (applies migrations, WAL, FKs on, tamper guard), `getDb` singleton. |
| `server/migrations/` | append-only numbered SQL migrations. `001-initial.sql` is the FULL schema, Phase 2–4 tables included. Money is integer cents; program numbers are TEXT ("1A"); results key on race *number* so a chart can land without a parsed program. |
| `scripts/check-schema.js` | verification for the schema: tables, constraints, cascades, idempotence, tamper guard, whole-graph smoke insert. |
| `shared/entries-parser.js` | pasted-entries parser (browser + Node): race headers, conditions, per-horse rows, scratches (SCR rows + SCRATCHED footer), also-eligibles, wager menus. Never throws; reports problems in `warnings` for the preview UI. |
| `tests/fixtures/entries/` | entries fixtures: `dmtc-2026-09-03.txt` is a REAL Del Mar card captured from dmtc.com; `synthetic-coupled.txt` covers coupled "1A" entries and tab-less stats lines. Each `.txt` pairs with an audited `.expected.json` golden. |
| `scripts/check-parsers.js` | parser verification: golden-file diffs PLUS independent hand-counted structural assertions on the real fixture, so regenerating a golden cannot bless a regression. |
| `server/program-parser.js` | program-PDF parser (Node, pdfjs-dist): race panels anchored by their "MM/DD/YYYY Race N" footer (simulcast pages have none), horse bands by nearest program-number y (never stream order), Bottom Line analysis → programRank + bestBet, alphabetical-index cross-validation incl. the printed-scratch/renumbered-index pattern. |
| `tests/fixtures/programs/` | the REAL Del Mar program PDF for 2026-08-30 (12.2MB, committed — same precedent as life-swipe's SSA archive) plus its audited golden. |
| `scripts/check-program.js` | program-parser verification: golden diff + hand-checked assertions (98 entries, scratch overlays, stakes header, AE forms, not-to-be-claimed, Best Bet, index cross-check). |
| `server/ingest.js` | the ingest API: `POST /api/parse/entries-text`, `POST /api/parse/program-pdf` (raw `application/pdf` body, no multipart dep), `POST /api/race-days` (validated, transactional, 409-on-duplicate with explicit replace), `GET /api/race-days[/:id]`. Preview-first: parse endpoints never write. |
| `scripts/check-ingest.js` | end-to-end ingest verification: boots the real server on a temp DB and exercises parse → save → read-back → conflict → replace → bad payloads → the real program PDF over HTTP. |
| `client/src/api.js` | client half of the ingest API; carries the session's correlation id on every call. |
| `client/src/App.jsx` | root component, theme application, view routing (list / new / day). |
| `client/src/components/NewRaceDay.jsx` | the ingest screen: track/date/bankroll form, paste box + PDF upload, warnings-first READ-ONLY preview (corrections = fix the source, re-parse), save with replace-on-conflict. |
| `client/src/components/RaceDayList.jsx` | home: stored race days table. |
| `client/src/components/RaceDayView.jsx` | read-only view of a stored day — what landed in the DB, not what the parser proposed. |
| `client/src/prefs.js` | per-user UI preferences in `localStorage` (theme). Never card data. |
| `client/src/styles.css` | all styles: Radix Mauve imports, semantic tokens, light/dark themes, desktop-first layout. |

Planned homes (each arrives with its PR — keep this table honest as they
land): `server/fetchers/` — one module per consensus source. `shared/` also
gains consensus classification, the card-generation engine and ticket
grading, so the simulator exercises shipping code. `scripts/check-grading`
arrives with D15.

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
```

Further verification commands (`check-parsers`, `check-grading`, simulator
runs) are added by their PRs and listed here as they land.

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
| Ingest UI + API (D06) | in review | PR #6, branch `ingest-ui` — paste/PDF → warnings-first read-only preview → transactional save; migration 002 adds `races.wager_menu` |
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
- **Equibase blocks scripted fetching.** Confirmed. Don't retry cleverly;
  the paste/PDF path is the design, not a fallback.
