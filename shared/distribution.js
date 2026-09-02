// Distribution reporting (D20): how the P/L is SHAPED, not just its total -
// the share of losing days, the deepest peak-to-trough drawdown of the
// running P/L, and how dependent each day was on a single ticket.
// PURE (browser + Node). Invariant 13 rules this file exactly as it rules
// P/L: every figure lives inside its consensus_completeness bucket and
// nothing here pools buckets. Engine versions and meets are the caller's
// selection - one card row per day per bucket.
//
// Single-ticket dependence is reported two ways (user decision 2026-09-02):
//   gross = top ticket's returned cents / the day's total returned cents
//           (refunds included - the grader's topTicketShare)
//   net   = the ticket with the largest NET (returned - cost) / the day's net profit,
//           on WINNING days only (a losing day depends on nothing)
// The flag (> 0.8) is driven by NET: on 2026-08-28 gross was 40% while net
// was 77% - the gross figure hides refunds and small winners.

export const BUCKET_ORDER = ['FULL', 'PARTIAL', 'PROGRAM_ONLY', 'ODDS_ONLY', 'HUMAN'];
export const DEPENDENCE_THRESHOLD = 0.8;

/**
 * One day's dependence figures from its graded tickets:
 * tickets: [{ costCents, returnedCents, plCents, betType?, races?, outcome? }].
 */
export function dependenceFor(tickets) {
  const costCents = tickets.reduce((a, t) => a + t.costCents, 0);
  const returnedCents = tickets.reduce((a, t) => a + t.returnedCents, 0);
  const plCents = returnedCents - costCents;
  // Refunds (returned == cost, outcome refund) are neither a win nor a
  // loss: they inflate "returned" without earning anything.
  const refundedCents = tickets.filter((t) => t.outcome === 'refund').reduce((a, t) => a + t.costCents, 0);
  // Two top tickets: by gross return (the grader's view - a refund can be
  // the largest 'returned' line of the day) and by NET, which is what the
  // dependence question is really about.
  let top = null; let topNet = null;
  for (const t of tickets) {
    if (!top || t.returnedCents > top.returnedCents) top = t;
    if (!topNet || (t.returnedCents - t.costCents) > (topNet.returnedCents - topNet.costCents)) topNet = t;
  }
  const grossShare = returnedCents > 0 && top ? top.returnedCents / returnedCents : 0;
  const winning = plCents > 0;
  const netShare = winning && topNet ? Math.max(0, topNet.returnedCents - topNet.costCents) / plCents : null;
  const describe = (t) => (t ? { betType: t.betType ?? null, races: t.races ?? null, sequence: t.sequence ?? null, costCents: t.costCents, returnedCents: t.returnedCents, plCents: t.returnedCents - t.costCents } : null);
  return {
    costCents, returnedCents, plCents, refundedCents, winning,
    topTicket: describe(top), topNetTicket: describe(topNet),
    grossShare, netShare,
    flagged: netShare != null && netShare > DEPENDENCE_THRESHOLD,
  };
}

/**
 * Peak-to-trough drawdown of a running P/L series ([{ date, plCents }] in
 * date order). Returns the deepest one: cents, the peak's and trough's dates
 * and values, and how many days it spanned. A series that never falls has a
 * zero drawdown.
 */
export function maxDrawdown(series) {
  let running = 0; let peak = 0; let peakDate = null; let peakIndex = -1;
  let worst = { cents: 0, fromDate: null, toDate: null, days: 0, peakCents: 0, troughCents: 0 };
  series.forEach((row, i) => {
    running += row.plCents;
    if (running > peak || peakIndex < 0) { peak = running; peakDate = row.date; peakIndex = i; }
    const dd = peak - running;
    if (dd > worst.cents) worst = { cents: dd, fromDate: peakDate, toDate: row.date, days: i - peakIndex, peakCents: peak, troughCents: running };
  });
  return worst;
}

/**
 * The distribution report. `dayRows`: one per day per bucket -
 * [{ raceDayId, date, track, meet?, cardId?, completeness, engineVersion?, tickets: [...] }]
 * in any order. Returns per-bucket figures + per-day rows; no all-bucket total.
 */
export function distributionFor(dayRows) {
  const byBucket = new Map();
  const ordered = [...dayRows].sort((a, b) => a.date.localeCompare(b.date) || (a.raceDayId ?? 0) - (b.raceDayId ?? 0));
  const days = [];
  for (const row of ordered) {
    const dep = dependenceFor(row.tickets ?? []);
    const day = { raceDayId: row.raceDayId, date: row.date, track: row.track ?? null, meet: row.meet ?? null, cardId: row.cardId ?? null, completeness: row.completeness, engineVersion: row.engineVersion ?? null, ...dep };
    days.push(day);
    if (!byBucket.has(row.completeness)) byBucket.set(row.completeness, { completeness: row.completeness, days: 0, losingDays: 0, winningDays: 0, flatDays: 0, costCents: 0, returnedCents: 0, plCents: 0, refundedCents: 0, flaggedNet: 0, flaggedGross: 0, series: [] });
    const b = byBucket.get(row.completeness);
    b.days++; b.costCents += dep.costCents; b.returnedCents += dep.returnedCents; b.plCents += dep.plCents; b.refundedCents += dep.refundedCents;
    if (dep.plCents < 0) b.losingDays++; else if (dep.plCents > 0) b.winningDays++; else b.flatDays++;
    if (dep.flagged) b.flaggedNet++;
    if (dep.grossShare > DEPENDENCE_THRESHOLD) b.flaggedGross++;
    b.series.push({ raceDayId: row.raceDayId, date: row.date, plCents: dep.plCents, runningCents: b.plCents });
  }
  const buckets = BUCKET_ORDER.filter((k) => byBucket.has(k)).map((k) => {
    const b = byBucket.get(k);
    return {
      ...b,
      losingDayPct: b.days ? b.losingDays / b.days : 0,
      maxDrawdown: maxDrawdown(b.series),
      dependence: { threshold: DEPENDENCE_THRESHOLD, winningDays: b.winningDays, flaggedNet: b.flaggedNet, flaggedGross: b.flaggedGross, flaggedNetPct: b.winningDays ? b.flaggedNet / b.winningDays : 0 },
      meanDayPlCents: b.days ? Math.round(b.plCents / b.days) : 0,
    };
  });
  return { buckets, days };
}
