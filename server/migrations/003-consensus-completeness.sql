-- Backtesting addendum: every card records how much consensus signal it was
-- generated from, so historical/backfilled cards are never pooled with
-- full-consensus cards in one aggregate (invariant 12).
--
--   FULL         every race drew on >= 2 external consensus sources
--   PARTIAL      some external consensus, but not FULL everywhere
--   PROGRAM_ONLY no external sources - program analysis + morning lines only
--
-- The card-generation engine (D10) computes and writes this from the
-- sources that actually contributed picks; the default is the honest floor.
ALTER TABLE cards ADD COLUMN consensus_completeness TEXT NOT NULL
  DEFAULT 'PROGRAM_ONLY'
  CHECK (consensus_completeness IN ('FULL', 'PARTIAL', 'PROGRAM_ONLY'));
