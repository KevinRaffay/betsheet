// Client half of the ingest API. Every call in one ingest session carries
// the same correlation id (handed out by the first parse response) so the
// session reads as one trace server-side.

async function asJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Equibase entries page (D116). The FILE is read client-side and its markup
// posted as JSON, so one endpoint serves both capture routes the parser
// accepts - a saved .html file and pasted markup - and the client never has
// to know which it is holding. `oddsCapturedAt` is the file's own
// last-modified time, which is when the person saved the page; it is the only
// staleness fact available, because the page does not print one.
export const parseEquibaseEntries = (html, { oddsCapturedAt = null, correlationId } = {}) =>
  fetch('/api/parse/equibase-entries', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ html, oddsCapturedAt }),
  }).then(asJson);

// Bulk entries zip. The FILE is posted as a raw application/zip body rather
// than read in the browser: a day's decompressed HTML is 15-17MB against the
// 10mb JSON limit, while the archive itself is about 2MB. Posted twice, once
// to preview and once to save, so the server re-parses rather than trusting a
// client-shaped payload.
export const previewEntriesZip = (file, correlationId) =>
  fetch('/api/parse/equibase-entries-zip', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: file,
  }).then(asJson);

export const saveEntriesZip = (file, { replace = false, bankrollCents, perRaceMinCents } = {}, correlationId) => {
  const q = new URLSearchParams({
    ...(replace ? { replace: '1' } : {}),
    ...(bankrollCents != null ? { bankrollCents: String(bankrollCents) } : {}),
    ...(perRaceMinCents != null ? { perRaceMinCents: String(perRaceMinCents) } : {}),
  });
  return fetch(`/api/race-days/from-zip?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: file,
  }).then(asJson);
};

export function saveRaceDay(payload, correlationId) {
  return fetch('/api/race-days', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
    },
    body: JSON.stringify(payload),
  }).then(asJson);
}

export const listRaceDays = (deleted = false) =>
  fetch(`/api/race-days${deleted ? '?deleted=1' : ''}`).then(asJson);
export const getRaceDay = (id) => fetch(`/api/race-days/${id}`).then(asJson);

export const deletionPreview = (id) =>
  fetch(`/api/race-days/${id}/deletion-preview`).then(asJson);
export const deleteRaceDay = (id) =>
  fetch(`/api/race-days/${id}`, { method: 'DELETE' }).then(asJson);
export const restoreRaceDay = (id) =>
  fetch(`/api/race-days/${id}/restore`, { method: 'POST' }).then(asJson);
export const bulkDeleteRaceDays = (ids) =>
  fetch('/api/race-days/bulk-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).then(asJson);

export function parseResultsText(text, correlationId) {
  return fetch('/api/parse/results-text', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
    },
    body: JSON.stringify({ text }),
  }).then(asJson);
}

export function parseResultsPdf(file, correlationId) {
  return fetch('/api/parse/results-pdf', {
    method: 'POST',
    headers: {
      'content-type': 'application/pdf',
      ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
    },
    body: file,
  }).then(asJson);
}

export const saveResults = (dayId, payload, correlationId) =>
  fetch(`/api/race-days/${dayId}/results`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
    },
    body: JSON.stringify(payload),
  }).then(asJson);

export const getResults = (dayId) =>
  fetch(`/api/race-days/${dayId}/results`).then(asJson);

export const getPL = (engineVersion, meet) => {
  const q = new URLSearchParams();
  if (engineVersion) q.set('engineVersion', engineVersion);
  if (meet && meet !== 'all') q.set('meet', meet);
  const qs = q.toString();
  return fetch(`/api/pl${qs ? `?${qs}` : ''}`).then(asJson);
};
export const getDayPL = (dayId) => fetch(`/api/race-days/${dayId}/pl`).then(asJson);

export const gradeCardApi = (cardId) =>
  fetch(`/api/cards/${cardId}/grade`, { method: 'POST' }).then(asJson);
export const getGrades = (cardId) =>
  fetch(`/api/cards/${cardId}/grades`).then(asJson);

export const resetAppApi = () =>
  fetch('/api/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'RESET' }),
  }).then(asJson);

export const manualPicksPreview = (id, sourceName, text) =>
  fetch(`/api/race-days/${id}/consensus/manual-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceName, text }),
  }).then(asJson);

export const listCards = (dayId) => fetch(`/api/race-days/${dayId}/cards`).then(asJson);
export const getCard = (id) => fetch(`/api/cards/${id}`).then(asJson);
export const deleteCard = (id) => fetch(`/api/cards/${id}`, {
  method: 'DELETE',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirm: 'DELETE' }),
}).then(asJson);

