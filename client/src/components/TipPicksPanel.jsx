import { useEffect, useState } from 'react';
import {
  previewTipPicks, saveTipPicks, listTipPicks, correctTipPicks, deleteTipPicks,
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

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onerror = () => reject(new Error('Could not read that file.'));
  r.onload = () => resolve(String(r.result).replace(/^data:[^;]+;base64,/, ''));
  r.readAsDataURL(file);
});

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

export default function TipPicksPanel({ dayId, races = [] }) {
  const [rows, setRows] = useState([]);
  const [race, setRace] = useState(races[0]?.number ?? 1);
  const [sourceHint, setSourceHint] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);

  const reload = async () => {
    try { setRows((await listTipPicks(dayId)).rows); } catch (err) { setError(err.message); }
  };
  // The loader is called inside a block body: handing a promise-returning
  // function straight to useEffect stores the PROMISE as the cleanup, and
  // React calls it on unmount - which blanks the whole app. See Gotchas.
  useEffect(() => { reload(); }, [dayId]);

  const runPreview = async () => {
    if (!file) return;
    setBusy(true); setError(null); setPreview(null);
    try {
      const imageBase64 = await fileToBase64(file);
      const res = await previewTipPicks(dayId, { race: Number(race), imageBase64, sourceHint });
      setPreview({ ...res, capturedAt: new Date(file.lastModified).toISOString() });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      await saveTipPicks(dayId, {
        race: preview.raceNo, parseToken: preview.parseToken, capturedAt: preview.capturedAt,
      });
      setPreview(null); setFile(null);
      await reload();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    setError(null);
    try { await deleteTipPicks(row.id); await reload(); } catch (err) { setError(err.message); }
  };

  return (
    <details className="race">
      <summary>Tip sheet picks</summary>
      <p className="dim">
        A screenshot of a third-party handicapping app, read into a ranked pick list.
        Kept in its own TIPSHEET bucket - never pooled with your own cards, the LLM&apos;s or Equibase&apos;s.
      </p>
      {error && <p className="notice notice--error">{error}</p>}

      <div className="formrow">
        <label>
          Race{' '}
          <select className="in in--sm" value={race} onChange={(e) => setRace(e.target.value)}>
            {races.map((r) => <option key={r.number} value={r.number}>{r.number}</option>)}
          </select>
        </label>
        <label>
          Source{' '}
          <input
            className="in in--sm" list="tip-sources" placeholder="read from the image"
            value={sourceHint} onChange={(e) => setSourceHint(e.target.value)}
          />
        </label>
        <datalist id="tip-sources">
          <option value="trackmaster" /><option value="numberfire" /><option value="equibase-tipsheet" />
        </datalist>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />
        <button type="button" className="btn btn--primary" onClick={runPreview} disabled={!file || busy}>
          {busy ? 'Reading the screenshot…' : 'Read picks'}
        </button>
      </div>

      {preview && (
        <div className="tip-edit">
          <p className="dim"><strong>Preview — race {preview.raceNo}, {preview.sourceLabel}</strong></p>
          {/* READ-ONLY, on purpose. This shows exactly what Save will store.
              Corrections happen after saving, so the stored row is always
              verbatim model output first (invariant 9). */}
          <p className="dim">
            Read-only. This is exactly what Save will store, verbatim from the model.
            If it read something wrong, save it and then use Correct — the original is kept.
          </p>
          {preview.warnings.length > 0 && (
            <div className={preview.blocking ? 'notice notice--error' : 'notice notice--warn'}>
              <ul>
                {preview.warnings.map((w, i) => <li key={i}>{w.blocking ? 'Blocking: ' : ''}{w.message}</li>)}
              </ul>
            </div>
          )}
          {preview.picks.every((p) => !('ml_odds' in p) && !('live_odds' in p)) && (
            <p className="dim">No odds on this sheet — normal, and not a failed read.</p>
          )}
          <PicksTable picks={preview.picks} />
          {preview.existing && (
            <p className="notice notice--warn">
              Race {preview.raceNo} already has {preview.sourceLabel} picks
              {preview.existing.edited ? ', including a correction you made' : ''}. Saving replaces them.
            </p>
          )}
          <div className="formrow">
            <button type="button" className="btn" onClick={() => setPreview(null)} disabled={busy}>Discard</button>
            <button type="button" className="btn btn--primary" onClick={confirm} disabled={busy || preview.blocking}>
              {busy ? 'Saving…' : 'Save picks'}
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
