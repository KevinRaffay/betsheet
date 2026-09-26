// Thin Anthropic client for LLM cards (D63). Reuses life-swipe's
// server/anthropic.js pattern exactly (hand-rolled Messages API call, no
// SDK dependency, so the API key never ships to the browser): a
// timeout via AbortController, a prefill retry when the model refuses an
// assistant prefill, and errors normalized to one class the caller can
// branch on. BetSheet has no Ollama/provider-switch need (single local
// user, one model), so only that one client is reused - not life-swipe's
// full provider.js seam.

const API_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const API_VERSION = '2023-06-01';

export const MODEL = process.env.BETSHEET_LLM_MODEL || 'claude-sonnet-5';

// Selectable in the LLM card modal (D75) - the current Claude model family,
// newest first. `MODEL` above stays the server-configured default when a
// call doesn't name one.
/**
 * Every model this app has EVER offered, retired ones included.
 *
 * Labels must outlive selectability: a card generated under a retired model is
 * still graded, still in P/L, and still has to render as "Haiku 4.5" rather
 * than a raw id. server/pl.js builds its byModel labels from this list for
 * exactly that reason, so dropping an entry outright would silently degrade
 * the display of cards already in the corpus.
 */
export const KNOWN_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  // Retired 2026-09-05 by user decision - a product choice about which models
  // are worth spending generations on, NOT a finding. The corpus holds exactly
  // 1 Haiku card / 3 graded tickets, which is far too little to conclude
  // anything about the model; Opus is worse over a larger (still tiny) sample.
  // The existing card stays graded, visible and correctly labelled.
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', retired: true },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];

/** What the picker offers today. A retired model can no longer be generated. */
export const SELECTABLE_MODELS = KNOWN_MODELS.filter((m) => !m.retired);

export const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

// D149: complete()'s own defaults, exported so a caller recording "what was
// requested" for a call that never reached the API (no key, a stub, a
// network failure before any response) doesn't have to duplicate them.
export const DEFAULT_REQUEST_PARAMS = { maxTokens: 4000, temperature: 1 };

export class AnthropicError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

// `user` is normally a string. It may also be an ARRAY of Anthropic content
// blocks - an image alongside text - which passes straight through to the API.
// D166 used that for tip-sheet screenshots; D177 removed the last caller, so
// nothing sends images today. The three lines are kept because they are the
// whole of the support and cost nothing, not because something needs them.
function buildMessages(user, prefill) {
  const messages = [{ role: 'user', content: user }];
  if (prefill) messages.push({ role: 'assistant', content: prefill });
  return messages;
}

/**
 * The system prompt as ONE cached content block (D420).
 *
 * Prompt caching is a prefix match on the rendered request (tools, then
 * system, then messages). For an LLM card the system prompt is ~89% of the
 * input tokens and is byte-identical from one race to the next on the same
 * card (it varies only by which optional clause blocks the race carries, and
 * the model is locked per card), while the per-race user prompt is unique
 * every time. So the breakpoint goes on the END of the system prompt: every
 * race after the first on a card reads the whole system prompt from cache at
 * a tenth of the price (a fortieth on Fable 5.1) instead of paying for it
 * again. Measured on the real request log before this shipped: 331 of 469
 * successful calls would have been hits, roughly halving input cost.
 *
 * Deliberately NOT the request-level automatic `cache_control`: that places
 * the breakpoint on the LAST cacheable block, which here is the unique user
 * prompt - every call would pay the 1.25x write premium and nothing would
 * ever be read back. The marker must sit on the shared prefix, never after
 * the varying tail.
 *
 * The TEXT is unchanged. `cache_control` is metadata on the block, not part
 * of what the model reads, so `llm_card_requests.system_prompt_hash` and
 * `PROMPT_TEMPLATE_VERSION` are computed over exactly the same string as
 * before and prompt comparability across the corpus holds. All four
 * selectable models clear the minimum cacheable prefix (512 tokens on Opus
 * 5, Opus 5.5 and Fable 5.1, 1024 on Sonnet 5; SYSTEM_PROMPT alone is ~2,200)
 * - the retired Haiku 4.5's 4,096 minimum would NOT have, silently.
 *
 * The default 5-minute TTL is the right one: the dominant traffic shape is
 * "Regenerate All Races" - 8 to 14 calls in two minutes - and a read refreshes
 * the timer, so a burst keeps its own entry warm. The 1-hour TTL doubles the
 * write cost, which loses on a burst and only wins when the user comes back
 * to the same card within the hour.
 */
