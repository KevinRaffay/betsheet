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

export const listRaceDays = () => fetch('/api/race-days').then(asJson);
export const getRaceDay = (id) => fetch(`/api/race-days/${id}`).then(asJson);
