-- betsheet:schema-rebuild
--
-- Engine versioning (D34). Every card records the engine version that
-- built it; every grade records the version it was graded under. Cards
-- generated before this migration backfill as 'lean-0' = "pre-D34,
-- provenance not recorded" (they straddle the D30 balancer fix); the
-- first recorded version, 'lean-1.0', is the post-D30..D33 engine.
--
-- graded_tickets is rebuilt because UNIQUE(ticket_id) allowed exactly one
-- grade per ticket: invariant 14 (graded results are immutable per card
-- and engine version) needs one grade SET per (ticket, engine_version) -
-- a regrade under the same version replaces, under a newer version
-- appends, and the older set stays readable.
ALTER TABLE cards ADD COLUMN engine_version TEXT NOT NULL DEFAULT 'lean-0';

CREATE TABLE graded_tickets_new (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  engine_version TEXT NOT NULL DEFAULT 'lean-0',
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'loss', 'refund', 'partial')),
  returned_cents INTEGER NOT NULL DEFAULT 0,
  pl_cents INTEGER NOT NULL,
  details TEXT,                  -- JSON: per-leg outcomes, refund reasons
  graded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  correlation_id TEXT,
  UNIQUE (ticket_id, engine_version)
);
INSERT INTO graded_tickets_new (id, ticket_id, engine_version, outcome, returned_cents, pl_cents, details, graded_at, correlation_id)
  SELECT id, ticket_id, 'lean-0', outcome, returned_cents, pl_cents, details, graded_at, correlation_id
  FROM graded_tickets;
DROP TABLE graded_tickets;
ALTER TABLE graded_tickets_new RENAME TO graded_tickets;
CREATE INDEX idx_graded_tickets_ticket ON graded_tickets(ticket_id);

-- The grade set every reporting surface reads: for each card, the rows of
-- the version graded most recently (by row id, so version strings never
-- need to sort). Older sets stay in the table for version comparison.
CREATE VIEW graded_tickets_latest AS
  SELECT gt.*
  FROM graded_tickets gt
  JOIN tickets t ON t.id = gt.ticket_id
  WHERE gt.engine_version = (
    SELECT gt2.engine_version
    FROM graded_tickets gt2 JOIN tickets t2 ON t2.id = gt2.ticket_id
    WHERE t2.card_id = t.card_id
    ORDER BY gt2.id DESC LIMIT 1
  );
