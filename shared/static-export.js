// The export document a phone hands back to the home database (D152), and
// the validation D153's import runs over it.
//
// PURE and browser-safe. Shared so the writer and the reader cannot drift:
// the static app builds these, scripts/import-static-cards.js reads them, and
// a field renamed on one side fails loudly on the other instead of quietly
// importing nothing.
//
// WHY IT IS NOT LITERALLY A CARD-TRACE EXPORT. It uses schemaVersion 3 and the
// same vocabulary as `betsheet.card-trace-export` (template / engineVersion /
// consensusCompleteness / llmInputs), and a reader who knows one knows this.
// But it carries its OWN schema name because three sections of a real card
// export cannot honestly exist here:
//
//   * `trace` / `traceStatus` are read back from the decision-trace LOG FILES
//     by correlation id. A browser has no log files. Emitting `traceStatus:
//     'missing'` would be a lie in the precise sense that matters - "missing"
//     means the trace was lost, not that it was never written. The import
//     writes the real trace events at home, where the log lives.
//   * `gradeSummary` / `results` require the day's chart. The static app never
//     reads or writes a grade.
//   * `id` is a device-namespaced STRING here, not the integer AUTOINCREMENT
//     `cards.id`. The local row id is minted on import; this one is the
//     idempotency key that makes re-importing the same file safe.
//
// `llmInputs` IS carried, always as `null`, and null is the honest value: it
// means "unknown / not an LLM card" in the card-trace-export schema too, and
// a HUMAN card's export from the desktop is null for exactly the same reason.
// It is never `[]` - the export code on the server side never emits that, and
// neither does this.

export const STATIC_EXPORT_SCHEMA = 'betsheet.static-card-export';
export const STATIC_EXPORT_SCHEMA_VERSION = 3;

/** Every card built here is a HUMAN card. These three are not configurable and not inferred. */
export const STATIC_CARD_FACTS = Object.freeze({
  template: 'human',
  consensusCompleteness: 'HUMAN',
  engineVersion: 'human',
  builtOn: 'static-web',
});

const isIsoish = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s);

/** One stored card -> its export document. The race-day identity rides on the wrapper, not here. */
export function cardToExport(card) {
  return {
    ...STATIC_CARD_FACTS,
    cardId: card.cardId,
    deviceId: card.deviceId,
    name: card.name ?? null,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt ?? card.createdAt,
    bankrollCents: card.bankrollCents ?? null,
    // Whether this card was built with the day's LLM/OTR picks visible (D150).
    // Recorded as fact; nothing buckets on it.
    sawReferenceCards: Boolean(card.sawReferenceCards),
    llmModel: null,
    llmInputs: null,
    races: Object.entries(card.races ?? {})
      .map(([number, r]) => ({ number: Number(number), ...r }))
      .filter((r) => r.lockedAt)
      .sort((a, b) => a.number - b.number)
      .map((r) => ({
        number: r.number,
        lockedAt: r.lockedAt,
        passed: Boolean(r.passed),
        // The TEXT is the record. The home import re-parses it and refuses on
        // any blocking warning (invariant 9) - it never trusts the ticket
        // array below, which is carried only so the two parses can be
        // compared and a disagreement reported rather than silently resolved.
        text: r.passed ? '' : (r.text ?? ''),
        tickets: r.passed ? [] : (r.tickets ?? []),
      })),
  };
}

export function buildStaticExport({ cards, payload, deviceId }) {
  return {
    schema: STATIC_EXPORT_SCHEMA,
    schemaVersion: STATIC_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    builtOn: STATIC_CARD_FACTS.builtOn,
    deviceId,
    raceDayId: payload.raceDay.raceDayId,
    track: payload.raceDay.track,
    date: payload.raceDay.date,
    // What the phone was building against. D153 recomputes the payload from
    // the home database and refuses a mismatch: entries that moved between
    // deploy and import mean the ticket may not mean what it says.
    payloadHash: payload.payloadHash,
    docs: 'docs/trace-schema.md',
    cards: cards.map(cardToExport),
  };
}

