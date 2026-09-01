-- BetSheet initial schema. The FULL schema ships up front, Phase 2-4 tables
-- included, so later phases add code, not migrations-that-rewrite-history.
--
-- Conventions:
--   * Money is INTEGER CENTS everywhere (a $15 win bet is 1500). Floats never
--     touch money.
--   * Dates are ISO text (yyyy-mm-dd); timestamps are ISO text in UTC.
--   * program_number is TEXT - coupled entries are "1A".
--   * Morning lines keep their display form ("5/2") plus a decimal for math.
--   * correlation_id ties DB rows to the JSONL log streams (invariant 8);
--     decision traces live in the logs, joined to cards by that id.

-- ===== Phase 1: ingest =====

CREATE TABLE race_days (
  id INTEGER PRIMARY KEY,
  track TEXT NOT NULL,
  date TEXT NOT NULL,
  bankroll_cents INTEGER,
  per_race_min_cents INTEGER,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (track, date)
);

CREATE TABLE races (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  post_time TEXT,
  distance TEXT,
  surface TEXT,
  race_type TEXT,
  conditions TEXT,
  claiming_price_cents INTEGER,
  -- Classification is computed from consensus (D09); NULL until then.
  -- 'UNANIMOUS' requires >= 2 external sources (invariant 4).
  classification TEXT CHECK (classification IN ('UNANIMOUS', 'SPLIT', 'CHAOS')),
  classification_source_count INTEGER,
  thesis TEXT,
  UNIQUE (race_day_id, number)
);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  program_number TEXT NOT NULL,
  post_position INTEGER,
  horse_name TEXT NOT NULL,
  morning_line TEXT,
  morning_line_decimal REAL,
  jockey TEXT,
  trainer TEXT,
  weight INTEGER,
  equipment TEXT,
  scratched INTEGER NOT NULL DEFAULT 0,
  not_to_be_claimed INTEGER NOT NULL DEFAULT 0,
  program_rank INTEGER,          -- program handicapper analysis rank, 1 = top
  best_bet INTEGER NOT NULL DEFAULT 0,
  UNIQUE (race_id, program_number)
);

-- ===== Phase 1: consensus =====

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN
    ('track_picks', 'race_guide', 'algorithmic', 'digest', 'program', 'manual')),
  url_template TEXT,             -- e.g. https://.../picks?date={date}; NULL for manual
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);

-- The fetch audit (invariant 11) is double-booked on purpose: rows here for
-- the UI to query, events in the fetch-audit log stream for the LLM feed.
CREATE TABLE fetch_attempts (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  url TEXT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  http_status INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('ok', 'http_error', 'network_error', 'blocked', 'parse_error',
     'track_date_mismatch', 'manual_paste', 'manual_upload')),
  bytes INTEGER,
  parse_ok INTEGER,
  picks_extracted INTEGER,
  fallback_reason TEXT,
  correlation_id TEXT
);

CREATE TABLE consensus_picks (
  id INTEGER PRIMARY KEY,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  -- entry_id when the pick matched a parsed entry; the text fields always
  -- hold what the source actually said, so a failed match is visible.
  entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  program_number TEXT,
  horse_name TEXT,
  pick_type TEXT NOT NULL CHECK (pick_type IN
    ('top', 'second', 'third', 'watch_out', 'contrarian')),
  note TEXT,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ===== Phase 1: cards =====

CREATE TABLE strategy_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  rules TEXT NOT NULL,           -- JSON: the reusable rule set (D18)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  variant TEXT NOT NULL DEFAULT 'default',   -- sheet variants compared in D16
  strategy_template_id INTEGER REFERENCES strategy_templates(id),
  bankroll_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  correlation_id TEXT NOT NULL,  -- joins the decision trace in the logs
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (race_day_id, variant)
);

