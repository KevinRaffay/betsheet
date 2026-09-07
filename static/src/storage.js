// Draft storage for the static ticket builder (D151).
//
// IndexedDB, not localStorage. client/src/drafts.js keeps desktop drafts in
// localStorage and says why that is acceptable there: a draft is a scratchpad
// for one browser, and the real record is a server round trip away. Here
// there is no server. A card built at the track exists NOWHERE else until it
// is exported, so the store has to be the one browsers treat as durable and
// the one `navigator.storage.persist()` actually protects.
//
// Three rules this file exists to enforce:
//
//  1. EVERY MUTATION WRITES. There is no "save" button and no debounce - a
//     card is written on each ticket, each lock, each rename. The failure
//     being designed against is a phone backgrounded and killed at a
//     racetrack, which gives no warning and runs no unload handler.
//
//  2. UNAVAILABLE STORAGE IS FATAL, LOUDLY. `probeStorage` runs before the
//     app renders anything buildable. A private window that accepts writes
//     and drops them at tab close is worse than no app at all: the user would
//     spend an afternoon building cards into a store that evaporates. Better
//     to refuse to start and say so.
//
//  3. PERSISTENCE IS REPORTED HONESTLY. `navigator.storage.persist()` can be
//     refused, and there is no way to force it. When it is refused the header
//     says so, because the correct user response - export more often - is
//     something only the user can choose to do.

const DB_NAME = 'betsheet-static';
const DB_VERSION = 1;
const CARDS = 'cards';
const META = 'meta';

function openIdb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CARDS)) {
        const store = db.createObjectStore(CARDS, { keyPath: 'cardId' });
        // Drafts key on raceDayId, NOT payloadHash (D151): a mid-day redeploy
        // - a scratch corrected at home, a fresh payload pushed - changes the
        // hash, and work in progress must survive that rather than be orphaned
        // behind a key nobody will look up again.
        store.createIndex('byRaceDay', 'raceDayId', { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    req.onblocked = () => reject(new Error('The database is blocked by another open tab.'));
  });
}

let dbPromise = null;
const db = () => {
  if (!dbPromise) dbPromise = openIdb();
  return dbPromise;
};

function tx(store, mode, run) {
  return db().then((conn) => new Promise((resolve, reject) => {
    const t = conn.transaction(store, mode);
    const req = run(t.objectStore(store));
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
    t.onerror = () => reject(t.error ?? new Error('transaction failed'));
    t.oncomplete = () => resolve(req ? req.result : undefined);
  }));
}

/**
 * Can this browser actually keep what we write? Returns
 * `{usable, persisted, reason}` and never throws.
 *
 * `usable: false` is the refuse-to-start case. It is proven by a real
 * write-read-delete round trip rather than by feature detection: Safari's
 * private mode and several locked-down enterprise configurations expose a
 * perfectly good-looking `indexedDB` object that fails on first use.
 */
export async function probeStorage() {
  if (typeof indexedDB === 'undefined') {
    return { usable: false, persisted: false, reason: 'This browser has no IndexedDB, so there is nowhere to keep a card between screens.' };
  }
  try {
    const probe = { key: '__probe', at: Date.now() };
    await tx(META, 'readwrite', (s) => s.put(probe));
    const back = await tx(META, 'readonly', (s) => s.get('__probe'));
    await tx(META, 'readwrite', (s) => s.delete('__probe'));
    if (!back || back.at !== probe.at) {
      return { usable: false, persisted: false, reason: 'Storage accepted a write but did not return it. Cards built here would be lost.' };
    }
  } catch (err) {
    return {
      usable: false,
      persisted: false,
      reason: `Storage is unavailable (${err?.name ?? 'error'}). This is usually a private window or blocked site data - cards built here would be lost when the tab closes.`,
    };
  }

  // Ask for durable storage, then report what we were actually granted. A
  // refusal is not an error and must not stop the app; it is information the
  // user needs, because the remedy (export after every card) is theirs.
  let persisted = false;
  try {
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    if (!persisted && navigator.storage?.persist) persisted = await navigator.storage.persist();
  } catch {
    persisted = false;
  }
  return { usable: true, persisted, reason: null };
}

export const getMeta = (key) => tx(META, 'readonly', (s) => s.get(key)).then((r) => r?.value ?? null);
export const setMeta = (key, value) => tx(META, 'readwrite', (s) => s.put({ key, value }));

/** Every card this device holds for one race day, newest first. */
export async function listCards(raceDayId) {
  const all = await tx(CARDS, 'readonly', (s) => s.getAll());
  return all
    .filter((c) => c.raceDayId === raceDayId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export const getCard = (cardId) => tx(CARDS, 'readonly', (s) => s.get(cardId));

/**
 * Write one card whole. Stamps `updatedAt`, which is what the unexported
 * counter reads.
 *
 * `preserveUpdatedAt` is for RESTORE and only for restore: a card rehydrated
 * from an export file has not been edited, it has been put back, so stamping
 * it "changed just now" would make every restored card read as unexported
 * work the moment it arrived - the opposite of the truth, and a counter that
 * cries wolf is a counter nobody reads.
 */
export function putCard(card, { preserveUpdatedAt = false } = {}) {
  const next = preserveUpdatedAt && card.updatedAt
    ? { ...card }
    : { ...card, updatedAt: new Date().toISOString() };
  return tx(CARDS, 'readwrite', (s) => s.put(next)).then(() => next);
}

export const deleteCard = (cardId) => tx(CARDS, 'readwrite', (s) => s.delete(cardId));

/**
 * A card is UNEXPORTED when it has changed since its last export - never
 * merely "has no export". Re-exporting is free (D153's import dedupes by
 * card id), so the counter is deliberately eager: it would rather prompt one
 * unnecessary export than let a real change leave the building unrecorded.
 */
export const isUnexported = (card) => !card.exportedAt
  || String(card.updatedAt ?? '') > String(card.exportedAt);
