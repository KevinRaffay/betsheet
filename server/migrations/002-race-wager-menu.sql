-- The per-race wager menu ("$1 Exacta / 50c Trifecta / ...") as printed by
-- the program or entries page. Captured at ingest; D10's ticket construction
-- reads it to respect the track's actual wager menu and minimums.
ALTER TABLE races ADD COLUMN wager_menu TEXT;
