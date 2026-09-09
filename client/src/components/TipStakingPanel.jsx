import { useState } from 'react';
import { previewTipCards, saveTipCards } from '../api.js';

// D171/D174, relocated by D182: turn a tip source's ranked picks into graded
// cards, in three comparable variants.
//
// THIS IS THE ONE PART OF THE TIPSHEET FEATURE THAT IS NOT PER-RACE, and it
// is structural rather than a layout preference: `planTipCards` sizes every
// ticket from `perRaceBankrollCents(bankroll, racesWithPicks.length)`, so the
// price of race 1's ticket depends on how many OTHER races have picks. Adding
// a fourth race re-prices the first three. A per-race "stake this race"
// button could not honour that - it would have to invent a denominator - so
// staking stays a day-level act while REVIEWING a sheet moved into the race
// panel it belongs to (RaceTipPicks.jsx).
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
  const [staking, setStaking] = useState(null);

  const sources = [...new Set(rows.map((r) => r.sourceLabel))];
  const racesFor = (src) => new Set(rows.filter((r) => r.sourceLabel === src).map((r) => r.raceNo)).size;

  return (
    <section className="consensus">
      <h3>Stake tip sheets into cards</h3>
      <p className="dim">
        Enter a race&apos;s picks in its own <strong>Tip sheets</strong> panel above. Staking is
        day-level because the per-race stake is the bankroll split across every race that
        has picks — adding a race re-prices the ones already there.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {sources.length === 0 && <p className="dim">No tip sheets on this day yet.</p>}

      {sources.map((src) => (
        <div className="formrow" key={`stake-${src}`}>
          <button type="button" className="btn btn--sm" disabled={busy}
            onClick={async () => {
              setBusy(true); setError(null);
              try { setStaking(await previewTipCards(dayId, src)); }
              catch (err) { setError(err.message); } finally { setBusy(false); }
            }}>
            Stake {src} into cards
          </button>
          <span className="dim">{racesFor(src)} race{racesFor(src) === 1 ? '' : 's'} with picks</span>
        </div>
      ))}

      {staking && (
        <div className="tip-edit">
          <p className="dim">
            <strong>{staking.sourceLabel}</strong> — three cards, one per way of betting the same picks,
            so backtesting can say which structure is worth it. Bankroll ${(staking.bankrollCents / 100).toFixed(2)}.
            Nothing is written until you save.
          </p>
          {/* D174: ONE card per source per variant. Re-staking after another
              race's picks arrive UPDATES those cards - it does not add three
              more - and re-prices every race, since the per-race budget is
              the bankroll split across the races that have picks. */}
          {staking.variants.some((v) => v.willUpdate) && (
            <p className="notice">
              This source already has cards on this day. Saving <strong>updates</strong> them to cover every race
              with picks — it does not add three more — and re-prices every race, because the per-race budget is
              the bankroll split across the races that have picks.
            </p>
          )}
          {staking.variants.some((v) => v.willRegrade) && (
            <p className="notice notice--warn">
              Some of those cards are already <strong>graded</strong>. Saving replaces their tickets, so their
              grades are discarded and a reported P/L figure will move. There is no way back from here.
            </p>
          )}
          <table className="grid">
            <thead><tr><th>Variant</th><th>Tickets</th><th>Cost</th><th>Card</th></tr></thead>
            <tbody>
              {staking.variants.map((v) => (
                <tr key={v.variant}>
                  <td>{v.label}</td>
                  <td>{v.races.reduce((n, r) => n + r.tickets.length, 0)}</td>
                  <td>${(v.costCents / 100).toFixed(2)}</td>
                  <td>{v.willUpdate ? `updates #${v.existingCardId}${v.willRegrade ? ' (graded)' : ''}` : 'new'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {staking.variants.flatMap((v) => v.races.flatMap((r) => r.warnings.map((w) => ({ ...w, v: v.label, r: r.raceNo }))))
            .filter((w) => w.blocking).length > 0 && (
            <div className="notice notice--error">
              <ul>
                {staking.variants.flatMap((v) => v.races.flatMap((r) => r.warnings.filter((w) => w.blocking)
                  .map((w, i) => <li key={`${v.variant}-${r.raceNo}-${i}`}>{v.label}, race {r.raceNo}: {w.message}</li>)))}
              </ul>
            </div>
          )}
          <div className="formrow">
            <button type="button" className="btn" onClick={() => setStaking(null)} disabled={busy}>Discard</button>
            <button type="button" className="btn btn--primary" disabled={busy}
              onClick={async () => {
                setBusy(true); setError(null);
                try { await saveTipCards(dayId, staking.sourceLabel); setStaking(null); onSaved(); }
                catch (err) { setError(err.message); } finally { setBusy(false); }
              }}>
              {busy ? 'Saving…' : staking.variants.some((v) => v.willUpdate) ? 'Update three cards' : 'Save three cards'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
