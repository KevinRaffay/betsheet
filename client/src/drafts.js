// Unlocked ticket drafts for the day-level builder (D102), per (race day, race).
//
// A race you have BUILT but not LOCKED lives only in the modal's React state,
// so Escape, a backdrop click or Close threw the work away - the thing the
// user asked to stop happening. A draft is kept here instead, keyed by day and
// race, and restored the next time the modal opens on that day.
//
// This is card data in localStorage, which `client/src/prefs.js` deliberately
// does not do ("Never card data") - a user decision (2026-09-05) taken with
// the alternative named: the only other honest home is a server-side drafts
// table, and a draft is a scratchpad for one browser, not a record the corpus
// should carry. The boundary that matters is unchanged: a draft NEVER reaches
// the database on its own. It is text, the same text the builder composes, and
// it still has to go through preview -> lock -> the server's own re-parse
// (invariant 9) before a single ticket is stored.
//
// Every read and write is wrapped: localStorage throws outright in some
// contexts (site data blocked, some private modes), and losing a draft must
// never be worse than losing the state we had before this file existed.
const PREFIX = 'betsheet:ticket-draft:v1:';
const keyFor = (dayId, race) => `${PREFIX}${dayId}:${race}`;

const store = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** Every draft stored for one race day, as Map(raceNumber -> {text, savedAt}). */
export function loadDayDrafts(dayId) {
  const out = new Map();
  const ls = store();
  if (!ls) return out;
  const prefix = `${PREFIX}${dayId}:`;
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const race = Number(k.slice(prefix.length));
      if (!Number.isFinite(race)) continue;
      const v = JSON.parse(ls.getItem(k));
      // A draft with no text is not a draft. Anything unreadable is dropped
      // rather than surfaced - a corrupt entry must not break the modal.
      if (v && typeof v.text === 'string' && v.text.trim()) {
        out.set(race, { text: v.text, savedAt: v.savedAt ?? null });
      }
    }
  } catch {
    return out;
  }
  return out;
}

/** Write one race's draft. Blank text clears it - an empty box is not a draft. */
export function saveDraft(dayId, race, text) {
  const ls = store();
  if (!ls) return null;
  try {
    if (!String(text ?? '').trim()) {
      ls.removeItem(keyFor(dayId, race));
      return null;
    }
    const savedAt = new Date().toISOString();
    ls.setItem(keyFor(dayId, race), JSON.stringify({ text, savedAt }));
    return savedAt;
  } catch {
    return null;
  }
}

export function clearDraft(dayId, race) {
  const ls = store();
  if (!ls) return;
  try {
    ls.removeItem(keyFor(dayId, race));
  } catch {
    /* nothing to do - a draft that outlives its lock is harmless */
  }
}
