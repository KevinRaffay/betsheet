-- 039: what an LLM card GENERATION call actually COST, per call (D420).
--
-- The Anthropic API reports token usage on every response, and until now
-- this codebase threw it away: server/anthropic-client.js's complete()
-- returned input/output counts and server/llm-cards.js never read them, so
-- the only figure available for what a card cost to generate was an
-- estimate from string lengths. D420 also turned prompt caching on - the
-- system prompt is sent as one cached block - and the ONLY ground truth that
-- caching is working is `cache_read_input_tokens` being non-zero on the
-- second race of a card. A cache that silently stops hitting (a timestamp
-- added to the system prompt, a marker moved to the wrong block) looks
-- exactly like a cache that works, except on the bill, so the usage has to
-- be on the row where a query can see it, not in a log line.
--
-- Same table, same reasoning as migration 026: llm_card_requests is already
-- the append-only, one-row-per-call record of every generation, and these
-- four figures describe that call and nothing else. A second table would be
-- a parallel store of the same key.
--
--   * input_tokens - the UNCACHED remainder. The whole prompt is
--     input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
--     read the sum, not this one field.
--   * output_tokens - includes thinking tokens on models that think, which
--     is why it is always larger than a count of `response_text` would be.
--   * cache_creation_input_tokens - written to the cache this call, at the
--     1.25x write premium (the first race on a card, or a race whose
--     optional clause blocks differ from the previous race's).
--   * cache_read_input_tokens - served from cache, at 0.1x (0.025x on
--     Fable 5.1). Non-zero here is the proof.
--
-- All four NULLable: every row before this migration predates the capture,
-- a call that never reached the API (no key, a network failure) has none,
-- and the check scripts' stubbed calls never produce any. No CHECK
-- constraint touches the table, so ordinary ALTERs (023/026/037/038 are the
-- precedents).
ALTER TABLE llm_card_requests ADD COLUMN input_tokens INTEGER;
ALTER TABLE llm_card_requests ADD COLUMN output_tokens INTEGER;
ALTER TABLE llm_card_requests ADD COLUMN cache_creation_input_tokens INTEGER;
ALTER TABLE llm_card_requests ADD COLUMN cache_read_input_tokens INTEGER;
