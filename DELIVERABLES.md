# Deliverables ledger

One row per PR-sized deliverable. **Every PR updates its own row in the same
PR.** Status values: planned / in progress / in review / merged. This file is
tracked externally — it must always reflect actual state.

| ID | Deliverable | Phase | PR # / branch | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| D01 | Repo scaffold: structure from life-swipe, CLAUDE.md, README, REQUIREMENTS.md, DELIVERABLES.md seeded with full PR list | 1 | [#1](https://github.com/KevinRaffay/betsheet/pull/1) / `scaffold` | merged | stack, styling tokens, loopback server, theme toggle |
| D02 | Logging foundation: structured JSON streams, rolling files w/ compression + retention, correlation IDs, config | 1 | [#2](https://github.com/KevinRaffay/betsheet/pull/2) / `logging` | merged | app / fetch-audit / decision-trace streams; size+day rotation, gzip past hot days, prune past retention; `npm run check-logging` |
| D03 | SQLite schema + migrations (full schema incl. Phase 2–4 tables) | 1 | [#3](https://github.com/KevinRaffay/betsheet/pull/3) / `schema` | merged | better-sqlite3; append-only migrations w/ tamper guard; money in integer cents; `npm run check-schema` |
| D04 | Entries parser — pasted text, with fixtures from real entries | 1 | [#4](https://github.com/KevinRaffay/betsheet/pull/4) / `entries-parser` | merged | validated against a real Del Mar card (dmtc.com, 2026-09-03: 8 races, 81 entries, 0 warnings); `npm run check-parsers`. Handicapper-analysis extraction moved wholly to D05 — the pasted entries format carries none; the program PDF does |
| D05 | Entries parser — program PDF (jumbled columns, index validation, handicapper-analysis extraction) | 1 | [#5](https://github.com/KevinRaffay/betsheet/pull/5) / `pdf-parser` | merged | pdfjs-dist; panels anchored by date footer, bands by program-number y; real Del Mar program fixture (10 races, 98 entries); Bottom Line -> programRank + Best Bet; index cross-validation caught the printed-scratch/renumbered-index pattern; `npm run check-program` |
| D06 | Ingest UI: paste/upload, track/date/bankroll, parse-preview with correction, save | 1 | [#6](https://github.com/KevinRaffay/betsheet/pull/6) / `ingest-ui` | in review | preview-before-save is invariant 9; warnings-first READ-ONLY preview (corrections = fix source + re-parse, per review feedback), 409+replace on duplicate day, migration 002 (`races.wager_menu`); `npm run check-ingest` boots the real server on a temp DB |
| D07 | Consensus-fetch framework: fetcher interface, scheduling/refresh, fetch audit log, manual fallback path | 1 | — | planned | |
| D08a | Source fetcher: track picks page (e.g. dmtc.com) | 1 | — | planned | re-fetch action for race-day-morning posts |
| D08b | Source fetcher: At The Races race-by-race guides | 1 | — | planned | top tip + "watch out for" per race |
| D08c | Source fetcher: algorithmic sites (e.g. Sports from the Basement) | 1 | — | planned | expected order of finish |
| D09 | Consensus table + race classification (UNANIMOUS/SPLIT/CHAOS, source-count cap, contrarian flags) | 1 | — | planned | |
| D10 | Card-generation engine + decision trace (allocation, ticket rules, place-money rule, bankroll balancing) | 1 | — | planned | trace ships in the same PR as the engine |
| D11 | Desktop web card view | 1 | — | planned | per-race tables, teller calls, totals, warnings footer |
| D12 | Results-chart parser — pasted Equibase text (WPS + exotics, scratches, "Also ran") | 2 | — | planned | second-highest priority after Phase 1 |
| D13 | Results-chart parser — downloaded chart PDF | 2 | — | planned | |
| D14 | Results ingest UI: paste/upload, preview with correction, link to race day | 2 | — | planned | |
| D15 | Ticket grading engine: all bet types incl. exotics, parlays, scratch/refund rules | 2 | — | planned | |
| D16 | P/L views: per-race, per-day, running across all cards; compare sheet variants | 2 | — | planned | |
| D17 | Decision-trace export hook + trace schema docs (traces joined with graded results, JSON export) | 3 | — | planned | the LLM-optimization feed |
| D18 | Strategy templates as reusable rules (lean/spread, place-money on/off, chaos trifecta box, fade-the-price exacta) | 3 | — | planned | |
| D19 | Simulator: run each template against all stored cards with real payoffs; bankroll over time | 3 | — | planned | |
| D20 | Distribution reporting: % losing days, max drawdown, single-ticket dependence flag (>80%) | 3 | — | planned | |
| D21 | PDF export (landscape betting sheet) | 4 | — | planned | PDF lib chosen + justified in this PR |
| D22 | here.now publishing: self-contained HTML, publish flow, QR/copy, same-slug republish, publish audit log | 4 | — | planned | anonymous 24h default; HERENOW_API_KEY for permanent |
| D23 | Mobile at-track view: check-offs, scratch marking, actual-stake entry | 4 | — | planned | |
| D24 | Discipline tracker: planned vs. actual stake, house-money escalation warnings | 4 | — | planned | data source is D23's actual-stake entry; schema ships in D03 |
