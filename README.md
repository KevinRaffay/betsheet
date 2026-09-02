# BetSheet

A local-only horse race betting card generator and strategy tracker. Ingest a
track program, gather internet consensus picks, generate a betting card
allocated by confidence, grade it against real Equibase results, and backtest
strategy templates across every stored card.

The near-term goal is **benchmarking card generation against real results**:
the generate → grade → simulate loop (Phases 1–3) comes before any at-track
surface (Phase 4: PDF export, here.now publishing, mobile view).

## Stack

Same stack and conventions as the life-swipe template: Node 22+ (ESM) +
Express server, React 18 + Vite client, plain CSS with Radix Colors semantic
tokens (light/dark), SQLite for storage, structured JSON-lines logging.
Desktop web is the primary platform.

## Setup

```bash
npm install
cp .env.example .env   # optional - every value has a default
```

## Run

```bash
npm start        # build the client, serve app + API on http://127.0.0.1:8788
npm run dev      # development: vite on :5175 (proxying /api), api on :8788
```

Browser views are available at `/`, `/new`, `/pl`, `/simulate`, `/day/:id`,
and `/card/:id`. Only data requests use the `/api` prefix, so these routes can
be bookmarked and refreshed directly.

The server binds `127.0.0.1` only — BetSheet is not hosted anywhere. Sharing
a finished card without the local server running is the job of the here.now
publish feature (Phase 4).

## Project documents

- [CLAUDE.md](CLAUDE.md) — working notes: invariants, architecture map,
  workflow rules. Kept current with every change.
- [REQUIREMENTS.md](REQUIREMENTS.md) — requirements mapped to deliverable IDs.
- [DELIVERABLES.md](DELIVERABLES.md) — the delivery ledger: every PR-sized
  deliverable with its status.

## Responsible gambling

BetSheet is an entertainment-wagering planning tool: pre-committed budgets,
no mid-card increases. Every generated sheet carries that line, and the app
warns when planned bets exceed the stated bankroll.
