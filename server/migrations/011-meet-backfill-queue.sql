-- Batch backfill (D43).
--
--   * race_days.meet: which meet the day belongs to, derived from the
--     calendar date at save time (Del Mar runs summer Jul-Sep and fall
--     Oct-Dec meets only -> DMR-<year>-summer / DMR-<year>-fall). P/L and
--     distribution views group by it so summer and fall corpora stay
--     separable. Existing Del Mar rows are backfilled by the same rule.
--   * backfill_queue: the review queue - a day whose parse carried a
--     BLOCKING warning (invariant 9, batch policy A) waits here with the
--     exact save payload it would have written; the UI shows the read-only
--     preview and the user confirms (which runs the same commit an
--     auto-save runs) or rejects with a note. The decision is recorded on
--     the row and as a trace event; rows are never deleted by the runner.
ALTER TABLE race_days ADD COLUMN meet TEXT;
UPDATE race_days SET meet = CASE
  WHEN CAST(strftime('%m', date) AS INTEGER) BETWEEN 7 AND 9 THEN 'DMR-' || strftime('%Y', date) || '-summer'
  WHEN CAST(strftime('%m', date) AS INTEGER) BETWEEN 10 AND 12 THEN 'DMR-' || strftime('%Y', date) || '-fall'
  ELSE NULL END
WHERE upper(replace(track, ' ', '')) IN ('DELMAR', 'DMR');
CREATE INDEX IF NOT EXISTS idx_race_days_meet ON race_days(meet);

CREATE TABLE backfill_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track TEXT NOT NULL,
  date TEXT NOT NULL,
  meet TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  blocking TEXT NOT NULL,          -- JSON [{type, message, source}]
  warnings TEXT NOT NULL,          -- JSON: every warning, blocking or not
  payload TEXT NOT NULL,           -- JSON: the exact POST /api/race-days body
  results TEXT,                    -- JSON: the parsed dmtc results page
  chart TEXT,                      -- JSON: the parsed Equibase chart, when archived
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  decided_at TEXT,
  decision_note TEXT,
  outcome TEXT                     -- JSON: what confirming wrote (raceDayId, cardId, figures)
);
CREATE INDEX idx_backfill_queue_date ON backfill_queue(date, status);
