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
 * One Messages API call. Same signature/behavior as life-swipe's
 * server/anthropic.js: `prefill` seeds the assistant turn (unused by LLM
 * cards today - the ticket-block marker convention doesn't need one -
 * kept for parity and future reuse), timeoutMs aborts via
 * AbortController, and a 400 naming "prefill" retries once without it
 * rather than burning the call on a model that refuses prefills.
 */
export async function complete({
  system, user, prefill = '', maxTokens = DEFAULT_REQUEST_PARAMS.maxTokens, temperature = DEFAULT_REQUEST_PARAMS.temperature,
  timeoutMs = 60000, model = MODEL,
}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new AnthropicError('ANTHROPIC_API_KEY is not set', 401);
  const usePrefill = Boolean(prefill);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // Newer models REJECT a non-default temperature outright - claude-sonnet-5
        // answers `temperature is deprecated for this model` with a 400 for
        // temperature 0, while the default 1 is still accepted. So `null` here
        // means OMIT the field, which is the only way to call those models. Every
        // existing caller passes a number and is byte-identical to before.
        ...(temperature === null || temperature === undefined ? {} : { temperature }),
        system,
        messages: buildMessages(user, usePrefill ? prefill : ''),
      }),
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
      return complete({ system, user, prefill: '', maxTokens, temperature, timeoutMs, model });
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
    usage: data.usage ? { input: data.usage.input_tokens ?? null, output: data.usage.output_tokens ?? null } : null,
    stopReason: data.stop_reason,
    model,
    // D149: the resolved sampling params actually sent, defaults included -
    // so a caller logging this call's inputs never has to duplicate this
    // function's own defaults to know what was requested.
    requestParams: { maxTokens, temperature },
  };
}
