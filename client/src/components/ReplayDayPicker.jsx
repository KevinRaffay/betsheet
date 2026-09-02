import React, { useEffect, useState } from 'react';
import { getRandomReplayDay, getReplayDays } from '../api.js';

// Replay (D55) day picker: stored days with results, replayed_at blank =
// unplayed. Default pool is DMR-2025-* meets (more likely forgotten, so
// genuinely blind) - the checkbox widens to every meet.
export default function ReplayDayPicker({ onBack, onOpenDay, onOpenStanding }) {
  const [widen, setWiden] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const pool = widen ? 'all' : 'recent';

  useEffect(() => {
    getReplayDays(pool).then(setData).catch((e) => setError(String(e.message)));
  }, [pool]);

  const handleRandom = async () => {
    setBusy(true);
    setError(null);
    try {
      const day = await getRandomReplayDay(pool);
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
        Play a stored day blind, race by race, then compare against lean on the same day.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      <div className="formrow formrow--tight">
        <button className="btn btn--primary" disabled={busy} onClick={handleRandom}>Random unplayed day</button>
        <label className="dim">
          <input type="checkbox" checked={widen} onChange={(e) => setWiden(e.target.checked)} /> widen to every meet (2026 days are more likely remembered)
        </label>
      </div>
      {!data && <p className="placeholder">Loading…</p>}
      {data && data.days.length === 0 && <p className="placeholder">No stored days with results in this pool.</p>}
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