export const manualPicksSave = (id, sourceName, races) =>
  fetch(`/api/race-days/${id}/consensus/manual`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceName, races }),
  }).then(asJson);


// ML sheet ingest (D40).

// dmtc results page (D42).
export const parseResultsHtml = (html, correlationId) =>
  fetch('/api/parse/results-html', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ html }),
  }).then(asJson);

// Human cards (D54): paste parser preview/lock/pass for one race.
export const previewHumanCard = (dayId, race, text, cardId, correlationId) =>
  fetch(`/api/race-days/${dayId}/human-cards/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ race, text, cardId }),
  }).then(asJson);
export const lockHumanCard = (dayId, { race, text, pass, bankrollCents, cardId, name }, correlationId) =>
  fetch(`/api/race-days/${dayId}/human-cards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ race, text, pass, bankrollCents, cardId, name }),
  }).then(asJson);
// D103: delete ONE ticket from a locked, unrevealed race - the day builder's
// remedy for a ticket it locked on close. Refused server-side once the race is
// revealed or the card is graded.
export const deleteHumanTicket = (cardId, ticketId, correlationId) =>
  fetch(`/api/cards/${cardId}/human-tickets/${ticketId}`, {
    method: 'DELETE',
    headers: { ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
  }).then(asJson);

// LLM cards (D63): per-race preview (calls the model) + confirm/save, and
// the per-race request log (reasoning + raw response). `model` (D75):
// which Claude model to call for this preview; omitted uses the
// server-configured default.
export const getLlmModels = () => fetch('/api/llm-models').then(asJson);
// D76: display-only labels for a card's locked-in `llm_model` (matches
// server/anthropic-client.js's SELECTABLE_MODELS ids) - kept here, not
// fetched, so every place a card is shown (CardsPanel, CardView, PLView)
// can label a model without a network round trip. An id missing from this
// map (a model retired from SELECTABLE_MODELS, say) still displays - its
// own raw id, never a blank.
// Mirrors server/anthropic-client.js's KNOWN_MODELS, retired entries
// included: a card generated under a retired model still renders here.
export const MODEL_LABEL = {
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5', // retired 2026-09-05; kept so old cards label
  'claude-fable-5-1': 'Fable 5.1',
};
export const modelLabel = (id) => (id ? (MODEL_LABEL[id] ?? id) : null);

// D95: the same treatment for a card's derived blindness (invariant 15 -
// computed from timestamps, never set by hand). Three views render it and
// two of them already carried their own private copy of this map; a third
// copy in ReplayDayLanding is what prompted moving it here. An unknown value
// still displays, as its own raw string.
export const BLINDNESS_LABEL = { PRE_COMMIT: 'Pre-commit', SEQUENTIAL: 'Sequential', NON_BLIND: 'Non-blind' };
export const blindnessLabel = (b) => (b ? (BLINDNESS_LABEL[b] ?? b) : 'undetermined');
// Analyst notes (D92). Keyed by day + race - race 0 is the day-level note -
// because notes belong to a RACE, not a card: the same commentary feeds a
// Sonnet card and an Opus card. Empty text deletes the note.
export const getLlmNotes = (dayId) => fetch(`/api/race-days/${dayId}/llm-notes`).then(asJson);
export const saveLlmNote = (dayId, { race, text, sourceLabel }, correlationId) =>
  fetch(`/api/race-days/${dayId}/llm-notes`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ race, text, sourceLabel }),
  }).then(asJson);

export const previewLlmCard = (dayId, race, cardId, correlationId, model) =>
  fetch(`/api/race-days/${dayId}/llm-cards/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ race, cardId, model }),
  }).then(asJson);
export const lockLlmCard = (dayId, { race, requestId, bankrollCents, cardId }, correlationId) =>
  fetch(`/api/race-days/${dayId}/llm-cards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ race, requestId, bankrollCents, cardId }),
  }).then(asJson);
export const getLlmRequests = (cardId) => fetch(`/api/cards/${cardId}/llm-requests`).then(asJson);

// Replay (D55): the blind race-by-race view, reveal, close, standing.
export const getReplayDays = () => fetch('/api/replay/days').then(asJson);
export const getRandomReplayDay = () => fetch('/api/replay/random').then(asJson);
export const getReplayDayRaces = (dayId, cardId) =>
  fetch(`/api/replay/days/${dayId}/races${cardId ? `?cardId=${cardId}` : ''}`).then(asJson);
export const getReplayRace = (dayId, race, cardId) =>
  fetch(`/api/replay/days/${dayId}/races/${race}${cardId ? `?cardId=${cardId}` : ''}`).then(asJson);
