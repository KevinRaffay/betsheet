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

> **Experimenting, or about to factory-reset?** Use the scratch clone at
> `C:eposetsheet-alt` — see
> [The scratch environment](#the-scratch-environment-betsheet-alt) below. A
> reset against this checkout deletes the whole corpus and every log, with no
> undo.

## The scratch environment (`betsheet-alt`)

**A factory reset destroys data. Never run one against the main checkout.**
`npm run reset -- --yes`, and the Danger zone button that calls it, delete
every stored record *and* every log file, and restart the race-day id
sequence. There is no undo.

`C:\repos\betsheet-alt` is a **second, separate clone** that exists to absorb
that. Reset it as often as you like; the main checkout cannot be affected,
because the isolation is structural rather than something you have to
remember:

```bash
git clone https://github.com/KevinRaffay/betsheet.git C:\repos\betsheet-alt
cd C:\repos\betsheet-alt
npm install --ignore-scripts   # see the note below
copy C:\repos\betsheet\.env .env
```

Run it from the `betsheet-alt` entry in `C:\repos\.claude\launch.json`, or by
hand:

```bash
set BETSHEET_PORT=8798&& set BETSHEET_VITE_PORT=5178&& npm run dev
```

### Why a separate clone, and not env vars

A factory reset touches exactly two things, and both are paths:

| | wiped by a reset |
| --- | --- |
| the database at `BETSHEET_DB` | yes — every row in 19 tables, then VACUUM |
| the log files in `BETSHEET_LOG_DIR` | yes — all three streams, active and rotated |
| `data/raw` (the crawler archive) | **no** |
| `data/archive/equibase-otr` | **no** |
| `tests/fixtures`, `docs/backfill`, `data/meets` | **no** |

The old scratch setup ran the *main* checkout with `BETSHEET_DB` and
`BETSHEET_LOG_DIR` pointed elsewhere. That works right up until one override
is missing or mistyped — and then a reset lands on the real corpus. In a
separate clone every path default resolves inside that clone, so the main
checkout is unreachable whatever you forget to set. Only the ports need
overriding, and getting a port wrong fails loudly instead of destroying
anything.

### Ports

`8798` / `5178`, deliberately. **Do not use 8899–8920**: every `check-*`
script binds a fixed port in that band, so a long-running instance there
breaks the verification suite. `8788`/`5175` are the main app, `8787` and
`5173`/`5174` belong to life-swipe, and `8890` is reserved for the
containerized QA instance (D79, backlogged).

### Sharing the archive, safely

The scratch clone starts empty. To give it something real to work with,
point it at the main checkout's 900 MB crawler archive instead of copying it:

```bash
set BETSHEET_RAW_DIR=C:\repos\betsheet\data\raw
```

This is safe, not merely convenient: the archive is read-only on every
request path (the sole reader is `POST /race-days/:id/results/from-archive`;
all writes live in the `dmtc-fetch` / `dmtc-probe` CLIs), and a reset never
touches it.

To start from a copy of the real corpus rather than an empty database, use
`VACUUM INTO` — a plain file copy misses the write-ahead log and silently
captures a stale snapshot:

```bash
node -e "const D=require('better-sqlite3');const d=new D('C:/repos/betsheet/data/betsheet.sqlite');d.exec(`VACUUM INTO 'C:/repos/betsheet-alt/data/betsheet.sqlite'`);d.close()"
```

### `npm install --ignore-scripts`

`better-sqlite3` ships a prebuilt binary for every platform in its tarball and
declares `gypfile: false`, but it also ships a `binding.gyp`, and npm tries to
compile it anyway. Without a Visual C++ toolset that fails and rolls the whole
install back. `--ignore-scripts` skips the pointless build; the prebuilt
`prebuilds/win32-x64.node` is what gets loaded at runtime either way.

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
