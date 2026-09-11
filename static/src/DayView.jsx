import React from 'react';
import { navigate } from './app.jsx';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// One race day: every race in it, read-only, plus every card on it.
export default function DayView({ day }) {
  const dayId = day.raceDay.raceDayId;

  return (
    <>
      <div className="formrow formrow--tight">
        <button className="btn btn--sm" onClick={() => navigate('/')}>← All race days</button>
        <h2>{day.raceDay.track} — {day.raceDay.date}</h2>
      </div>

      <section className="panel">
        <h3>Races</h3>
        <table className="grid">
          <thead>
            <tr>
              <th>#</th><th>Post</th>
              {/* col-detail: dropped at mobile width so the View link - the
                  only reason this table exists - never lands off the right
                  edge. See the house rule in CLAUDE.md's Gotchas. */}
              <th className="col-detail">Distance</th>
              <th className="col-detail">Surface</th>
              <th className="col-detail">Runners</th>
              <th /></tr>
          </thead>
          <tbody>
            {day.races.map((r) => {
              const live = r.entries.filter((e) => !e.scratched).length;
              return (
                <tr key={r.number}>
                  <td>{r.number}</td>
                  <td>{r.postTime ?? '—'}</td>
                  <td className="col-detail">{r.distance ?? '—'}</td>
                  <td className="col-detail">{r.surface ?? '—'}</td>
                  <td className="col-detail">{live}{live !== r.entries.length && <span className="dim"> of {r.entries.length}</span>}</td>
                  <td>
                    <button className="btn btn--sm" onClick={() => navigate(`/day/${dayId}/race/${r.number}`)}>
                      View
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h3>Cards</h3>
        {day.cards.length === 0 ? (
          <p className="dim">No cards on this day.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Card</th>
                <th className="col-detail">Template</th>
                <th className="col-detail">Bankroll</th>
                <th className="col-detail">P/L</th>
                <th /></tr>
            </thead>
            <tbody>
              {day.cards.map((c) => (
                <tr key={c.id}>
                  <td>#{c.card_number}{c.name ? ` — "${c.name}"` : ''}</td>
                  <td className="col-detail">{c.template ?? '—'}</td>
                  <td className="col-detail">{money(c.bankroll_cents)}</td>
                  <td className="col-detail">
                    {c.grades.summary
                      ? <span className={c.grades.summary.plCents >= 0 ? 'pl--pos' : 'pl--neg'}>
                          {c.grades.summary.plCents >= 0 ? '+' : '−'}{money(Math.abs(c.grades.summary.plCents))}
                        </span>
                      : <span className="dim">ungraded</span>}
                  </td>
                  <td>
                    <button className="btn btn--sm" onClick={() => navigate(`/day/${dayId}/card/${c.id}`)}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
