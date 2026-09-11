import React, { useState } from 'react';
import { publishStaticPayload } from '../api.js';

// D336: a UI trigger for `npm run build-static-payload`, so choosing which
// days go into the GitHub Pages read-only viewer's snapshot no longer
// requires a terminal. WYSIWYG by design over the CLI's --from/--to/--track
// resolution: the request always carries the exact `dayIds` the checkboxes
// show checked, never a date range re-resolved server-side, so there is no
// way for what you selected to disagree with what gets published.
//
// `days` is the SAME active (non-deleted) list RaceDayList already loaded -
// invariant 12's exclusion of soft-deleted days is therefore inherited for
// free, and this modal makes no fetch of its own until Publish is clicked.
export default function PublishStaticSnapshotModal({ days, onClose }) {
  const [dateFilter, setDateFilter] = useState('');
  const [trackFilter, setTrackFilter] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const dateOptions = [...new Set(days.map((d) => d.date))].sort().reverse();
  const trackOptions = [...new Set(days.map((d) => d.track))].sort();
  const filteredDays = days.filter(
    (d) => (!dateFilter || d.date === dateFilter) && (!trackFilter || d.track === trackFilter),
  );
  const filteredIds = filteredDays.map((d) => d.id);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filteredIds.forEach((id) => next.delete(id));
      else filteredIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const selectedDays = days.filter((d) => selected.has(d.id));

  const handlePublish = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await publishStaticPayload({ dayIds: [...selected] });
      setResult(out);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => { if (!busy) onClose(); };

  return (
    // House rule (D131-D133): a modal-backdrop never closes its dialog on
    // click - no onClick here, ever. Only the header's x closes it.
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Publish static snapshot">
        <div className="modal__header">
          <h3>Publish static snapshot</h3>
          <button className="modal__close" onClick={handleClose} aria-label="Close">×</button>
        </div>
        <div className="modal__body">
          {!result && (
            <>
              <p className="dim">
                Bundles the selected race days - their entries AND every card on them, including
                grades - into <code>static/public/payload.json</code>, the file the GitHub Pages
                read-only viewer reads. Every card and grade on a selected day is included
                unconditionally, because showing the cards that exist is the whole point of that
                app.
              </p>
              <p className="notice notice--warn">
                This only writes the file on this machine. It does <strong>not</strong> commit,
                push, or deploy anything - and a Pages site is publicly readable even from a
                private repo, so nothing here should be committed and pushed without meaning to
                make those days' cards and grades public.
              </p>

              {error && <p className="notice notice--error">{error}</p>}

              <div className="formrow formrow--tight">
                <label>
                  Date{' '}
                  <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}>
                    <option value="">All</option>
                    {dateOptions.map((date) => <option key={date} value={date}>{date}</option>)}
                  </select>
                </label>
                <label>
                  Track{' '}
                  <select value={trackFilter} onChange={(e) => setTrackFilter(e.target.value)}>
                    <option value="">All</option>
                    {trackOptions.map((track) => <option key={track} value={track}>{track}</option>)}
                  </select>
                </label>
                {(dateFilter || trackFilter) && (
                  <button className="btn" onClick={() => { setDateFilter(''); setTrackFilter(''); }}>
                    Clear filters
                  </button>
                )}
              </div>

              {filteredDays.length === 0 && <p className="placeholder">No race days match the selected filters.</p>}

              {filteredDays.length > 0 && (
                <table className="grid">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          checked={allFilteredSelected}
                          onChange={toggleAllFiltered}
                        />
                      </th>
                      <th>Date</th><th>Track</th><th>Races</th><th>Entries</th><th>Graded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDays.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                        </td>
                        <td>{d.date}</td>
                        <td>{d.track}</td>
                        <td>{d.races}</td>
                        <td>{d.entries}</td>
                        <td>{d.graded ? 'Yes' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {result && (
            <>
              <p className="notice">
                Wrote <code>{result.path}</code> at {result.generatedAt} — {result.days.length} race
                day{result.days.length === 1 ? '' : 's'}. Commit and push that file (and redeploy, if
                using GitHub Pages) to publish it.
              </p>
              <table className="grid">
                <thead>
                  <tr><th>Date</th><th>Track</th><th>Races</th><th>Cards</th><th>Graded</th><th>Hash</th></tr>
                </thead>
                <tbody>
                  {result.days.map((d) => (
                    <tr key={d.raceDayId}>
                      <td>{d.date}</td>
                      <td>{d.track}</td>
                      <td>{d.races}</td>
                      <td>{d.cards}</td>
                      <td>{d.graded}</td>
                      <td className="dim" title={d.payloadHash}>{d.payloadHash.slice(0, 15)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        <div className="modal__footer">
          {!result ? (
            <>
              <button className="btn" disabled={busy} onClick={handleClose}>Cancel</button>
              <button
                className="btn btn--primary"
                disabled={busy || selectedDays.length === 0}
                onClick={handlePublish}
              >
                {busy ? 'Publishing…' : `Publish selected (${selectedDays.length})`}
              </button>
            </>
          ) : (
            <button className="btn btn--primary" onClick={handleClose}>Done</button>
          )}
        </div>
      </div>
    </div>
  );
}
