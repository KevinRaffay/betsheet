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
export const getPL = (engineVersion) =>
  fetch(`/api/pl${engineVersion ? `?engineVersion=${encodeURIComponent(engineVersion)}` : ''}`).then(asJson);
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
export const getSimulationCompare = () => fetch('/api/simulations/compare').then(asJson);
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
