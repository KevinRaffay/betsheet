-- betsheet:schema-rebuild
--
-- Results provenance (D42): a second results source of record - the
-- track's own results page - joins the Equibase chart. result_charts.source_kind
-- vocabulary becomes explicit about WHERE the chart came from:
--   equibase_paste  pasted Equibase chart text        (was 'paste')
--   equibase_pdf    downloaded Equibase chart PDF      (was 'pdf')
--   dmtc_html       dmtc.com results page (D41 archive / upload)
-- Re-saving from a different source replaces the day's results and
-- regrades every card of the day (results.js). Rebuilt because the CHECK
-- constraint changes; ids preserved.
CREATE TABLE result_charts_new (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('equibase_paste', 'equibase_pdf', 'dmtc_html')),
  raw_digest TEXT,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  correlation_id TEXT
);
INSERT INTO result_charts_new (id, race_day_id, source_kind, raw_digest, ingested_at, correlation_id)
  SELECT id, race_day_id,
         CASE source_kind WHEN 'pdf' THEN 'equibase_pdf' ELSE 'equibase_paste' END,
         raw_digest, ingested_at, correlation_id
  FROM result_charts;
DROP TABLE result_charts;
ALTER TABLE result_charts_new RENAME TO result_charts;
