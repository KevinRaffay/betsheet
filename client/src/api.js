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

export function parseEntriesText(text, correlationId) {
  return fetch('/api/parse/entries-text', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
    },
    body: JSON.stringify({ text }),
  }).then(asJson);
}

export function parseProgramPdf(file, { track, date, correlationId } = {}) {
  const params = new URLSearchParams();
  if (track) params.set('track', track);
  if (date) params.set('date', date);
  const qs = params.toString();
  return fetch(`/api/parse/program-pdf${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/pdf',
      ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
    },
    body: file,
  }).then(asJson);
}

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

export const getTemplates = () => fetch('/api/templates').then(asJson);
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

export const fetchConsensus = (id) =>
  fetch(`/api/race-days/${id}/fetch-consensus`, { method: 'POST' }).then(asJson);

export const getConsensus = (id) =>
  fetch(`/api/race-days/${id}/consensus`).then(asJson);

export const manualPicksPreview = (id, sourceName, text) =>
  fetch(`/api/race-days/${id}/consensus/manual-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceName, text }),
  }).then(asJson);

export const generateCardApi = (dayId, body = {}) =>
  fetch(`/api/race-days/${dayId}/cards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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

// Simulation (D19).
export const runSimulation = (body = {}) =>
  fetch('/api/simulations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(asJson);
export const listSimulations = () => fetch('/api/simulations').then(asJson);
export const getSimulationCompare = (meet) =>
  fetch(`/api/simulations/compare${meet && meet !== 'all' ? `?meet=${encodeURIComponent(meet)}` : ''}`).then(asJson);
export const getSimulation = (runId) => fetch(`/api/simulations/${runId}`).then(asJson);
export const getSimulationDay = (runId, dayId) =>
  fetch(`/api/simulations/${runId}/days/${dayId}`).then(asJson);

// ML sheet ingest (D40).
export function parseMlPdf(file, { track, date, correlationId } = {}) {
  const params = new URLSearchParams();
  if (track) params.set('track', track);
  if (date) params.set('date', date);
  const qs = params.toString();
  return fetch(`/api/parse/ml-pdf${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: file,
  }).then(asJson);
}
export const mergeParses = (ml, program, correlationId) =>
  fetch('/api/parse/merge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ ml, program }),
  }).then(asJson);
export const fetchMlSheet = (track, date, correlationId) =>
  fetch('/api/fetch/ml-sheet', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ track, date }),
  }).then(asJson);

// dmtc results page (D42).
export const parseResultsHtml = (html, correlationId) =>
  fetch('/api/parse/results-html', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ html }),
  }).then(asJson);
export const resultsFromArchive = (dayId, correlationId) =>
  fetch(`/api/race-days/${dayId}/results/from-archive`, {
    method: 'POST',
    headers: { ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
  }).then(asJson);

// Backfill queue (D43): the review queue for batch-ingested days.
export const getBackfillQueue = () => fetch('/api/backfill/queue').then(asJson);
export const getBackfillItem = (id) => fetch(`/api/backfill/queue/${id}`).then(asJson);
export const confirmBackfillItem = (id, note) =>
  fetch(`/api/backfill/queue/${id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) }).then(asJson);
export const rejectBackfillItem = (id, note) =>
  fetch(`/api/backfill/queue/${id}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) }).then(asJson);

// Human cards (D54): paste parser preview/lock/pass for one race.
export const previewHumanCard = (dayId, race, text, cardId, correlationId) =>
  fetch(`/api/race-days/${dayId}/human-cards/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ race, text, cardId }),
  }).then(asJson);
export const lockHumanCard = (dayId, { race, text, pass, bankrollCents, cardId }, correlationId) =>
  fetch(`/api/race-days/${dayId}/human-cards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ race, text, pass, bankrollCents, cardId }),
  }).then(asJson);

// LLM cards (D63): per-race preview (calls the model) + confirm/save, and
// the per-race request log (reasoning + raw response).
export const previewLlmCard = (dayId, race, cardId, correlationId) =>
  fetch(`/api/race-days/${dayId}/llm-cards/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ race, cardId }),
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
export const getReplayRace = (dayId, race, cardId) =>
  fetch(`/api/replay/days/${dayId}/races/${race}${cardId ? `?cardId=${cardId}` : ''}`).then(asJson);
export const revealClassification = (cardId) =>
  fetch(`/api/replay/cards/${cardId}/reveal-classification`, { method: 'POST' }).then(asJson);
export const revealReplayRace = (cardId, race) =>
  fetch(`/api/replay/cards/${cardId}/races/${race}/reveal`, { method: 'POST' }).then(asJson);
export const closeReplayCard = (cardId) =>
  fetch(`/api/replay/cards/${cardId}/close`, { method: 'POST' }).then(asJson);
export const getReplaySummary = (cardId) => fetch(`/api/replay/cards/${cardId}/summary`).then(asJson);
export const getReplayStanding = (meet) => {
  const q = meet && meet !== 'all' ? `?meet=${encodeURIComponent(meet)}` : '';
  return fetch(`/api/replay/standing${q}`).then(asJson);
};

// Distributions (D20): losing days, drawdown, single-ticket dependence, per bucket.
export const getDistribution = (engineVersion, meet) => {
  const q = new URLSearchParams();
  if (engineVersion) q.set('engineVersion', engineVersion);
  if (meet && meet !== 'all') q.set('meet', meet);
  const qs = q.toString();
  return fetch(`/api/distribution${qs ? `?${qs}` : ''}`).then(asJson);
};
