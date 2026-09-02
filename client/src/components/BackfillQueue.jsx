import React, { useEffect, useState } from 'react';
import { confirmBackfillItem, getBackfillItem, getBackfillQueue, rejectBackfillItem } from '../api.js';
import ParsePreview from './ParsePreview.jsx';

// The Backfill queue (D43): days the batch runner would NOT save on its
// own because their parse carried a blocking warning (invariant 9, batch
// policy A). Each item is reviewed in the same read-only preview a
// hand-ingested day gets; Confirm runs the exact commit an auto-save runs
// (day -> results -> card -> grade), Reject records why. Nothing here is
// editable - a wrong parse is fixed at the parser and re-run.
export default function BackfillQueue({ onBack, onOpenDay }) {
  const [queue, setQueue] = useState(null);
  const [item, setItem] = useState(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => getBackfillQueue().then(setQueue).catch((e) => setError(String(e.message)));
  useEffect(() => { load(); }, []);

  const open = async (id) => {
    setBusy(true);
    setError(null);
    try { setItem(await getBackfillItem(id)); setNote(''); } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };
  const decide = async (fn, after) => {
    setBusy(true);
    setError(null);
    try {
      const out = await fn(item.id, note.trim());
      setItem(null);
      await load();
      after?.(out);
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };
  const confirm = () => decide(confirmBackfillItem, (out) => onOpenDay?.(out.raceDayId));
  const reject = () => {
    if (!note.trim()) { setError('A note saying why is required to reject.'); return; }
    decide(rejectBackfillItem);
  };

  if (item) {
    const finishers = item.results?.races?.reduce((a, r) => a + (r.results?.length ?? 0), 0) ?? 0;
    const exotics = item.results?.races?.reduce((a, r) => a + (r.exotics?.length ?? 0), 0) ?? 0;
    const nonBlocking = item.warnings.filter((w) => !item.blocking.some((b) => b.type === w.type && b.message === w.message));
    return (
      <section>
        <div className="pagehead">
          <h2>Backfill queue — {item.date} <span className="dim">· {item.meet ?? 'no meet'} · {item.status}</span></h2>
          <button className="btn" disabled={busy} onClick={() => setItem(null)}>Back to queue</button>
        </div>
        <div className="notice notice--error">
          <strong>{item.blocking.length} blocking warning{item.blocking.length === 1 ? '' : 's'} — the runner did not save this day:</strong>
          <ul>{item.blocking.map((w, i) => <li key={i}><code>{w.type}</code> ({w.source ?? 'entries'}): {w.message}</li>)}</ul>
        </div>
        {nonBlocking.length > 0 && (
          <div className="notice notice--warn">
            <strong>{nonBlocking.length} non-blocking warning{nonBlocking.length === 1 ? '' : 's'}:</strong>
            <ul>{nonBlocking.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
          </div>
        )}
        <p className="dim">
          Read-only preview of exactly what Confirm will store: {item.payload.races.length} races,
          {' '}{item.payload.races.reduce((a, r) => a + r.entries.length, 0)} entries ({item.payload.entriesSource}),
          {' '}bankroll ${(item.payload.bankrollCents / 100).toFixed(2)} / min ${(item.payload.perRaceMinCents / 100).toFixed(2)};
          {' '}results: {item.results?.races?.length ?? 0} races, {finishers} finishers, {exotics} exotic payoffs (dmtc_html)
          {item.chart ? '; Equibase chart archived - cross-source check runs on confirm' : ''}.
          {' '}Confirm saves the day, its results and one card under the current engine version, graded. To correct the parse, fix the parser and re-run the backfill instead.
        </p>
        {error && <p className="notice notice--error">{error}</p>}
        {item.status === 'pending' && (
          <div className="formrow formrow--tight">
            <label>Decision note
              <input className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="why (required to reject)" />
            </label>
            <button className="btn btn--primary" disabled={busy} onClick={confirm}>Confirm and save</button>
            <button className="btn btn--danger" disabled={busy} onClick={reject}>Reject</button>
          </div>
        )}
        <ParsePreview parsed={{ races: item.payload.races, warnings: [] }} />
      </section>
    );
  }

  return (
    <section>
      <div className="pagehead">
        <h2>Backfill queue</h2>
        <button className="btn" onClick={onBack}>Back</button>
      </div>
      <p className="dim">
        Days the batch backfill parsed but did not save: a blocking warning (unparsed distance, race-count mismatch vs the calendar,
        index validation failure, results race-count mismatch, program/ML conflict on program numbers) sends the day here. Review the
        read-only preview and confirm or reject; every decision is recorded and appears in the run report.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      {!queue && !error && <p className="placeholder">Loading…</p>}
      {queue && queue.pending.length === 0 && <p className="placeholder">Nothing pending.</p>}
      {queue && queue.pending.length > 0 && (
        <table className="grid">
          <thead><tr><th>Date</th><th>Meet</th><th>Blocking</th><th>Warnings</th><th>Queued</th><th></th></tr></thead>
          <tbody>
            {queue.pending.map((q) => (
              <tr key={q.id}>
                <td>{q.date}</td>
                <td>{q.meet ?? ''}</td>
                <td>{[...new Set(q.blocking.map((w) => w.type))].join(', ')}</td>
                <td className="dim">{q.blocking.length} blocking / {q.warnings.length - q.blocking.length} other</td>
                <td className="dim">{q.createdAt}</td>
                <td><button className="btn btn--sm" disabled={busy} onClick={() => open(q.id)}>Review</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {queue && queue.decided.length > 0 && (
        <>
          <h3>Decided</h3>
          <table className="grid">
            <thead><tr><th>Date</th><th>Decision</th><th>When</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {queue.decided.map((q) => (
                <tr key={q.id}>
                  <td>{q.date}</td>
                  <td>{q.status}</td>
                  <td className="dim">{q.decidedAt}</td>
                  <td>{q.decisionNote ?? ''}</td>
                  <td>{q.outcome?.raceDayId
                    ? <button className="btn btn--sm" onClick={() => onOpenDay?.(q.outcome.raceDayId)}>Open day</button>
                    : <button className="btn btn--sm" disabled={busy} onClick={() => open(q.id)}>View</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
