// The static-payload shape (D150, redesigned to v4 by D329): a bundle of one
// or more race days, each carrying its entries AND every card on it,
// including grades, for the GitHub Pages read-only viewer (D236 removed
// construction; this is the schema for what replaces it).
//
// PURE and browser-safe - no `node:` import, ever. Two callers share this
// file so the shape can only be defined once:
//   * scripts/build-static-payload.js  builds a payload at home,
//   * the static app (static/src/) reads one in the browser.
//
// WHAT IS DELIBERATELY NOT HASHED, per day, and why:
//   * `generatedAt` (top-level) - a build stamp. Hashing it would make every
//     rebuild a different payload and defeat the whole check.
//   * `cards` / `grades` - the hash answers "did this day's ENTRIES change,"
//     not "did the historical record on top of them change." A card being
//     regraded, or a note being corrected, should not move the hash any more
//     than adding an unrelated day to the same bundle should - see below.
//
// THE HASH IS PER DAY, not over the whole bundle. Bundling a second day into
// a redeploy must not change the hash of a day that did not itself change -
// a bundle-wide hash would fail that on every single redeploy that adds or
// drops a day, which defeats the point of a stable per-day fingerprint.

export const STATIC_PAYLOAD_SCHEMA = 'betsheet.static-payload';
export const STATIC_PAYLOAD_SCHEMA_VERSION = 4;

/**
 * Deterministic JSON: object keys sorted, arrays kept in order, no
 * whitespace. JSON.stringify alone is NOT deterministic across builders -
 * it preserves insertion order, so two rows selected by different queries
 * can serialize differently while being equal.
 *
 * `undefined` is dropped exactly as JSON.stringify drops it, so an absent
 * key and an explicitly-undefined one hash the same; `null` is a value and
 * is kept, since "no morning line" is a fact worth hashing.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** The slice of ONE day's entry a day's own `payloadHash` covers - that day's race day and races, and nothing else. */
export function hashedRegion(day) {
  return {
    schema: STATIC_PAYLOAD_SCHEMA,
    schemaVersion: STATIC_PAYLOAD_SCHEMA_VERSION,
    raceDay: day.raceDay,
    races: day.races,
  };
}

/** The exact text a day's `payloadHash` is the sha256 of. Callers hash this string as UTF-8. */
export function canonicalPayloadText(day) {
  return canonicalJson(hashedRegion(day));
}

// Markup has no business in a payload: parsing happens at home and the
// browser receives structured data only (D150 hard constraint). This catches
// a raw-HTML field landing in the payload by accident. Walked over the WHOLE
// payload, not just the hashed region - v4's card theses/rationales/notes
// are free text that could smuggle markup and weren't covered before.
const MARKUP_RE = /<\s*\/?\s*(?:html|head|body|div|span|table|tr|td|th|script|style|a|p|br|img|meta|link)\b|<!DOCTYPE/i;

function walkStrings(value, path, visit) {
  if (typeof value === 'string') { visit(value, path); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, visit);
  }
}

