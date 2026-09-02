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
