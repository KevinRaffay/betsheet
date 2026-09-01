-- Race-level contrarian flags computed by classification (D09): a JSON
-- array of { type, programNumber, horseName, detail } - e.g. the algorithmic
-- source ranking the public favorite 4th, or two sources independently
-- landing on the same double-digit longshot. Read by card generation (D10)
-- and shown on the sheet.
ALTER TABLE races ADD COLUMN contrarian_flags TEXT;
