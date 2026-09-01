import React, { useEffect, useState } from 'react';
import { listRaceDays } from '../api.js';

export default function RaceDayList({ onOpen, onNew, refreshKey }) {
  const [days, setDays] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    listRaceDays().then(setDays).catch((e) => setError(String(e.message)));
  }, [refreshKey]);

  return (
    <section>
      <div className="pagehead">
        <h2>Race days</h2>
        <button className="btn btn--primary" onClick={onNew}>New race day</button>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      {days && days.length === 0 && (
        <p className="placeholder">
          Nothing stored yet. Ingest a program to get started — paste the
          track's entries page or upload the program PDF.
        </p>
      )}
      {days && days.length > 0 && (
        <table className="grid grid--click">
          <thead>
            <tr><th>Date</th><th>Track</th><th>Races</th><th>Entries</th><th>Bankroll</th><th>Stored</th></tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.id} onClick={() => onOpen(d.id)}>
                <td>{d.date}</td>
                <td>{d.track}</td>
                <td>{d.races}</td>
                <td>{d.entries}</td>
                <td>{d.bankroll_cents != null ? `$${(d.bankroll_cents / 100).toFixed(0)}` : '—'}</td>
                <td className="dim">{d.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
