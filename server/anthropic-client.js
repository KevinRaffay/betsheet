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
export const SELECTABLE_MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];

export const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

export class AnthropicError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

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
  system, user, prefill = '', maxTokens = 4000, temperature = 1, timeoutMs = 60000, model = MODEL,
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
        temperature,
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
  };
}
