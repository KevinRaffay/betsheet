// Source labels (D167): the ONE place this codebase answers "who said this".
//
// PURE and browser-safe - no `node:` import, ever. Imported by the server
// (llm-notes, tip-extraction) and by the client (AnalystNotesEditor), which is
// the whole point: before this module the notes vocabulary lived in a .jsx and
// the server could not see, enforce or even name it.
//
// THE TWO CATALOGUES ARE NOT MERGED, AND THAT IS DELIBERATE. They answer
// different questions, and flattening them into one list would be a lie:
//
//   NOTE_SOURCE_LABELS answers WHAT KIND of commentary this is - `program`,
//   `public-handicapper`, `llm`, `own`. It is a taxonomy of provenance.
//
//   TIP_SOURCE_LABELS answers WHICH APP published a ranked pick set -
//   `trackmaster`, `numberfire`. It is a list of named publishers.
//
// `trackmaster` is a publisher that BELONGS TO the kind `public-handicapper`;
// they are two axes, not two halves of one axis. What they must share is the
// FORM of a label (one lowercase slug) and the single function that produces
// it - which is what this module makes impossible to have two of, and what
// D125 (five copies of `nameKey`), D135 (three copies of the entries table)
// and D159 (two copies of the notes editor) each had to be written to undo.

/** What kind of commentary a note is. Offered by the notes editor's datalist. */
export const NOTE_SOURCE_LABELS = ['program', 'public-handicapper', 'llm', 'own'];

/** Which app published a ranked pick set (D166). */
export const TIP_SOURCE_LABELS = ['trackmaster', 'numberfire', 'equibase-tipsheet', 'tipsheet-other'];

/**
 * The two fallbacks stay SEPARATE, because they mean different things.
 *
 * A note with no label is a note the USER wrote - that is the honest default
 * for a box someone left blank in their own notes editor, and it is what
 * `loadNotesForRace` has always recorded. A tip sheet with no identifiable
 * source is not "the user's" anything; it is a published sheet whose publisher
 * could not be read, which is a different fact and gets a different word.
 * Collapsing them would make an unreadable screenshot look like the user's own
 * opinion, which is exactly the kind of mislabelling invariant 13 exists to
 * prevent.
 */
export const NOTES_SOURCE_FALLBACK = 'user';
export const TIP_SOURCE_FALLBACK = 'tipsheet-other';

/** Spellings that mean an entry already in a catalogue above. */
const SOURCE_ALIASES = {
  'track master': 'trackmaster', tm: 'trackmaster', 'trackmaster picks': 'trackmaster',
  'number fire': 'numberfire', nf: 'numberfire',
  equibase: 'equibase-tipsheet', eqb: 'equibase-tipsheet',
  other: 'tipsheet-other', unknown: 'tipsheet-other',
  'my own': 'own', mine: 'own', me: 'own',
  handicapper: 'public-handicapper', 'public handicapper': 'public-handicapper',
};

/**
 * A free-text source name -> one stable lowercase slug for grouping.
 *
 * ONE implementation, for every table with a `source_label` column. Snapping
 * happens on the way IN rather than by refusing an unknown name, because the
 * alternative is losing a source you are standing in front of at a racetrack.
 * An unrecognized name therefore keeps its OWN slug - countable, and
 * promotable into a catalogue later - and only genuinely empty input reaches
 * the fallback.
 *
 * `fallback` is a parameter rather than a constant precisely because the two
 * callers need different ones (see above). Passing none yields '' for empty
 * input, which lets a caller keep storing NULL rather than inventing a label.
 */
export function normalizeSourceLabel(raw, fallback = '') {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if (SOURCE_ALIASES[s]) return SOURCE_ALIASES[s];
  const slug = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return fallback;
  return SOURCE_ALIASES[slug] ?? slug;
}

/** True when normalizing this value would change it - the inertness probe. */
export const isNormalizedSourceLabel = (raw) =>
  raw === null || raw === undefined || normalizeSourceLabel(raw) === String(raw);
