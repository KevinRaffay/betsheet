// Display formatting shared by the static app's own screens (D364).
//
// Deliberately NOT imported from client/ or shared/: the static app reaches
// outside static/ in exactly five places (CLAUDE.md, D168 gotcha) and a
// two-line money formatter is not worth a sixth. CardSheet.jsx carries its
// own identical `money` for the same reason in the other direction.

export const money = (cents) => (cents == null ? '—'
  : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

/** Signed P/L: "+$12" / "−$4.50" (U+2212 MINUS, so the column lines up). */
export const signedMoney = (cents) => (cents == null ? '—'
  : `${cents >= 0 ? '+' : '−'}${money(Math.abs(cents))}`);

export const plClass = (cents) => (cents == null ? 'dim' : cents >= 0 ? 'pl--pos' : 'pl--neg');

/** "2026-09-11" -> "Fri, Sep 11, 2026", the way emubets.com prints a meeting date. */
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return String(iso ?? '');
  // Noon UTC so no viewer zone can roll the date back a day.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(d);
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
