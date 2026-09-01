import React, { useEffect, useState } from 'react';
import { deleteRaceDay, deletionPreview, getRaceDay } from '../api.js';
import ConsensusPanel from './ConsensusPanel.jsx';
import CardsPanel from './CardsPanel.jsx';

// Read-only view of a stored race day - what actually landed in the
// database, not what the parser proposed.
export default function RaceDayView({ id, onBack, onOpenCard }) {
  const [day, setDay] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null); // deletion-preview counts
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getRaceDay(id).then(setDay).catch((e) => setError(String(e.message)));
  }, [id]);

  const askDelete = async () => {
    setBusy(true);
    try {
      setConfirm(await deletionPreview(id));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await deleteRaceDay(id);
      onBack();
    } catch (e) {
      setError(String(e.message));
      setBusy(false);
    }
  };

  if (error) return <p className="notice notice--error">{error}</p>;
  if (!day) return <p className="placeholder">Loading…</p>;

  return (
    <section>
      <div className="pagehead">
        <h2>{day.track} — {day.date}</h2>
        <div className="formrow formrow--tight">
          <button className="btn btn--danger" disabled={busy} onClick={askDelete}>Delete race day</button>
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>

      {confirm && (
        <div className="notice notice--warn">
          <p>
            <strong>Delete {day.track} {day.date}?</strong> This removes from every
            view: {confirm.races} races, {confirm.entries} entries, picks from{' '}
            {confirm.sources} consensus source{confirm.sources === 1 ? '' : 's'},{' '}
            {confirm.cards} card{confirm.cards === 1 ? '' : 's'} with {confirm.tickets} tickets.
            The decision-trace and fetch-audit logs are kept intact. A deleted
            day can be restored from the race-day list ("Show deleted").
          </p>
          <div className="formrow formrow--tight">
            <button className="btn btn--danger" disabled={busy} onClick={doDelete}>
              Delete it
            </button>
            <button className="btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      <p className="dim">
        Bankroll {day.bankroll_cents != null ? `$${(day.bankroll_cents / 100).toFixed(0)}` : '—'}
        {' '}· per-race min {day.per_race_min_cents != null ? `$${(day.per_race_min_cents / 100).toFixed(0)}` : '—'}
        {' '}· {day.races.length} races
      </p>
      <CardsPanel
        dayId={day.id}
        defaultBankrollCents={day.bankroll_cents}
        defaultPerRaceMinCents={day.per_race_min_cents}
        onOpenCard={onOpenCard}
      />
      <ConsensusPanel dayId={day.id} />
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
