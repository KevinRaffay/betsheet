import React, { useEffect, useState } from 'react';
import { listRaceDays, restoreRaceDay } from '../api.js';

export default function RaceDayList({ onOpen, onNew, refreshKey }) {
  const [days, setDays] = useState(null);
  const [error, setError] = useState(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = (deleted = showDeleted) =>
    listRaceDays(deleted).then(setDays).catch((e) => setError(String(e.message)));

  useEffect(() => { reload(); }, [refreshKey, showDeleted]);

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

  return (
    <section>
      <div className="pagehead">
        <h2>{showDeleted ? 'Deleted race days' : 'Race days'}</h2>
        <div className="formrow formrow--tight">
          <button className="btn" onClick={() => setShowDeleted((v) => !v)}>
            {showDeleted ? 'Show active' : 'Show deleted'}
          </button>
          {!showDeleted && <button className="btn btn--primary" onClick={onNew}>New race day</button>}
        </div>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      {days && days.length === 0 && (
        <p className="placeholder">
          {showDeleted
            ? 'No deleted race days.'
            : "Nothing stored yet. Ingest a program to get started — paste the track's entries page or upload the program PDF."}
        </p>
      )}
      {days && days.length > 0 && (
        <table className={`grid ${showDeleted ? '' : 'grid--click'}`}>
          <thead>
            <tr>
              <th>Date</th><th>Track</th><th>Races</th><th>Entries</th><th>Bankroll</th>
              <th>{showDeleted ? 'Deleted' : 'Stored'}</th>
              {showDeleted && <th></th>}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.id} onClick={showDeleted ? undefined : () => onOpen(d.id)}>
                <td>{d.date}</td>
                <td>{d.track}</td>
                <td>{d.races}</td>
                <td>{d.entries}</td>
                <td>{d.bankroll_cents != null ? `$${(d.bankroll_cents / 100).toFixed(0)}` : '—'}</td>
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
    </section>
  );
}
