// Getting a card OUT of the browser (D152). The one place a download is
// started, so the rolling backup and the explicit Export button cannot
// produce differently-shaped files.
import { buildStaticExport, exportFileName } from '@shared/static-export.js';
import { getCard, putCard } from './storage.js';
import { lockedRaces } from './card.js';

/** Cards worth exporting: a card with no locked race is an empty shell, not work. */
export const exportable = (cards) => cards.filter((c) => lockedRaces(c).length > 0);

/**
 * Build the document and hand it to the browser as a file. Returns the doc.
 *
 * Deliberately fire-and-forget: a download cannot be confirmed from script -
 * there is no event for "the user kept it" - so the app never claims a file
 * was saved, only that it was offered.
 */
export function downloadExport({ cards, payload, deviceId }) {
  const doc = buildStaticExport({ cards, payload, deviceId });
  const blob = new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFileName(doc);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a delay, not synchronously: some mobile browsers have not
  // finished reading the blob by the time click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return doc;
}

/** Stamp exportedAt on each card, re-reading first so a concurrent edit is not clobbered. */
export async function markExported(cards) {
  const at = new Date().toISOString();
  for (const c of cards) {
    const fresh = await getCard(c.cardId);
    if (fresh) await putCard({ ...fresh, exportedAt: at });
  }
}

/**
 * The rolling backup (D152): fire a download after every completed race.
 *
 * This looks profligate and is not. Import dedupes by card id (D153), so a
 * second file naming the same card is a no-op that reports "already present"
 * rather than a duplicate in the graded corpus. That makes each extra file
 * free, and free backups of work that exists in exactly one browser at a
 * racetrack are worth taking every time. A download also survives storage
 * eviction, which IndexedDB explicitly does not.
 *
 * Whole card, not just the race that changed: a superset file is what makes
 * "the newest one wins" true on import.
 */
export async function rollingBackup({ card, payload, deviceId }) {
  if (lockedRaces(card).length === 0) return null;
  const doc = downloadExport({ cards: [card], payload, deviceId });
  await markExported([card]);
  return doc;
}
