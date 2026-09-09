import { useEffect, useState } from 'react';
import {
  listTipPicks, correctTipPicks, deleteTipPicks,
  getDayTipScoring, previewTipCards, saveTipCards,
} from '../api.js';

// TIPSHEET picks on a stored day (D169): upload a screenshot of a tip app,
// review what the model read, save it, and correct it if it read wrong.
//
// TWO SURFACES, DELIBERATELY SEPARATE - this is invariant 9, not styling.
// The PREVIEW is read-only: it shows exactly what Save will store and offers
// no way to change it, so a save always stores verbatim model output. The
// CORRECTION surface acts on an already-saved row, is explicit, and is
// recorded (picks_extracted keeps the model's original answer forever). A
// vision extraction has no "fix the source and re-parse" path, which is why
// the edit exists at all - but it lives after the save, never inside it.

const oddsOf = (p, key) => (key in p ? p[key] : '');

/**
 * A rate, always with its denominator, and a dash when there isn't one.
 * "No figure without its n" is this project's oldest surviving discipline,
 * and it is enforced here rather than trusted: a rate cannot reach the screen
 * without the count it was computed from.
 */
const pct = (r, n) => (r === null || r === undefined || !n ? '—' : `${Math.round(r * 100)}% of ${n}`);

/** How one race's picks did. Absent until results for that race are on file. */
function ScoreLine({ score }) {
  if (!score) return <p className="dim">Not scored yet — no results on file for this race.</p>;
  const hit = score.win ? 'WON' : score.place ? 'ran 2nd' : score.show ? 'ran 3rd' : 'off the board';
  return (
    <p className="dim">
      Top pick #{score.topPick.horseNo} {hit}
      {score.topPickSubstituted && ' (promoted after a scratch)'}
      {' · '}caught {score.top3Overlap} of the top 3
      {score.winnerProgramNumber && ` · winner was #${score.winnerProgramNumber}`}
      {score.unknownPicks.length > 0
        && ` · ${score.unknownPicks.length} pick(s) not in the result: #${score.unknownPicks.join(', #')}`}
    </p>
  );
}