export const revealReplayRace = (cardId, race) =>
  fetch(`/api/replay/cards/${cardId}/races/${race}/reveal`, { method: 'POST' }).then(asJson);
export const closeReplayCard = (cardId) =>
  fetch(`/api/replay/cards/${cardId}/close`, { method: 'POST' }).then(asJson);
export const getReplaySummary = (cardId) => fetch(`/api/replay/cards/${cardId}/summary`).then(asJson);
export const getReplayStanding = (meet) => {
  const q = meet && meet !== 'all' ? `?meet=${encodeURIComponent(meet)}` : '';
  return fetch(`/api/replay/standing${q}`).then(asJson);
};

// Equibase "Off to the Races" PDF upload (D71): preview-then-confirm, the
// same contract every PDF upload in this codebase follows, just persisting
// three verbatim cards on confirm instead of consensus picks.
export const equibaseOtrPreview = (id, file) =>
  fetch(`/api/race-days/${id}/equibase-otr`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: file,
  }).then(asJson);
export const equibaseOtrConfirm = (id, parseToken) =>
  fetch(`/api/race-days/${id}/equibase-otr/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parseToken }),
  }).then(asJson);

// Distributions (D20): losing days, drawdown, single-ticket dependence, per bucket.
export const getDistribution = (engineVersion, meet) => {
  const q = new URLSearchParams();
  if (engineVersion) q.set('engineVersion', engineVersion);
  if (meet && meet !== 'all') q.set('meet', meet);
  const qs = q.toString();
  return fetch(`/api/distribution${qs ? `?${qs}` : ''}`).then(asJson);
};

// ---- TIPSHEET picks (D166 extraction, D169 review/correct) ----------------
//
// D177: the screenshot calls are gone - picks are typed (saveManualTipPicks
// below), not photographed. What remains reads, corrects and deletes rows.

const hdr = (correlationId) => ({
  'content-type': 'application/json',
  ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
});

export const listTipPicks = (dayId, correlationId) =>
  fetch(`/api/race-days/${dayId}/tip-picks`, { headers: hdr(correlationId) }).then(asJson);

/** Correct a STORED row - a separate recorded act, never a preview edit. */
export const correctTipPicks = (tipId, picks, correlationId) =>
  fetch(`/api/tip-picks/${tipId}`, {
    method: 'PATCH', headers: hdr(correlationId), body: JSON.stringify({ picks }),
  }).then(asJson);

export const deleteTipPicks = (tipId, correlationId) =>
  fetch(`/api/tip-picks/${tipId}`, { method: 'DELETE', headers: hdr(correlationId) }).then(asJson);

/** TIPSHEET scoring (D170). Read-only; no money, no P/L, no engine version. */
export const getDayTipScoring = (dayId, correlationId) =>
  fetch(`/api/race-days/${dayId}/tip-scoring`, { headers: hdr(correlationId) }).then(asJson);

/** TIPSHEET staking (D171): preview the three variants, then write them. */
export const previewTipCards = (dayId, sourceLabel, correlationId) =>
  fetch(`/api/race-days/${dayId}/tip-cards/preview`, {
    method: 'POST', headers: hdr(correlationId), body: JSON.stringify({ sourceLabel }),
  }).then(asJson);

export const saveTipCards = (dayId, sourceLabel, correlationId) =>
  fetch(`/api/race-days/${dayId}/tip-cards`, {
    method: 'POST', headers: hdr(correlationId), body: JSON.stringify({ sourceLabel }),
  }).then(asJson);

// ---- P/L display (D175) ------------------------------------------------
//
// Here, beside MODEL_LABEL/BLINDNESS_LABEL, for the reason those are here: so
// every view renders a P/L figure identically. CardsPanel (the day view) and
// PLView both use these - a second local copy is how the format drifts.

/** Signed money for a P/L figure. Uses U+2212, the minus PLView has always used. */
export const plMoney = (cents) => (cents == null ? '—'
  : `${cents >= 0 ? '+' : '−'}$${
    Math.abs(cents) % 100 === 0 ? Math.abs(cents) / 100 : (Math.abs(cents) / 100).toFixed(2)}`);

/** The class that colours it. `null` (nothing graded) is dim, not a loss. */
export const plClass = (cents) => (cents == null ? 'dim' : cents >= 0 ? 'pl--pos' : 'pl--neg');

/**
 * Manual tip picks for one race (D176). Same payload as extraction produced,
 * through the same validator and writer - typed instead of photographed.
 */
export const saveManualTipPicks = (dayId, { race, sheets }, correlationId) =>
  fetch(`/api/race-days/${dayId}/tip-picks/manual`, {
    method: 'POST', headers: hdr(correlationId), body: JSON.stringify({ race, sheets }),
  }).then(asJson);
