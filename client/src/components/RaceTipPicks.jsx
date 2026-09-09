import { useState } from 'react';
import { correctTipPicks, deleteTipPicks } from '../api.js';

// D182: ONE race's tip sheets, rendered inside that race's own panel - the
// same shape RaceNotes.jsx has for analyst notes, and for the same reason: a
// tip sheet is an opinion about a RACE, so it belongs beside that race's
// entries rather than in a day-level list you have to scroll to and then
// re-read the race number out of.
//
// TWO SURFACES, DELIBERATELY SEPARATE - this is invariant 9, not styling.
// A save stores verbatim what the sheet said; CORRECTING is a separate,
// later, recorded act on an already-saved row (`picks_extracted` keeps the
// first version forever, `edited_at` stamps it). That distinction is why the
// correction editor lives here and never inside an entry surface.
//
// STAKING IS NOT HERE, and that is deliberate: it splits the day's bankroll
// across every race that has picks (`perRaceBankrollCents`), so it cannot be
// expressed one race at a time. It stays day-level in TipStakingPanel.jsx.

const oddsOf = (p, key) => (key in p ? p[key] : '');

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

/** How this race's picks did. Absent until results for the race are on file. */
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

/**
 * The correction surface. Edits a SAVED row, never a preview.
 *
 * The picks go back through the server's own validator, so a hand-typed
 * ranking cannot be something the entry path itself would have refused - a
 * duplicated rank or the same horse twice is rejected here exactly as it is
 * on the way in.
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
        Correcting a saved sheet. The original is kept either way, so this row stays
        comparable against what was first entered for it.
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
 * `rows` is only THIS race's tip rows, already filtered by the caller, and
 * `scoreFor` looks a row's score up by its id. Both are passed in rather than
 * fetched here: `RaceDayView` renders one of these per race and a fetch per
 * race would be one request per race for data that arrives in a single
 * day-level call.
 *
 * `onChanged` tells the day to refetch after a correction or a delete - the
 * staking panel's source list is derived from the same rows, so a race
 * losing its last sheet has to be visible there too.
 */
export default function RaceTipPicks({ rows = [], scoreFor = () => null, onEnter, onChanged = () => {} }) {
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);

  const remove = async (row) => {
    setError(null);
    try { await deleteTipPicks(row.id); onChanged(); } catch (err) { setError(err.message); }
  };

  return (
    <details className="race-tips">
      <summary>
        Tip sheets{rows.length === 0 ? ' — none' : ` (${rows.length})`}
      </summary>
      {error && <p className="notice notice--error">{error}</p>}
      <div className="formrow formrow--tight">
        <button type="button" className="btn btn--sm" onClick={onEnter}>
          {rows.length === 0 ? 'Enter tipsheet picks' : 'Enter / edit tipsheet picks'}
        </button>
      </div>
      {rows.length === 0 && (
        <p className="dim">
          No tip sheets for this race. Ranked picks are kept in their own TIPSHEET bucket -
          never pooled with your own cards, the LLM&apos;s or Equibase&apos;s.
        </p>
      )}
      {rows.map((row) => (
        <div className="tip-source" key={row.id}>
          <p className="dim">
            <strong>{row.sourceLabel}</strong> · {row.picks.length} picks
            {row.edited && <span className="tag" title={`Corrected ${row.editedAt}`}> corrected</span>}
          </p>
          {editing === row.id ? (
            <CorrectRow
              row={row}
              onCancel={() => setEditing(null)}
              onDone={() => { setEditing(null); onChanged(); }}
            />
          ) : (
            <>
              <PicksTable picks={row.picks} />
              {row.picksExtracted && (
                <details>
                  <summary className="dim">What was originally read</summary>
                  <PicksTable picks={row.picksExtracted} />
                </details>
              )}
              <ScoreLine score={scoreFor(row.id)} />
              <div className="formrow formrow--tight">
                <button type="button" className="btn btn--sm" onClick={() => setEditing(row.id)}>Correct</button>
                <button type="button" className="btn btn--sm btn--danger" onClick={() => remove(row)}>Delete</button>
              </div>
            </>
          )}
        </div>
      ))}
    </details>
  );
}