function PicksTable({ picks }) {
  const anyOdds = picks.some((p) => 'ml_odds' in p || 'live_odds' in p);
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Rank</th><th>#</th><th>Horse</th>
          {anyOdds && <><th>M/L</th><th>Live</th></>}
        </tr>
      </thead>
      <tbody>
        {picks.map((p) => (
          <tr key={`${p.rank}-${p.horse_no}`}>
            <td>{p.rank}</td>
            <td>{p.horse_no}</td>
            <td>{p.horse_name || <span className="dim">(no name)</span>}</td>
            {anyOdds && <><td>{oddsOf(p, 'ml_odds') || '—'}</td><td>{oddsOf(p, 'live_odds') || '—'}</td></>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The correction surface. Edits a SAVED row, never a preview.
 *
 * The picks go back through the server's own validator, so a hand-typed
 * ranking cannot be something the extraction itself would have refused - a
 * duplicated rank or the same horse twice is rejected here exactly as it is
 * on the way in from the model.
 */
function CorrectRow({ row, onDone, onCancel }) {
  const [draft, setDraft] = useState(() => row.picks.map((p) => ({
    rank: String(p.rank), horse_no: p.horse_no, horse_name: p.horse_name ?? '',
    ml_odds: oddsOf(p, 'ml_odds'), live_odds: oddsOf(p, 'live_odds'),
  })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [warnings, setWarnings] = useState([]);

  const edit = (i, field, value) =>
    setDraft((d) => d.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  const removeAt = (i) => setDraft((d) => d.filter((_, j) => j !== i));
  const addRow = () => setDraft((d) => [...d, {
    rank: String(d.length + 1), horse_no: '', horse_name: '', ml_odds: '', live_odds: '',
  }]);

  const submit = async () => {
    setBusy(true); setError(null); setWarnings([]);
    // Blank odds are OMITTED, never sent as null - the server treats absence
    // as "the sheet did not show a price", which is not the same as zero.
    const picks = draft.map((r) => ({
      rank: Number(r.rank), horse_no: r.horse_no.trim(), horse_name: r.horse_name.trim(),
      ...(r.ml_odds.trim() ? { ml_odds: r.ml_odds.trim() } : {}),
      ...(r.live_odds.trim() ? { live_odds: r.live_odds.trim() } : {}),
    }));
    try {
      const res = await correctTipPicks(row.id, picks);
      setWarnings(res.warnings ?? []);
      onDone(res.saved);
    } catch (err) {
      setError(err.message);
      setWarnings(err.body?.warnings ?? []);
    } finally { setBusy(false); }
  };

  return (
    <div className="tip-edit">
      <p className="dim">
        Correcting what the model read. The original extraction is kept either way,
        so this row stays comparable against the screenshot it came from.
        Leave an odds box EMPTY when the sheet shows no price - blank means &ldquo;not shown&rdquo;,
        and is not the same as a zero. Prices may be written <code>9-2</code> or <code>9/2</code>.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {warnings.length > 0 && (
        <div className={warnings.some((w) => w.blocking) ? 'notice notice--error' : 'notice notice--warn'}>
          <ul>
            {warnings.map((w, i) => <li key={i}>{w.blocking ? 'Blocking: ' : ''}{w.message}</li>)}
          </ul>
        </div>
      )}
      <table className="grid">
        <thead>
          <tr><th>Rank</th><th>#</th><th>Horse</th><th>M/L</th><th>Live</th><th /></tr>
        </thead>
        <tbody>
          {draft.map((r, i) => (
            <tr key={i}>
              <td><input className="in in--sm" value={r.rank} onChange={(e) => edit(i, 'rank', e.target.value)} /></td>
              <td><input className="in in--sm" value={r.horse_no} onChange={(e) => edit(i, 'horse_no', e.target.value)} /></td>
              <td><input className="in" value={r.horse_name} onChange={(e) => edit(i, 'horse_name', e.target.value)} /></td>
              <td><input className="in in--sm" aria-label="morning line" value={r.ml_odds} onChange={(e) => edit(i, 'ml_odds', e.target.value)} /></td>
              <td><input className="in in--sm" aria-label="live odds" value={r.live_odds} onChange={(e) => edit(i, 'live_odds', e.target.value)} /></td>
              <td><button type="button" className="btn btn--sm" onClick={() => removeAt(i)}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="formrow">
        <button type="button" className="btn btn--sm" onClick={addRow}>Add a pick</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : 'Save correction'}
        </button>
      </div>
    </div>
  );
}

/**
 * `onSaved` remounts the sibling CardsPanel (D173). Staking writes THREE cards
 * that CardsPanel cannot know about - it self-fetches on mount - so without
 * this the cards appear only after a page reload, exactly the defect D142
 * fixed for the Equibase OTR panel.
 */
export default function TipPicksPanel({ dayId, races = [], onSaved = () => {} }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [staking, setStaking] = useState(null);
  const scoreFor = (id) => scoring?.races?.find((r) => r.id === id)?.score ?? null;

  const [scoring, setScoring] = useState(null);
  const reload = async () => {
    try {
      setRows((await listTipPicks(dayId)).rows);
      setScoring(await getDayTipScoring(dayId));
    } catch (err) { setError(err.message); }
  };
  // The loader is called inside a block body: handing a promise-returning
  // function straight to useEffect stores the PROMISE as the cleanup, and
  // React calls it on unmount - which blanks the whole app. See Gotchas.
  useEffect(() => { reload(); }, [dayId]);

  const remove = async (row) => {
    setError(null);
    try { await deleteTipPicks(row.id); await reload(); } catch (err) { setError(err.message); }
  };

  return (
    <details className="race">
      <summary>Tip sheet picks</summary>
      <p className="dim">
        Ranked picks from a third-party tip sheet, typed per race with
        <strong> Enter tipsheet picks</strong> on the race above. Kept in its own TIPSHEET bucket -
        never pooled with your own cards, the LLM&apos;s or Equibase&apos;s.
      </p>
      {error && <p className="notice notice--error">{error}</p>}

      {/* D171: stake a source's picks into three comparable cards. Preview
          writes nothing; Save appends three cards, never edits earlier ones. */}
      {[...new Set(rows.map((r) => r.sourceLabel))].map((src) => (
        <div className="formrow" key={`stake-${src}`}>
          <button type="button" className="btn btn--sm" disabled={busy}
            onClick={async () => {
              setBusy(true); setError(null);
              try { setStaking(await previewTipCards(dayId, src)); }
              catch (err) { setError(err.message); } finally { setBusy(false); }
            }}>
            Stake {src} into cards
          </button>
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

      <h3>On file ({rows.length})</h3>
      {rows.length === 0 && <p className="dim">No tip sheets read for this day yet.</p>}
      {rows.map((row) => (
        <details key={row.id} className="race">
          <summary>
            Race {row.raceNo} — {row.sourceLabel} ({row.picks.length} picks)
            {row.edited && <span className="tag" title={`Corrected ${row.editedAt}`}> corrected</span>}
          </summary>
          {editing === row.id ? (
            <CorrectRow
              row={row}
              onCancel={() => setEditing(null)}
              onDone={async () => { setEditing(null); await reload(); }}
            />
          ) : (
            <>
              <PicksTable picks={row.picks} />
              {row.picksExtracted && (
                <details>
                  <summary className="dim">What the model originally read</summary>
                  <PicksTable picks={row.picksExtracted} />
                </details>
              )}
              <ScoreLine score={scoreFor(row.id)} />
              <div className="formrow">
                <button type="button" className="btn btn--sm btn--danger" onClick={() => remove(row)}>Delete</button>
                <button type="button" className="btn btn--sm" onClick={() => setEditing(row.id)}>Correct</button>
              </div>
            </>
          )}
        </details>
      ))}
    </details>
  );
}
