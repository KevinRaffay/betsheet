// Track name canonicalization (D35): every ingest path hands the save layer
// whatever spelling it parsed - the program panel letters read "DELMAR", the
// Bottom Line header fallback "Del Mar", the Equibase chart header "DEL MAR",
// a track's own footer credit "DelMarRacing.com". Comparing those as plain
// text let the same track land as two different `race_days` rows (D31/D53
// root cause). `canonicalizeTrack` maps every known spelling to one code +
// display name; an unrecognized track still gets a derived code (never a
// block - invariant 3's "missing detail warns, never blocks" spirit) so it
// can still be saved and compared consistently.
//
// Pure - browser + Node, no I/O. The registry is Del Mar-only today; a new
// track gets a new entry here, not a special case at a call site.

const REGISTRY = [
  { code: 'DMR', display: 'Del Mar', aliases: ['DELMARRACINGCOM'] },
];

const lettersOnly = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '');

/**
 * `raw` -> { code, display, recognized }. `display` is the canonical name to
 * store/show for a recognized track, or the trimmed input as typed for an
 * unrecognized one. `code` is always present (derived for the unrecognized
 * case) so every comparison - the one-day-per-track+date rule, the results
 * chart mismatch refusal - can key on it.
 */
export function canonicalizeTrack(raw) {
  const key = lettersOnly(raw);
  const trimmed = String(raw ?? '').trim();
  if (!key) return { code: null, display: trimmed, recognized: false };
  for (const t of REGISTRY) {
    if (key === lettersOnly(t.display) || t.aliases.some((a) => key === a)) {
      return { code: t.code, display: t.display, recognized: true };
    }
  }
  return { code: key.slice(0, 3) || 'UNK', display: trimmed, recognized: false };
}

// ---------- meets ----------
//
// Relocated here from server/dmtc-crawler.js by D113, which deleted that
// file. `race_days.meet` (D43) is still written at save and is still the
// dimension the P/L and Distributions meet selectors filter on, so the
// derivation had to survive the crawler that happened to define it. This is
// its natural home: it is a fact about a track and a date, which is what this
// module already owns.
//
// Del Mar runs two meets a year and nothing else does, so a non-Del Mar day
// simply has no meet - null, never a guessed label. A second track that runs
// named meets gets a registry entry here, the same way a new track spelling
// does, rather than a call-site special case.
const DMR = 'DMR';

/** `DMR-<year>-summer` (Jul-Sep) or `-fall` (Oct-Dec); null outside those months. */
export function meetFor(date) {
  const m = String(date).match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month >= 7 && month <= 9) return `${DMR}-${m[1]}-summer`;
  if (month >= 10 && month <= 12) return `${DMR}-${m[1]}-fall`;
  return null;
}

/** meetFor() for a Del Mar day (any spelling - canonicalizeTrack handles it), null for other tracks. */
export function meetForDay(track, date) {
  return canonicalizeTrack(track).code === DMR ? meetFor(date) : null;
}