/** Problems with an export document, as a list (empty = valid). Never throws. */
export function validateStaticExport(doc) {
  const problems = [];
  const bad = (m) => problems.push(m);

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { bad('the file is not a JSON object'); return problems; }
  if (doc.schema !== STATIC_EXPORT_SCHEMA) bad(`schema is ${JSON.stringify(doc.schema)}, expected ${JSON.stringify(STATIC_EXPORT_SCHEMA)}`);
  if (doc.schemaVersion !== STATIC_EXPORT_SCHEMA_VERSION) bad(`schemaVersion is ${JSON.stringify(doc.schemaVersion)}, expected ${STATIC_EXPORT_SCHEMA_VERSION}`);
  if (!Number.isSafeInteger(doc.raceDayId) || doc.raceDayId <= 0) bad('raceDayId is not a positive integer');
  if (typeof doc.payloadHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(doc.payloadHash)) bad('payloadHash is missing or malformed');
  if (!Array.isArray(doc.cards)) { bad('cards is not an array'); return problems; }
  if (doc.cards.length === 0) bad('the file carries no cards');

  const seen = new Set();
  for (const c of doc.cards) {
    const at = `card ${c?.cardId ?? '(no id)'}`;
    if (typeof c?.cardId !== 'string' || !c.cardId) { bad(`${at}: cardId is missing`); continue; }
    if (seen.has(c.cardId)) bad(`${at}: appears twice in this file`);
    seen.add(c.cardId);

    // The three source facts are checked TOGETHER and all three must say
    // HUMAN. A file claiming template 'human' with engineVersion 'llm' is
    // tampered or hand-edited, and refusing it is cheaper than discovering an
    // LLM card sitting in the HUMAN bucket months later (invariant 13).
    for (const [k, want] of Object.entries(STATIC_CARD_FACTS)) {
      if (c[k] !== want) bad(`${at}: ${k} is ${JSON.stringify(c[k])}, expected ${JSON.stringify(want)}`);
    }
    if (c.llmInputs !== null) bad(`${at}: llmInputs must be null on a HUMAN card`);
    if (c.llmModel != null) bad(`${at}: llmModel must be null on a HUMAN card`);
    if (!isIsoish(c.createdAt)) bad(`${at}: createdAt is not an ISO timestamp`);
    if (typeof c.sawReferenceCards !== 'boolean') bad(`${at}: sawReferenceCards must be a boolean`);

    if (!Array.isArray(c.races)) { bad(`${at}: races is not an array`); continue; }
    const races = new Set();
    for (const r of c.races) {
      const rat = `${at} race ${r?.number}`;
      if (!Number.isSafeInteger(r?.number) || r.number <= 0) { bad(`${rat}: number is not a positive integer`); continue; }
      if (races.has(r.number)) bad(`${rat}: appears twice`);
      races.add(r.number);
      // A lock timestamp is not decoration: invariant 15 derives a card's
      // blindness from picks_locked_at, and it is never a flag a person sets.
      // A race with no honest lock time cannot be imported as a locked race.
      if (!isIsoish(r.lockedAt)) bad(`${rat}: lockedAt is not an ISO timestamp`);
      if (typeof r.passed !== 'boolean') bad(`${rat}: passed must be a boolean`);
      if (!r.passed && !String(r.text ?? '').trim()) bad(`${rat}: a played race carries no ticket text`);
      if (r.passed && String(r.text ?? '').trim()) bad(`${rat}: a PASSED race must carry no ticket text`);
    }
  }
  return problems;
}

/** `betsheet-{raceDayId}-{device}-{timestamp}.json` (D152). */
export function exportFileName(doc) {
  const stamp = String(doc.exportedAt ?? new Date().toISOString()).replace(/[:.]/g, '-').replace(/Z$/, '');
  return `betsheet-${doc.raceDayId}-${doc.deviceId}-${stamp}.json`;
}
