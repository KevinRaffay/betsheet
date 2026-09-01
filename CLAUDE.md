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
9. **Parsers never save without a preview.** Every ingest path (entries,
   picks, result charts) shows a parse preview the user confirms or corrects
   before anything is written.
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
| `client/src/App.jsx` | root component and theme application. |
| `client/src/prefs.js` | per-user UI preferences in `localStorage` (theme). Never card data. |
| `client/src/styles.css` | all styles: Radix Mauve imports, semantic tokens, light/dark themes, desktop-first layout. |

Planned homes (each arrives with its PR — keep this table honest as they land):
`shared/` — parsers, consensus classification, card-generation engine, ticket
grading; runs in Node and the browser so the simulator exercises shipping
code. `server/logging.js` — structured JSON-lines streams with rotation.
`server/db.js` + `server/migrations/` — SQLite via better-sqlite3.
`server/fetchers/` — one module per consensus source. `scripts/` — CLI
verification (`check-parsers`, later `check-grading`). `tests/fixtures/` —
real entries/picks/chart samples with expected-JSON golden files.

---

## Commands

```bash
npm start              # build + serve on 127.0.0.1:8788
npm run dev            # vite :5175 + api :8788
npm run check-logging  # logging: rotation, sweep, retention, torn lines
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
| Repo scaffold (D01) | in review | PR #1, branch `scaffold` — stack, styling system, server wiring, docs ledger |
| Logging foundation (D02) | in review | PR #2, branch `logging` — three JSONL streams, size+day rotation, gzip/retention sweep, correlation IDs, `/api` request log |

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
