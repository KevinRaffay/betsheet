import { useState } from 'react';
import { previewTipCards, saveTipCards } from '../api.js';

// D171/D174, relocated by D182, one button since D183: turn the day's tip
// sheets into graded cards, in three comparable variants per source.
//
// THIS IS THE ONE PART OF THE TIPSHEET FEATURE THAT IS NOT PER-RACE, and it
// is structural rather than a layout preference: `planTipCards` sizes every
// ticket from `perRaceBankrollCents(bankroll, racesWithPicks.length)`, so the
// price of race 1's ticket depends on how many OTHER races have picks. Adding
// a fourth race re-prices the first three. A per-race "stake this race"
// button could not honour that - it would have to invent a denominator - so
// staking stays a day-level act while REVIEWING a sheet lives in the race
// panel it belongs to (RaceTipPicks.jsx).
//
// **"ALL" IS A CONVENIENCE, NEVER A MERGE.** D183 replaced one button per
// source with a single one, and that changes only how many clicks it takes:
// each source is still previewed and saved through its OWN per-source call,
// and still gets its OWN three cards carrying its OWN `tip_source_label`.
// Pooling two sources into one card set would break invariant 13 outright -
// TrackMaster agreeing with NumberFire is the thing being measured, so a card
// that cannot say which sheet picked it answers nothing.
//
// `rows` is passed in rather than fetched: RaceDayView already loads the
// day's tip rows for the per-race panels, and a second copy here could
// disagree with them about which sources exist.

/**
 * `onSaved` remounts the sibling CardsPanel (D173). Staking writes cards that
 * CardsPanel cannot know about - it self-fetches on mount - so without this
 * they appear only after a page reload, exactly the defect D142 fixed for the
 * Equibase OTR panel.
 */