CREATE TABLE allocations (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  confidence TEXT,               -- the class/thesis label that drove the amount
  rule TEXT,                     -- the allocation rule that fired
  thesis TEXT,
  UNIQUE (card_id, race_id)
);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  race_id INTEGER REFERENCES races(id) ON DELETE CASCADE,  -- NULL: multi-race bets
  sequence INTEGER NOT NULL,     -- display order on the sheet
  bet_type TEXT NOT NULL,        -- win/place/exacta/trifecta_box/daily_double/pick3/parlay/...
  selections TEXT NOT NULL,      -- JSON array of legs, each an array of program numbers
  stake_cents INTEGER NOT NULL,  -- base stake per combination
  cost_cents INTEGER NOT NULL,   -- total ticket cost
  est_payout_min_cents INTEGER,
  est_payout_max_cents INTEGER,
  est_is_range INTEGER NOT NULL DEFAULT 0,  -- 1: exotic estimate; 0: exact ML math
  teller_call TEXT NOT NULL,
  rationale TEXT,
  rule_tags TEXT                 -- JSON array: rules that produced/shaped this ticket
);

-- ===== Phase 2: results & grading =====

CREATE TABLE result_charts (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('paste', 'pdf')),
  raw_digest TEXT,               -- hash of the raw input, for dedup/provenance
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  correlation_id TEXT
);

-- Keyed by race NUMBER, not race id: a chart can be ingested for a day whose
-- program was never parsed, and grading joins through race_days + number.
CREATE TABLE race_results (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  race_number INTEGER NOT NULL,
  program_number TEXT NOT NULL,
  horse_name TEXT,
  finish_position INTEGER,       -- NULL for "Also ran" without a listed position
  win_cents INTEGER,             -- $2-base payouts; NULL below 3rd
  place_cents INTEGER,
  show_cents INTEGER,
  UNIQUE (race_day_id, race_number, program_number)
);

CREATE TABLE exotic_payoffs (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  race_number INTEGER NOT NULL,
  bet_type TEXT NOT NULL,
  base_cents INTEGER NOT NULL,   -- the wager base the payout is quoted at
  combination TEXT NOT NULL,     -- e.g. "3-7" or "3-7-1"
  payout_cents INTEGER NOT NULL
);

CREATE TABLE result_scratches (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  race_number INTEGER NOT NULL,
  program_number TEXT,
  horse_name TEXT
);

CREATE TABLE graded_tickets (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'loss', 'refund', 'partial')),
  returned_cents INTEGER NOT NULL DEFAULT 0,
  pl_cents INTEGER NOT NULL,
  details TEXT,                  -- JSON: per-leg outcomes, refund reasons
  graded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  correlation_id TEXT
);

-- ===== Phase 3: simulation =====

CREATE TABLE simulation_runs (
  id INTEGER PRIMARY KEY,
  strategy_template_id INTEGER NOT NULL REFERENCES strategy_templates(id),
  params TEXT,                   -- JSON: run parameters (starting bankroll, ...)
  summary TEXT,                  -- JSON: net, % losing days, max drawdown, flags
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  finished_at TEXT
);

CREATE TABLE simulation_results (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  pl_cents INTEGER NOT NULL,
  details TEXT,                  -- JSON: per-ticket simulated outcomes
  UNIQUE (run_id, race_day_id)
);

-- ===== Phase 4: publishing & discipline =====

CREATE TABLE publishes (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  slug TEXT,
  url TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('anonymous', 'permanent')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
  error TEXT,
  expires_at TEXT,               -- NULL for permanent publishes
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  correlation_id TEXT
);

-- The at-track record (D23 writes it, D24 reads it): checking off a placed
-- bet inserts a row with actual = planned; a deviation records the truth.
CREATE TABLE actual_stakes (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  planned_cents INTEGER NOT NULL,
  actual_cents INTEGER NOT NULL,
  note TEXT,
  noted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ===== indexes on the joins the app actually makes =====

CREATE INDEX idx_races_day ON races(race_day_id);
CREATE INDEX idx_entries_race ON entries(race_id);
CREATE INDEX idx_fetch_attempts_day ON fetch_attempts(race_day_id);
CREATE INDEX idx_consensus_race ON consensus_picks(race_id);
CREATE INDEX idx_cards_day ON cards(race_day_id);
CREATE INDEX idx_allocations_card ON allocations(card_id);
CREATE INDEX idx_tickets_card ON tickets(card_id);
CREATE INDEX idx_results_day_race ON race_results(race_day_id, race_number);
CREATE INDEX idx_exotics_day_race ON exotic_payoffs(race_day_id, race_number);
