-- Replay (D55): a per-card, one-way toggle recording whether the human
-- opted to see the engine's D09 classification (UNANIMOUS/SPLIT/CHAOS +
-- contrarian flags) for a race before locking it. Default hidden (0) -
-- the blind view shows only raw per-source picks. Once set it never
-- unsets, so the standing table can split "saw the engine's read" from
-- "genuinely blind to it" and never pool the two conditions. Ordinary
-- ALTER - additive, no rebuild.
ALTER TABLE cards ADD COLUMN saw_classification INTEGER NOT NULL DEFAULT 0;
