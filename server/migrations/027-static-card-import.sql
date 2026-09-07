-- D153: cards built on the static Pages target (D151) and imported back here.
--
-- Three nullable columns and one unique index. No table rebuild: nothing about
-- an existing CHECK changes, and `cards` is the riskiest table in this schema
-- to rebuild (ten ON DELETE CASCADE children - see migration 024's notes), so
-- it is not rebuilt for three additive columns.
--
-- external_id is the LOAD-BEARING one. `cards.id` is an integer AUTOINCREMENT
-- minted here and never reused (invariant 12), so a card built on a phone has
-- no identity this database can recognize on a second look - and files built at
-- a racetrack get copied, re-sent and re-imported by hand. Without a stable
-- external key, importing the same afternoon twice would silently double every
-- ticket in the HUMAN bucket. With it, the second import reports "already
-- present" and writes nothing, which is what makes the rolling backup in D152
-- costless rather than dangerous.
--
-- The uniqueness is an INDEX, not a column constraint: SQLite's ALTER TABLE
-- ADD COLUMN cannot carry UNIQUE, and a unique index permits many NULLs, which
-- is exactly right - every card that already exists, and every card made here
-- from now on, has no external id at all.
ALTER TABLE cards ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX idx_cards_external_id ON cards(external_id);

-- Where the card was constructed. Recorded as FACT, never as a bucket: an
-- imported card merges into the ordinary HUMAN bucket and shares every
-- aggregate with a card built at this desk, because it IS the same thing - a
-- person's own picks, locked before results. Invariant 13 buckets on what
-- SIGNAL a card had, and a phone at the track had exactly the signal a laptop
-- at home had. Keeping the provenance anyway means a future question ("did
-- at-track cards do worse?") is answerable from data rather than from memory.
-- NULL for every card that predates this, which is honest: not "built at
-- home", but "not recorded".
ALTER TABLE cards ADD COLUMN built_on TEXT;

-- D150's contamination stamp, set when the static app revealed the day's LLM
-- or OTR cards to whoever was building this one. Same one-way shape as
-- cards.saw_classification (migration 017): set once, never cleared, because
-- a card cannot become un-seen.
ALTER TABLE cards ADD COLUMN saw_reference_cards INTEGER NOT NULL DEFAULT 0;