function validateDay(day, at, problems) {
  const bad = (message) => problems.push(`${at}: ${message}`);

  if (typeof day?.payloadHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(day.payloadHash)) {
    bad('payloadHash is missing or is not a "sha256:<64 hex>" string');
  }

  const rd = day?.raceDay;
  if (!rd || typeof rd !== 'object') { bad('raceDay is missing'); return; }
  if (!Number.isSafeInteger(rd.raceDayId) || rd.raceDayId <= 0) bad('raceDay.raceDayId is not a positive integer');
  if (!rd.track) bad('raceDay.track is empty');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rd.date ?? ''))) bad(`raceDay.date is not YYYY-MM-DD: ${JSON.stringify(rd.date)}`);
  // meet is null for every track but Del Mar (shared/track-codes.js) - an
  // absent meet is a fact, not a gap, so only a wrong TYPE is a problem.
  if (rd.meet !== null && typeof rd.meet !== 'string') bad('raceDay.meet must be a string or null');
  // timezone is the ONE new raceDay field in v4 - the browser's calendar
  // needs it to place a race on the Pacific grid and must never carry the
  // track registry itself to derive it (shared/race-calendar.js's own rule).
  if (rd.timezone !== null && typeof rd.timezone !== 'string') bad('raceDay.timezone must be a string or null');

  const raceNumbers = new Set();
  if (!Array.isArray(day.races) || day.races.length === 0) { bad('races is missing or empty'); }
  else {
    for (const race of day.races) {
      const raceAt = `${at} race ${race?.number}`;
      if (!Number.isSafeInteger(race?.number) || race.number <= 0) { bad(`${raceAt}: number is not a positive integer`); continue; }
      if (raceNumbers.has(race.number)) bad(`${raceAt}: duplicate race number`);
      raceNumbers.add(race.number);
      if (!Array.isArray(race.entries) || race.entries.length === 0) { bad(`${raceAt}: entries is missing or empty`); continue; }
      const pgms = new Set();
      for (const e of race.entries) {
        // snake_case is NOT a slip: the shape the DB itself uses, so a
        // reader that already understands DB-shaped entries needs no
        // adapter that could drift.
        if (typeof e?.program_number !== 'string' || !e.program_number) { bad(`${raceAt}: an entry has no program_number`); continue; }
        if (pgms.has(e.program_number)) bad(`${raceAt}: duplicate program number ${e.program_number}`);
        pgms.add(e.program_number);
        if (typeof e.horse_name !== 'string' || !e.horse_name) bad(`${raceAt}: #${e.program_number} has no horse_name`);
        if (typeof e.scratched !== 'boolean') bad(`${raceAt}: #${e.program_number} scratched must be a boolean`);
      }
    }
  }

  // Cards/tickets/allocations are deliberately SNAKE_CASE, matching the DB
  // shape `client/src/components/CardSheet.jsx` (D237) already reads
  // directly - the same "carry the shape the consuming code already
  // expects" reasoning as the entries above, applied to the whole card.
  if (day.cards !== undefined) {
    if (!Array.isArray(day.cards)) { bad('cards must be an array'); }
    else {
      for (const c of day.cards) {
        const cAt = `${at} card ${c?.id}`;
        if (c?.id == null) { bad(`${cAt}: id is missing`); continue; }
        if (!Array.isArray(c.tickets)) { bad(`${cAt}: tickets is missing`); continue; }
        for (const t of c.tickets) {
          const tAt = `${cAt} ticket ${t?.sequence}`;
          if (!Number.isSafeInteger(t?.sequence)) bad(`${tAt}: sequence is not an integer`);
          if (typeof t?.bet_type !== 'string' || !t.bet_type) bad(`${tAt}: bet_type is missing`);
          if (!Array.isArray(t?.selections?.legs)) bad(`${tAt}: selections.legs is missing`);
          if (!Array.isArray(t?.selections?.races)) bad(`${tAt}: selections.races is missing`);
          if (!Number.isSafeInteger(t?.cost_cents)) bad(`${tAt}: cost_cents is not an integer`);
          if (typeof t?.teller_call !== 'string' || !t.teller_call) bad(`${tAt}: teller_call is missing`);
        }
        if (!Array.isArray(c.allocations)) { bad(`${cAt}: allocations is missing`); }
        else {
          for (const a of c.allocations) {
            if (!raceNumbers.has(a?.race_number)) bad(`${cAt}: allocation references race ${a?.race_number}, not on this day`);
          }
        }
        if (c.grades !== null && c.grades !== undefined) {
          if (!Array.isArray(c.grades.rows) || typeof c.grades.summary === 'undefined') {
            bad(`${cAt}: grades must be null or {rows, summary}`);
          }
        }
      }
    }
  }
}

/**
 * Structural validation of a payload, as a list of problems (empty = valid).
 * Never throws - same contract as every parser in this codebase.
 *
 * Deliberately does NOT check any day's `payloadHash` against its content: a
 * caller that wants that recomputes `canonicalPayloadText` per day and
 * compares, because only the caller knows whether it has the hashing
 * primitive to hand.
 */
export function validateStaticPayload(payload) {
  const problems = [];
  const bad = (message) => problems.push(message);

  if (!payload || typeof payload !== 'object') { bad('payload is not an object'); return problems; }
  if (payload.schema !== STATIC_PAYLOAD_SCHEMA) bad(`schema is ${JSON.stringify(payload.schema)}, expected ${JSON.stringify(STATIC_PAYLOAD_SCHEMA)}`);
  if (payload.schemaVersion !== STATIC_PAYLOAD_SCHEMA_VERSION) bad(`schemaVersion is ${JSON.stringify(payload.schemaVersion)}, expected ${STATIC_PAYLOAD_SCHEMA_VERSION}`);

  if (!Array.isArray(payload.raceDays) || payload.raceDays.length === 0) {
    bad('raceDays is missing or empty');
  } else {
    const seenDayIds = new Set();
    payload.raceDays.forEach((day, i) => {
      const at = `raceDays[${i}]`;
      const id = day?.raceDay?.raceDayId;
      if (id != null) {
        if (seenDayIds.has(id)) bad(`${at}: duplicate raceDayId ${id}`);
        seenDayIds.add(id);
      }
      validateDay(day, at, problems);
    });
  }

  walkStrings(payload, '', (s, path) => {
    if (MARKUP_RE.test(s)) bad(`${path} contains markup - the payload must carry structured data only`);
  });

  return problems;
}
