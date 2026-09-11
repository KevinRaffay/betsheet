import React, { useEffect, useRef, useState } from 'react';
import { bulkDeleteRaceDays, listRaceDays, resetAppApi, restoreRaceDay } from '../api.js';
import PublishStaticSnapshotModal from './PublishStaticSnapshotModal.jsx';

const SKIP_REASON_LABEL = {
  graded: 'already graded',
  already_deleted: 'already deleted',
  not_found: 'no longer exists',
  write_failed: 'delete did not persist',
};

export default function RaceDayList({ onOpen, onNew, onPL, onDistribution, onSources, onReplay, onCalendar, refreshKey }) {
  const [days, setDays] = useState(null);
  const [error, setError] = useState(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dateFilter, setDateFilter] = useState('');
  const [trackFilter, setTrackFilter] = useState('');
  // Bulk-select (checkbox column, active-days view only). A graded day's
  // checkbox is disabled in the table below, but that's a convenience -
  // the server refuses to delete a graded day regardless of what gets sent.
  const [selected, setSelected] = useState(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const selectAllRef = useRef(null);
  const [showPublish, setShowPublish] = useState(false);

  const reload = (deleted = showDeleted) =>
    listRaceDays(deleted).then(setDays).catch((e) => setError(String(e.message)));

  // Guarded against a superseded response landing last: toggling twice quickly
  // fires two fetches, and without this the FIRST one's answer can arrive after
  // the second's and overwrite it - which reads as "No deleted race days" on a
  // list of 75. Latent until the active list could be empty, because a stale
  // active response used to still render a plausible table. The cleanup returns
  // a function, never a promise (see the useEffect rule in CLAUDE.md's Gotchas).
  useEffect(() => {
    let cancelled = false;
    listRaceDays(showDeleted)
      .then((d) => { if (!cancelled) setDays(d); })
      .catch((e) => { if (!cancelled) setError(String(e.message)); });
    return () => { cancelled = true; };
  }, [refreshKey, showDeleted]);

  // The checkbox column only exists in the active-days view - drop any
  // selection when switching into (or out of) "Show deleted" rather than
  // carrying stale ids nothing on screen can act on.
  useEffect(() => {
    setSelected(new Set());
    setConfirmBulk(false);
    setBulkResult(null);
  }, [showDeleted]);

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleRestore = async (id) => {
    setBusy(true);
    try {
      await restoreRaceDay(id);
      await reload();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const [confirmReset, setConfirmReset] = useState(false);
  const [resetDone, setResetDone] = useState(null);
  const handleReset = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await resetAppApi();
      setConfirmReset(false);
      setResetDone(out);
      await reload();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const dateOptions = days ? [...new Set(days.map((d) => d.date))].sort().reverse() : [];
  const trackOptions = days ? [...new Set(days.map((d) => d.track))].sort() : [];
  const filteredDays = (days || []).filter(
    (d) => (!dateFilter || d.date === dateFilter) && (!trackFilter || d.track === trackFilter)
  );
  // "Select all" only ever reaches ungraded rows CURRENTLY VISIBLE under the
  // date/track filter - it must never reach into a row the filter is hiding.
  const selectableIds = filteredDays.filter((d) => !d.graded).map((d) => d.id);
  const allSelectableSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someSelectableSelected = selectableIds.some((id) => selected.has(id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelectableSelected && !allSelectableSelected;
    }
  }, [someSelectableSelected, allSelectableSelected]);

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelectableSelected) selectableIds.forEach((id) => next.delete(id));
      else selectableIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const handleBulkDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await bulkDeleteRaceDays([...selected]);
      setBulkResult(result);
      setSelected(new Set());
      setConfirmBulk(false);
      await reload();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const selectedDays = (days || []).filter((d) => selected.has(d.id));

  return (
    <section>
      <div className="pagehead">
        <h2>{showDeleted ? 'Deleted race days' : 'Race days'}</h2>
        <div className="formrow formrow--tight">
          {!showDeleted && <button className="btn" onClick={onPL}>P/L</button>}
          {!showDeleted && <button className="btn" onClick={onDistribution}>Distributions</button>}
          {!showDeleted && <button className="btn" onClick={onSources}>Pick sources</button>}
          {!showDeleted && <button className="btn" onClick={onReplay}>Replay</button>}
          {!showDeleted && <button className="btn" onClick={onCalendar}>Race calendar</button>}
          {!showDeleted && <button className="btn" onClick={() => setShowPublish(true)}>Publish snapshot</button>}
          <button className="btn" onClick={() => setShowDeleted((v) => !v)}>
            {showDeleted ? 'Show active' : 'Show deleted'}
          </button>
          {!showDeleted && (
            <button
              className="btn btn--danger"
              disabled={selected.size === 0 || busy}
              onClick={() => setConfirmBulk(true)}
            >
              Delete selected ({selected.size})
            </button>
          )}
          {!showDeleted && <button className="btn btn--primary" onClick={onNew}>New race day</button>}
        </div>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      {confirmBulk && (
        <div className="notice notice--warn">
          <p>
            <strong>Delete {selectedDays.length} race day{selectedDays.length === 1 ? '' : 's'}?</strong>
            {' '}{selectedDays.map((d) => `${d.track} ${d.date}`).join(', ')}.
            {' '}Each is a soft delete - restorable from "Show deleted" - and a graded day is
            refused automatically even if it were somehow selected.
          </p>
          <div className="formrow formrow--tight">
            <button className="btn btn--danger" disabled={busy} onClick={handleBulkDelete}>
              Delete them
            </button>
            <button className="btn" disabled={busy} onClick={() => setConfirmBulk(false)}>Cancel</button>
          </div>
        </div>
      )}
      {bulkResult && (
        <p className="notice">
          Deleted {bulkResult.deleted.length} race day{bulkResult.deleted.length === 1 ? '' : 's'}.
          {bulkResult.skipped.length > 0 && (
            <>
              {' '}{bulkResult.skipped.length} not deleted: {bulkResult.skipped.map((s) =>
                `${s.track ? `${s.track} ${s.date}` : `#${s.id}`} (${SKIP_REASON_LABEL[s.reason] ?? s.reason})`,
              ).join(', ')}.
            </>
          )}
        </p>
      )}
      {days && days.length > 0 && (
        <div className="formrow formrow--tight">
          <label>
            Date{' '}
            <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}>
              <option value="">All</option>
              {dateOptions.map((date) => (
                <option key={date} value={date}>{date}</option>
              ))}
            </select>
          </label>
          <label>
            Track{' '}
            <select value={trackFilter} onChange={(e) => setTrackFilter(e.target.value)}>
              <option value="">All</option>
              {trackOptions.map((track) => (
                <option key={track} value={track}>{track}</option>
              ))}
            </select>
          </label>
          {(dateFilter || trackFilter) && (
            <button className="btn" onClick={() => { setDateFilter(''); setTrackFilter(''); }}>
              Clear filters
            </button>
          )}
        </div>
      )}
      {days && days.length === 0 && (
        <p className="placeholder">
          {showDeleted
            ? 'No deleted race days.'
            : 'Nothing stored yet. Upload a saved Equibase entries page to create a race day, or paste the entries text.'}
        </p>
      )}
      {days && days.length > 0 && filteredDays.length === 0 && (
        <p className="placeholder">No race days match the selected filters.</p>
      )}
      {days && filteredDays.length > 0 && (
        <table className={`grid ${showDeleted ? '' : 'grid--click'}`}>
          <thead>
            <tr>
              {!showDeleted && (
                <th>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelectableSelected}
                    disabled={selectableIds.length === 0}
                    onClick={(e) => e.stopPropagation()}
                    onChange={toggleSelectAll}
                  />
                </th>
              )}
              <th>Date</th><th>Track</th><th>Races</th><th>Entries</th><th>Bankroll</th><th>Graded</th>
              <th>{showDeleted ? 'Deleted' : 'Stored'}</th>
              {showDeleted && <th></th>}
            </tr>
          </thead>
          <tbody>
            {filteredDays.map((d) => (
              <tr key={d.id} onClick={showDeleted ? undefined : () => onOpen(d.id)}>
                {!showDeleted && (
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(d.id)}
                      disabled={Boolean(d.graded)}
                      title={d.graded ? 'Graded race days cannot be bulk-deleted.' : undefined}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelect(d.id)}
                    />
                  </td>
                )}
                <td>{d.date}</td>
                <td>{d.track}</td>
                <td>{d.races}</td>
                <td>{d.entries}</td>
                <td>{d.bankroll_cents != null ? `$${(d.bankroll_cents / 100).toFixed(0)}` : '—'}</td>
                <td>{d.graded ? 'Yes' : '—'}</td>
                <td className="dim">{showDeleted ? d.deleted_at : d.created_at}</td>
                {showDeleted && (
                  <td>
                    <button className="btn" disabled={busy} onClick={() => handleRestore(d.id)}>
                      Restore
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!showDeleted && (
        <div className="danger-zone">
          {resetDone && (
            <p className="notice">
              Reset complete — {Object.values(resetDone.rowsRemoved).reduce((a, n) => a + n, 0)} rows
              and {resetDone.logFilesRemoved} log file{resetDone.logFilesRemoved === 1 ? '' : 's'} removed.
              Clean slate.
            </p>
          )}
          {!confirmReset ? (
            <button className="btn btn--danger" disabled={busy} onClick={() => { setResetDone(null); setConfirmReset(true); }}>
              Reset app…
            </button>
          ) : (
            <div className="notice notice--warn">
              <p>
                <strong>Factory reset.</strong> This permanently deletes EVERY stored
                record — race days (deleted ones included), entries, consensus picks,
                cards, tickets, results, templates — <strong>and every log file</strong>,
                decision traces and fetch audits included. Nothing is recoverable.
                For a clean testing slate only.
              </p>
              <div className="formrow formrow--tight">
                <button className="btn btn--danger" disabled={busy} onClick={handleReset}>
                  Wipe everything
                </button>
                <button className="btn" disabled={busy} onClick={() => setConfirmReset(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {showPublish && days && (
        // `days` is already the active (non-deleted) list here - the button
        // only renders when `!showDeleted` - so invariant 12's exclusion is
        // inherited for free rather than re-checked.
        <PublishStaticSnapshotModal days={days} onClose={() => setShowPublish(false)} />
      )}
    </section>
  );
}
