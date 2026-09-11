import React from 'react';
import { navigate } from './app.jsx';
import RacePicks from './RacePicks.jsx';
import { cashedTickets, dayStats } from './day-stats.js';
import { cardTitle } from './card-label.js';
import { longDate, money, plural, plClass, signedMoney } from './format.js';

// One race day, on the emubets.com track-page model (D364): a header with
// the day's numbers, a row of race pills that jump down the page, the
// biggest cashed tickets, then EVERY race in one scroll - its facts, its
// result once run, and every card's picks on it (RacePicks.jsx) - each with
// a link to the full entries. The old table-of-races-then-click screen is
// gone from this route; the entries themselves stay on RaceView.jsx, which
// a phone reaches with one tap from the race's own section.
//
// The cards table at the bottom is kept as it was, because a card is still
// the unit the desktop grades and the sheet a person carries to the window.

const scrollToRace = (n) => {
  document.getElementById(`race-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

export default function DayView({ day }) {
  const dayId = day.raceDay.raceDayId;
  const s = dayStats(day);
  const cashed = cashedTickets([day], 5);

  return (
    <>
      <section className="dayhead">
        <div className="formrow formrow--tight">
          <button className="btn btn--sm" onClick={() => navigate('/')}>← Home</button>
        </div>
        <h2 className="dayhead__title">{day.raceDay.track} <span className="dayhead__accent">Picks</span></h2>
        <p className="dayhead__date">{longDate(day.raceDay.date)}{day.raceDay.meet ? ` · ${day.raceDay.meet} meet` : ''}</p>
        <p className="dim">
          {plural(s.races, 'race')} · {plural(s.runners, 'runner')} · avg field {s.avgField} · {plural(s.cards, 'card')}
          {s.graded > 0 && <> · <span className={plClass(s.plCents)}>{signedMoney(s.plCents)}</span> on {s.graded} graded</>}
        </p>
        <nav className="race-pills" aria-label="Races">
          <span className="race-pills__label">Races</span>
          {day.races.map((r) => (
            <button key={r.number} type="button" className="pill" onClick={() => scrollToRace(r.number)}>#{r.number}</button>
          ))}
        </nav>
      </section>

      {cashed.length > 0 && (
        <section className="panel">
          <h3>Cashed on this day</h3>
          <ul className="wins">
            {cashed.map(({ card, grade, raceNumber }) => (
              <li key={`${card.id}-${grade.sequence}`} className="win">
                <span className="win__call"><code>{grade.teller_call}</code></span>
                <span className="dim win__where">Race {raceNumber ?? '?'} · {cardTitle(card)}</span>
                <span className="pl--pos win__pay">{money(grade.returned_cents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {day.races.map((r) => {
        const live = r.entries.filter((e) => !e.scratched).length;
        return (
          <section key={r.number} id={`race-${r.number}`} className="panel race-section">
            <header className="race-section__head">
              <div>
                <h3 className="race-section__title">Race {r.number}</h3>
                <p className="dim race-section__facts">
                  {[r.postTime, r.distance, r.surface, r.raceType].filter(Boolean).join(' · ')}
                  {' · '}{live}{live !== r.entries.length ? ` of ${r.entries.length}` : ''} runners
                </p>
              </div>
              <button type="button" className="btn btn--sm" onClick={() => navigate(`/day/${dayId}/race/${r.number}`)}>
                All {live} runners →
              </button>
            </header>
            <RacePicks day={day} race={r} />
          </section>
        );
      })}

      <section className="panel">
        <h3>Cards</h3>
        {day.cards.length === 0 ? (
          <p className="dim">No cards on this day.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Card</th>
                {/* col-detail: dropped at mobile width so the View link - the
                    only reason this table exists - never lands off the right
                    edge. See the house rule in CLAUDE.md's Gotchas. */}
                <th className="col-detail">Bankroll</th>
                <th className="col-detail">P/L</th>
                <th /></tr>
            </thead>
            <tbody>
              {day.cards.map((c) => (
                <tr key={c.id}>
                  <td>{cardTitle(c)}</td>
                  <td className="col-detail">{money(c.bankroll_cents)}</td>
                  <td className="col-detail">
                    {c.grades?.summary
                      ? <span className={plClass(c.grades.summary.plCents)}>{signedMoney(c.grades.summary.plCents)}</span>
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
