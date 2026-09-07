// The static-payload shape (D150): everything the GitHub Pages ticket builder
// needs about one race day, and nothing else.
//
// PURE and browser-safe - no `node:` import, ever. Three callers share this
// file so the shape can only be defined once:
//   * scripts/build-static-payload.js  builds a payload at home,
//   * the static app (static/src/) reads one in the browser,
//   * scripts/import-static-cards.js   RE-builds one to verify a returned
//     card was built against the race day this repo still holds.
//
// That third caller is why canonicalization lives here rather than in the
// builder. `payloadHash` is only worth checking if the home side can
// reproduce it byte for byte months later, so the hashed text must be a
// function of the race day alone - never of the clock, of key insertion
// order, or of which optional flags the build used.
//
// WHAT IS DELIBERATELY NOT HASHED, and why:
//   * `generatedAt` - a build stamp. Hashing it would make every rebuild a
//     different payload and defeat the whole check.
//   * `referenceCards` - `--reference-cards` is an OPTIONAL embed (D150), so
//     hashing it would make the hash depend on a build flag the importer has
//     no way to know was used. Contamination is recorded per card instead,
//     by the `sawReferenceCards` stamp the browser sets when a reference card
//     is actually revealed - a fact about one card, which is what it is.
//
// The hash therefore answers exactly one question: are the entries this
// ticket was built against still the entries on file at home?

export const STATIC_PAYLOAD_SCHEMA = 'betsheet.static-payload';

// Tracks server/trace-export.js's SCHEMA_VERSION deliberately (D150 spec:
// "schemaVersion matching the export schema in use") - a payload and the card
// export it produces are two halves of one round trip, and a reader that
// understands one version of the pair understands the other.
export const STATIC_PAYLOAD_SCHEMA_VERSION = 3;

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

/** The slice of a payload `payloadHash` covers - the race day, and only the race day. */
export function hashedRegion(payload) {
  return {
    schema: payload.schema,
    schemaVersion: payload.schemaVersion,
    raceDay: payload.raceDay,
    races: payload.races,
  };
}

/** The exact text `payloadHash` is the sha256 of. Callers hash this string as UTF-8. */
export function canonicalPayloadText(payload) {
  return canonicalJson(hashedRegion(payload));
}

// Markup has no business in a payload: parsing happens at home and the
// browser receives structured data only (D150 hard constraint). This catches
// a raw-HTML field landing in the payload by accident - a `conditions` string
// that still carries a navigation strip, say - rather than trusting that the
// parser upstream always stripped it.
const MARKUP_RE = /<\s*\/?\s*(?:html|head|body|div|span|table|tr|td|th|script|style|a|p|br|img|meta|link)\b|<!DOCTYPE/i;

function walkStrings(value, path, visit) {
  if (typeof value === 'string') { visit(value, path); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, visit);
  }
}

/**
 * Structural validation of a payload, as a list of problems (empty = valid).
 * Never throws - same contract as every parser in this codebase.
 *
 * Deliberately does NOT check `payloadHash` against the content: a caller
 * that wants that recomputes `canonicalPayloadText` and compares, because
 * only the caller knows whether it has the hashing primitive to hand.
 */
export function validateStaticPayload(payload) {
  const problems = [];
  const bad = (message) => problems.push(message);

  if (!payload || typeof payload !== 'object') { bad('payload is not an object'); return problems; }
  if (payload.schema !== STATIC_PAYLOAD_SCHEMA) bad(`schema is ${JSON.stringify(payload.schema)}, expected ${JSON.stringify(STATIC_PAYLOAD_SCHEMA)}`);
  if (payload.schemaVersion !== STATIC_PAYLOAD_SCHEMA_VERSION) bad(`schemaVersion is ${JSON.stringify(payload.schemaVersion)}, expected ${STATIC_PAYLOAD_SCHEMA_VERSION}`);
  if (typeof payload.payloadHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(payload.payloadHash)) {
    bad('payloadHash is missing or is not a "sha256:<64 hex>" string');
  }

  const day = payload.raceDay;
  if (!day || typeof day !== 'object') bad('raceDay is missing');
  else {
    if (!Number.isSafeInteger(day.raceDayId) || day.raceDayId <= 0) bad('raceDay.raceDayId is not a positive integer');
    if (!day.track) bad('raceDay.track is empty');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day.date ?? ''))) bad(`raceDay.date is not YYYY-MM-DD: ${JSON.stringify(day.date)}`);
    // meet is null for every track but Del Mar (shared/track-codes.js) - an
    // absent meet is a fact, not a gap, so only a wrong TYPE is a problem.
    if (day.meet !== null && typeof day.meet !== 'string') bad('raceDay.meet must be a string or null');
  }

  if (!Array.isArray(payload.races) || payload.races.length === 0) bad('races is missing or empty');
  else {
    const seen = new Set();
    for (const race of payload.races) {
      const at = `race ${race?.number}`;
      if (!Number.isSafeInteger(race?.number) || race.number <= 0) { bad(`${at}: number is not a positive integer`); continue; }
      if (seen.has(race.number)) bad(`${at}: duplicate race number`);
      seen.add(race.number);
      if (!Array.isArray(race.entries) || race.entries.length === 0) { bad(`${at}: entries is missing or empty`); continue; }
      const pgms = new Set();
      for (const e of race.entries) {
        // snake_case is NOT a slip: shared/parsers/human-picks.js reads
        // `program_number` / `horse_name` off these rows directly, so the
        // payload carries the shape the real parser already takes and the
        // browser needs no adapter that could drift from the server's.
        if (typeof e?.program_number !== 'string' || !e.program_number) { bad(`${at}: an entry has no program_number`); continue; }
        if (pgms.has(e.program_number)) bad(`${at}: duplicate program number ${e.program_number}`);
        pgms.add(e.program_number);
        if (typeof e.horse_name !== 'string' || !e.horse_name) bad(`${at}: #${e.program_number} has no horse_name`);
        if (typeof e.scratched !== 'boolean') bad(`${at}: #${e.program_number} scratched must be a boolean`);
      }
    }
  }

  if (payload.referenceCards !== null && !Array.isArray(payload.referenceCards)) {
    bad('referenceCards must be an array or null');
  }

  walkStrings(hashedRegion(payload), '', (s, path) => {
    if (MARKUP_RE.test(s)) bad(`${path} contains markup - the payload must carry structured data only`);
  });

  return problems;
}
