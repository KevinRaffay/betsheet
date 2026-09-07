-- 026: capture what an LLM card GENERATION call actually consumed, not just
-- what it produced (D149).
--
-- llm_card_requests (D63/D92) already carries the user prompt text, the raw
-- response, the model, and the notes snapshot for every call, success or
-- failure - it is already the append-only, never-overwritten log invariant
-- 11 wants. Rather than add a second table that would duplicate that same
-- prompt/response content (which the deliverable's own "reuse it, don't add
-- a parallel store" instruction forbids), this migration widens the existing
-- row with the fields it was missing:
--
--   * correlation_id - the card-session id (invariant 8) the call belonged
--     to. Previously only recorded on cards/trace events, never on the
--     request row itself, so there was no way to group "every call from one
--     Generate/Regenerate-All session" back together, or to tell which
--     correlation id a given race's tickets came from once a later
--     regeneration (under a NEW correlation id) replaced them. Nullable:
--     every row inserted before this migration predates the concept.
--   * system_prompt_text / system_prompt_hash - the system prompt was never
--     stored at all (only reconstructable via buildSystemPrompt({hasNotes})
--     from the fixed SYSTEM_PROMPT + ANALYST_NOTES_CLAUSES constants, which
--     is retroactive the moment either constant's text next changes).
--   * user_prompt_hash - a hash of the already-stored prompt_text, computed
--     once at write time so a reproduction check does not need to re-hash a
--     multi-KB string on every read.
--   * notes_rendered_text - the composed, sanitized, truncated text actually
--     embedded in the prompt. notes_race_text/notes_card_text (023) are the
--     RAW text the human typed; this is what the model actually saw, the
--     same text notes_hash/notes_char_count were already computed over.
--   * prompt_template_id / prompt_template_version - identifies which
--     template rendered this prompt. server/llm-prompt.js exports both as
--     constants; the version is derived from a hash of SYSTEM_PROMPT itself
--     (see that file) rather than a number a future prompt-fix PR would have
--     to remember to bump - this codebase's own D64/D112/D125/D136/D138/
--     D145/D146/D148 history is a PR-after-PR record of prompt edits that
--     never carried any version marker at all, so a self-deriving one is the
--     only kind that cannot silently go stale.
--   * request_params - the JSON {maxTokens, temperature} actually sent to
--     the Anthropic API for this call (server/anthropic-client.js's
--     complete() now echoes back the resolved values, defaults included).
--
-- Ordinary ALTERs - no CHECK constraint touches any of these columns, so no
-- table rebuild is needed (migration 023 is the precedent for widening this
-- exact table the same way).
ALTER TABLE llm_card_requests ADD COLUMN correlation_id TEXT;
ALTER TABLE llm_card_requests ADD COLUMN system_prompt_text TEXT;
ALTER TABLE llm_card_requests ADD COLUMN system_prompt_hash TEXT;
ALTER TABLE llm_card_requests ADD COLUMN user_prompt_hash TEXT;
ALTER TABLE llm_card_requests ADD COLUMN notes_rendered_text TEXT;
ALTER TABLE llm_card_requests ADD COLUMN prompt_template_id TEXT;
ALTER TABLE llm_card_requests ADD COLUMN prompt_template_version TEXT;
ALTER TABLE llm_card_requests ADD COLUMN request_params TEXT;

CREATE INDEX idx_llm_card_requests_correlation ON llm_card_requests(correlation_id);
