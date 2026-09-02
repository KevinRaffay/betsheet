-- betsheet:schema-rebuild
--
-- Fetch audit (D53, D07 requirement): an attempt row must be auditable
-- from the log alone.
--   * outcome gains 'not_published' - a discovery miss (the source has not
--     posted for this track/date yet) is NOT an HTTP error and never
--     counts toward the three-failure backoff (consensus.js).
--   * discovery details land on the row: sitemap_url / sitemap_status
--     (what was scanned and how it answered), candidate_slug (the slug the
--     fetcher built), entries_scanned, nearest_slug (the closest entry by
--     track + date words, so a near-miss such as "delmar" vs "del-mar" is
--     visible in the audit).
-- Existing "no published page found" rows were discovery misses recorded
-- as http_error; they are remapped. Rebuilt because the CHECK changes;
-- ids preserved.
CREATE TABLE fetch_attempts_new (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  url TEXT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  http_status INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('ok', 'http_error', 'network_error', 'blocked', 'parse_error',
     'track_date_mismatch', 'not_published', 'manual_paste', 'manual_upload')),
  bytes INTEGER,
  parse_ok INTEGER,
  picks_extracted INTEGER,
  fallback_reason TEXT,
  correlation_id TEXT,
  sitemap_url TEXT,
  sitemap_status INTEGER,
  candidate_slug TEXT,
  entries_scanned INTEGER,
  nearest_slug TEXT
);
INSERT INTO fetch_attempts_new (id, race_day_id, source_id, url, ts, http_status, outcome, bytes, parse_ok, picks_extracted, fallback_reason, correlation_id)
  SELECT id, race_day_id, source_id, url, ts, http_status,
         CASE WHEN outcome = 'http_error' AND fallback_reason = 'no published page found for this track/date'
              THEN 'not_published' ELSE outcome END,
         bytes, parse_ok, picks_extracted, fallback_reason, correlation_id
  FROM fetch_attempts;
DROP TABLE fetch_attempts;
ALTER TABLE fetch_attempts_new RENAME TO fetch_attempts;
CREATE INDEX idx_fetch_attempts_day ON fetch_attempts(race_day_id);
