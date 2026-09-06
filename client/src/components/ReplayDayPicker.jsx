import React, { useEffect, useState } from 'react';
import { getRandomReplayDay, getReplayDays } from '../api.js';

// Replay (D55) day picker: every stored day with results, replayed_at
// blank = unplayed.
export default function ReplayDayPicker({ onBack, onOpenDay, onOpenStanding }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getReplayDays().then(setData).catch((e) => setError(String(e.message)));
  }, []);

  const handleRandom = async () => {
    setBusy(true);
    setError(null);
    try {
      const day = await getRandomReplayDay();
      onOpenDay(day.id);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="pagehead">
        <h2>Replay</h2>
        <div className="formrow formrow--tight">
          <button className="btn" onClick={onOpenStanding}>Standing</button>
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>
      <p className="dim">
        Play a stored day blind, race by race, then compare against the other cards on the same day.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      <div className="formrow formrow--tight">
        <button className="btn btn--primary" disabled={busy} onClick={handleRandom}>Random unplayed day</button>
      </div>
      {!data && <p className="placeholder">Loading…</p>}
      {data && data.days.length === 0 && <p className="placeholder">No stored days with results yet.</p>}
      {data && data.days.length > 0 && (
        <table className="grid grid--click">
          <thead>
            <tr><th>Date</th><th>Track</th><th>Meet</th><th>Races</th><th>Replayed</th></tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <tr key={d.id} onClick={() => onOpenDay(d.id)}>
                <td>{d.date}</td>
                <td>{d.track}</td>
                <td className="dim">{d.meet ?? '—'}</td>
                <td>{d.raceCount}</td>
                <td className="dim">{d.replayedAt ? d.replayedAt.slice(0, 10) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