function buildSystemBlocks(system) {
  if (Array.isArray(system)) return system; // already content blocks - pass through untouched
  const text = String(system ?? '');
  if (!text) return undefined;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

/**
 * The exact JSON body `complete()` sends, as a pure function so
 * scripts/check-llm-cards.js can assert its shape (the cache marker on the
 * system block, no request-level cache_control, the messages untouched)
 * without a network call.
 */
export function buildRequestBody({ model, maxTokens, temperature, system, user, prefill = '' }) {
  return {
    model,
    max_tokens: maxTokens,
    // Newer models REJECT a non-default temperature outright - claude-sonnet-5
    // answers `temperature is deprecated for this model` with a 400 for
    // temperature 0, while the default 1 is still accepted. So `null` here
    // means OMIT the field, which is the only way to call those models. Every
    // existing caller passes a number and is byte-identical to before.
    ...(temperature === null || temperature === undefined ? {} : { temperature }),
    system: buildSystemBlocks(system),
    messages: buildMessages(user, prefill),
  };
}

/**
 * Every usage figure the API reports, in one shape (D420). `input` is the
 * UNCACHED remainder only - the whole prompt is input + cacheCreation +
 * cacheRead - and `cacheRead > 0` on the second race of a card is the only
 * ground truth that caching is actually working. Null when the API sent no
 * usage block at all.
 */
function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    input: usage.input_tokens ?? null,
    output: usage.output_tokens ?? null,
    cacheCreation: usage.cache_creation_input_tokens ?? null,
    cacheRead: usage.cache_read_input_tokens ?? null,
  };
}

/**
 * One Messages API call. Same signature/behavior as life-swipe's
 * server/anthropic.js: `prefill` seeds the assistant turn (unused by LLM
 * cards today - the ticket-block marker convention doesn't need one -
 * kept for parity and future reuse), timeoutMs aborts via
 * AbortController, and a 400 naming "prefill" retries once without it
 * rather than burning the call on a model that refuses prefills.
 *
 * `fetchImpl` (D420) exists ONLY so scripts/check-llm-cards.js can drive the
 * real code path - the cache marker on the wire, the usage mapping back - with
 * a fake transport, the same seam `runActor`'s `client` parameter is in
 * server/apifyEquibase.js. A real caller never passes it.
 */
export async function complete({
  system, user, prefill = '', maxTokens = DEFAULT_REQUEST_PARAMS.maxTokens, temperature = DEFAULT_REQUEST_PARAMS.temperature,
  timeoutMs = 60000, model = MODEL, fetchImpl = fetch,
}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new AnthropicError('ANTHROPIC_API_KEY is not set', 401);
  const usePrefill = Boolean(prefill);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(buildRequestBody({
        model, maxTokens, temperature, system, user, prefill: usePrefill ? prefill : '',
      })),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new AnthropicError('Anthropic API timed out', 504);
    throw new AnthropicError('Network error calling Anthropic: ' + err.message, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 400 && usePrefill && /prefill/i.test(body)) {
      return complete({ system, user, prefill: '', maxTokens, temperature, timeoutMs, model, fetchImpl });
    }
    throw new AnthropicError(`Anthropic API ${res.status}: ${body.slice(0, 300)}`, res.status);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return {
    text: (usePrefill ? prefill : '') + text,
    usage: normalizeUsage(data.usage),
    stopReason: data.stop_reason,
    model,
    // D149: the resolved sampling params actually sent, defaults included -
    // so a caller logging this call's inputs never has to duplicate this
    // function's own defaults to know what was requested.
    requestParams: { maxTokens, temperature },
  };
}
