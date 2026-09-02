-- Store the raw per-race handicapper paragraph when a program provides it.
-- Sources without program analysis leave this nullable field empty.
ALTER TABLE races ADD COLUMN bottom_line TEXT;