export default function TipStakingPanel({ dayId, rows = [], onSaved = () => {} }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // One preview PER SOURCE, in a stable order - never one merged plan.
  const [plans, setPlans] = useState(null);
  const [outcomes, setOutcomes] = useState(null);

  const sources = [...new Set(rows.map((r) => r.sourceLabel))].sort();
  const racesFor = (src) => new Set(rows.filter((r) => r.sourceLabel === src).map((r) => r.raceNo)).size;

  const anyUpdate = plans?.some((p) => p.variants.some((v) => v.willUpdate));
  const anyRegrade = plans?.some((p) => p.variants.some((v) => v.willRegrade));

  /**
   * Previews every source, one call each, SEQUENTIALLY - so a failure names
   * the source it came from and the order on screen is always the same.
   */
  const previewAll = async () => {
    setBusy(true); setError(null); setOutcomes(null);
    const got = [];
    try {
      for (const src of sources) got.push(await previewTipCards(dayId, src));
      setPlans(got);
    } catch (err) {
      setError(`Preview failed after ${got.length} of ${sources.length} sources: ${err.message}`);
      // Keep whatever previewed cleanly - a second source being unstakeable
      // must not hide the first one's plan.
      if (got.length) setPlans(got);
    } finally { setBusy(false); }
  };

  /**
   * Saves each source in turn. A source that fails does NOT stop the others:
   * every save is its own transaction server-side, and D174 makes a re-stake
   * update rather than duplicate, so the safe remedy is always "fix it and
   * press the button again". Every source's outcome is reported by name -
   * "some of it worked" is never left as something to infer from the cards
   * table.
   */
  const saveAll = async () => {
    setBusy(true); setError(null);
    const results = [];
    for (const plan of plans) {
      try {
        await saveTipCards(dayId, plan.sourceLabel);
        results.push({ sourceLabel: plan.sourceLabel, ok: true });
      } catch (err) {
        results.push({ sourceLabel: plan.sourceLabel, ok: false, message: err.message });
      }
    }
    setOutcomes(results);
    setBusy(false);
    if (results.some((r) => r.ok)) { setPlans(null); onSaved(); }
  };

  return (
    <section className="consensus">
      <h3>Stake tip sheets into cards</h3>
      {error && <p className="notice notice--error">{error}</p>}

      {sources.length === 0 && <p className="dim">No tip sheets on this day yet.</p>}

      {sources.length > 0 && (
        <>
          <div className="formrow">
            <button type="button" className="btn btn--sm" disabled={busy} onClick={previewAll}>
              Stake all tip sheets into cards
            </button>
            <span className="dim">
              {sources.length} source{sources.length === 1 ? '' : 's'}: {sources.join(', ')}
            </span>
          </div>
          {/* Each source keeps its own cards. Said out loud because one button
              reads like one card set, and invariant 13 turns on it not being. */}
          <p className="dim">
            Each source is staked separately and keeps its own cards — they are never pooled,
            so a card can always say which sheet picked it.
          </p>
        </>
      )}

      {outcomes && (
        <div className={outcomes.every((o) => o.ok) ? 'notice' : 'notice notice--warn'}>
          <ul>
            {outcomes.map((o) => (
              <li key={o.sourceLabel}>
                <strong>{o.sourceLabel}</strong>: {o.ok ? 'cards saved' : `not saved — ${o.message}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {plans && (
        <div className="tip-edit">
          <p className="dim">
            Three cards per source, one per way of betting the same picks, so backtesting can say
            which structure is worth it. Bankroll ${(plans[0].bankrollCents / 100).toFixed(2)}.
            Nothing is written until you save.
          </p>
          {/* D174: ONE card per source per variant. Re-staking after another
              race's picks arrive UPDATES those cards - it does not add three
              more - and re-prices every race, since the per-race budget is
              the bankroll split across the races that have picks. */}
          {anyUpdate && (
            <p className="notice">
              Some of these sources already have cards on this day. Saving <strong>updates</strong> them to
              cover every race with picks — it does not add more — and re-prices every race, because the
              per-race budget is the bankroll split across the races that have picks.
            </p>
          )}
          {anyRegrade && (
            <p className="notice notice--warn">
              Some of those cards are already <strong>graded</strong>. Saving replaces their tickets, so their
              grades are discarded and a reported P/L figure will move. There is no way back from here.
            </p>
          )}

          {plans.map((plan) => (
            <div className="tip-source" key={plan.sourceLabel}>
              <p className="dim">
                <strong>{plan.sourceLabel}</strong> · {racesFor(plan.sourceLabel)} race
                {racesFor(plan.sourceLabel) === 1 ? '' : 's'} with picks
              </p>
              {/* No total across variants, and none across sources: the three
                  variants are mutually exclusive ways to bet the same picks,
                  and adding them up is exactly the D175 bug that reported
                  ~$598 wagered against a $200 bankroll. */}
              <table className="grid">
                <thead><tr><th>Variant</th><th>Tickets</th><th>Cost</th><th>Card</th></tr></thead>
                <tbody>
                  {plan.variants.map((v) => (
                    <tr key={v.variant}>
                      <td>{v.label}</td>
                      <td>{v.races.reduce((n, r) => n + r.tickets.length, 0)}</td>
                      <td>${(v.costCents / 100).toFixed(2)}</td>
                      <td>{v.willUpdate ? `updates #${v.existingCardId}${v.willRegrade ? ' (graded)' : ''}` : 'new'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.variants.flatMap((v) => v.races.flatMap((r) => r.warnings.filter((w) => w.blocking)
                .map((w, i) => ({ ...w, label: v.label, raceNo: r.raceNo, key: `${v.variant}-${r.raceNo}-${i}` })))).length > 0 && (
                <div className="notice notice--error">
                  <ul>
                    {plan.variants.flatMap((v) => v.races.flatMap((r) => r.warnings.filter((w) => w.blocking)
                      .map((w, i) => (
                        <li key={`${v.variant}-${r.raceNo}-${i}`}>{v.label}, race {r.raceNo}: {w.message}</li>
                      ))))}
                  </ul>
                </div>
              )}
            </div>
          ))}

          <div className="formrow">
            <button type="button" className="btn" onClick={() => setPlans(null)} disabled={busy}>Discard</button>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={saveAll}>
              {busy ? 'Saving…' : anyUpdate ? 'Update cards for every source' : 'Save cards for every source'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
