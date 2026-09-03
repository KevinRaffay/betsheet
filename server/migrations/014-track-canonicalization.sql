-- Track name canonicalization (D35). Root cause: D31's Bottom Line fallback
-- produced "Del Mar" for the 2026-08-22 program while every other day was
-- typed "Delmar" - two spellings of the same track landed as two different
-- `track` values, which is exactly what let D53's SFTB fetcher miss a day.
--
-- `track_code` is the stable comparison key going forward (the one-day-
-- per-track+date rule and the results-chart mismatch refusal key on it,
-- server/ingest.js and server/results.js); `track` keeps carrying the
-- display name, but every ingest path now writes the CANONICAL display
-- (shared/track-codes.js), never whatever spelling a parser happened to
-- read. Ordinary ALTER (no rebuild) - the column is additive and the
-- existing UNIQUE(track, date) still holds since canonicalized spellings
-- become identical text.
--
-- Backfill: every known Del Mar spelling ("Del Mar" / "Delmar" / "DEL MAR" /
-- "DelMarRacing.com") collapses to code DMR, display "Del Mar". Anything
-- else gets a derived code (first three letters) rather than staying NULL -
-- an unknown track is never blocked, per invariant 3's spirit.
ALTER TABLE race_days ADD COLUMN track_code TEXT;

UPDATE race_days SET track_code = 'DMR', track = 'Del Mar'
WHERE upper(replace(replace(track, ' ', ''), '.', '')) IN ('DELMAR', 'DMR', 'DELMARRACINGCOM');

UPDATE race_days SET track_code = upper(substr(replace(track, ' ', ''), 1, 3))
WHERE track_code IS NULL;
