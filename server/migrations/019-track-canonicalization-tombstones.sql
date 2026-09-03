-- Repair D35 canonicalization for databases containing a deleted tombstone
-- and a live day for the same canonical track/date.

UPDATE race_days
SET track = '__legacy_delmar__'
WHERE track_code = 'DMR'
        AND deleted_at IS NOT NULL
        AND EXISTS (
                SELECT 1 FROM race_days live
                WHERE live.id <> race_days.id
                        AND live.date = race_days.date
                        AND live.deleted_at IS NULL
                        AND live.track_code = 'DMR'
        );

UPDATE race_days SET track = 'Del Mar'
WHERE track_code = 'DMR' AND deleted_at IS NULL;

UPDATE race_days SET track = 'Del Mar'
WHERE track_code = 'DMR' AND deleted_at IS NOT NULL
        AND track <> '__legacy_delmar__';

UPDATE race_days SET track = 'Delmar'
WHERE track = '__legacy_delmar__';