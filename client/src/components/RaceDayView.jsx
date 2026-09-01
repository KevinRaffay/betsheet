import React, { useEffect, useState } from 'react';
import { getRaceDay } from '../api.js';

// Read-only view of a stored race day - what actually landed in the
// database, not what the parser proposed.
export default function RaceDayView({ id, onBack }) {
  const [day, setDay] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getRaceDay(id).then(setDay).catch((e) => setError(String(e.message)));
  }, [id]);

  if (error) return <p className="notice notice--error">{error}</p>;
  if (!day) return <p className="placeholder">Loading…</p>;

  return (
    <section>
      <div className="pagehead">
        <h2>{day.track} — {day.date}</h2>
        <button className="btn" onClick={onBack}>Back</button>
      </div>
      <p className="dim">
        Bankroll {day.bankroll_cents != null ? `$${(day.bankroll_cents / 100).toFixed(0)}` : '—'}
        {' '}· per-race min {day.per_race_min_cents != null ? `$${(day.per_race_min_cents / 100).toFixed(0)}` : '—'}
        {' '}· {day.races.length} races
      </p>
      {day.races.map((race) => (
        <details className="race" key={race.id} open>
          <summary>
            <strong>Race {race.number}</strong>
            {' '}· {race.surface ?? '?'} · {race.distance ?? '?'} · {race.race_type ?? '?'}
            {' '}· post {race.post_time ?? '?'}
          </summary>
          {race.conditions && <p className="conditions">{race.conditions}</p>}
          <table className="grid">
            <thead>
              <tr><th>#</th><th>PP</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>Wt</th><th>M/L</th><th>Rank</th></tr>
            </thead>
            <tbody>
              {race.entries.map((e) => (
                <tr key={e.id} className={e.scratched ? 'row--scratched' : ''}>
                  <td>{e.program_number}</td>
                  <td className="dim">{e.post_position ?? ''}</td>
                  <td>
                    {e.horse_name}
                    {e.best_bet ? <span className="tag tag--gold">BEST BET</span> : null}
                    {e.not_to_be_claimed ? <span className="tag">NTC</span> : null}
                    {e.scratched ? <span className="tag tag--red">SCR</span> : null}
                  </td>
                  <td>{e.jockey ?? ''}</td>
                  <td>{e.trainer ?? ''}</td>
                  <td>{e.weight ?? ''}</td>
                  <td>{e.morning_line ?? ''}</td>
                  <td className="dim">{e.program_rank ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {race.wager_menu && <p className="dim wager">{race.wager_menu}</p>}
        </details>
      ))}
    </section>
  );
}
