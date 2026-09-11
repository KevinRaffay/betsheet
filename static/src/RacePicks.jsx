import React from 'react';
import { navigate } from './app.jsx';
import { picksForRace, resultsForRace } from './day-stats.js';
import { producerOf } from './card-label.js';
import { money } from './format.js';

// One race's PICKS and RESULT, the block emubets.com repeats under every
// race on its track page (D364): each tipster's selections side by side,
// then, once the race has run, what actually happened. Here a tipster is a
// CARD (see card-label.js), a selection is a ticket, and "what happened" is
// the grade already on that ticket plus the top finishers and exotic payoffs
// from the day's results - all of it read straight off the bundle, none of it
// computed here (the built bundle must never carry grading COMPUTATION,
// scripts/check-static-app.js's forbidden list).
//
// Rendered by DayView.jsx (every race, in one scroll) and RaceView.jsx (one
// race under its entries), so the two screens cannot show a race differently.

const OUTCOME_LABEL = { win: 'WIN', loss: 'LOSS', refund: 'REFUND', partial: 'PARTIAL' };

function Outcome({ grade }) {
  if (!grade) return <span className="dim pick__grade">ungraded</span>;
  return (
    <span className="pick__grade">
      <span className={`outcome outcome--${grade.outcome}`}>{OUTCOME_LABEL[grade.outcome] ?? grade.outcome.toUpperCase()}</span>
      {grade.returned_cents > 0 && (
        // Money back on a REFUND is not a win, so it is not painted like one.
        <span className={grade.outcome === 'refund' ? 'dim' : 'pl--pos'}> {money(grade.returned_cents)}</span>
      )}
    </span>
  );
}

function Results({ finishers, exotics }) {
  if (finishers.length === 0) return null;
  return (
    <div className="race-result">
      <h4>Result</h4>
      <ol className="finish-list">
        {finishers.slice(0, 3).map((f) => (
          <li key={f.finish_position} className="finish">
            <span className="finish__pos">{f.finish_position}</span>
            <span className="finish__horse">#{f.program_number} {f.horse_name}</span>
            <span className="finish__pay dim">
              {[f.win_cents, f.place_cents, f.show_cents].map((c) => (c == null ? '—' : money(c))).join(' / ')}
            </span>
          </li>
        ))}
      </ol>
      {exotics.length > 0 && (
        <p className="dim exotics">
          {exotics.map((x) => `${money(x.base_cents)} ${String(x.bet_type).replace(/_/g, ' ')} ${x.combination} paid ${money(x.payout_cents)}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

export default function RacePicks({ day, race }) {
  const dayId = day.raceDay.raceDayId;
  const groups = picksForRace(day, race.number);
  const { finishers, exotics } = resultsForRace(day, race.number);

  return (
    <div className="race-picks">
      <Results finishers={finishers} exotics={exotics} />
      <h4>Picks{groups.length > 0 && <span className="dim"> · {groups.length} card{groups.length === 1 ? '' : 's'}</span>}</h4>
      {groups.length === 0 ? (
        <p className="dim">No card bet this race.</p>
      ) : (
        <div className="picks">
          {groups.map(({ card, tickets }) => {
            const p = producerOf(card);
            return (
              <article key={card.id} className="pick">
                <header className="pick__head">
                  <span className={`chip chip--${p.chip}`}>{p.label}</span>
                  <button type="button" className="btn btn--sm"
                    onClick={() => navigate(`/day/${dayId}/card/${card.id}`)}>
                    card #{card.card_number}{p.detail ? ` · ${p.detail}` : ''}
                  </button>
                </header>
                <ul className="pick__tickets">
                  {tickets.map(({ ticket, grade }) => {
                    const spans = ticket.selections?.races ?? [];
                    return (
                      <li key={ticket.sequence} className="pick__ticket">
                        <div className="pick__call">
                          <code>{ticket.teller_call}</code>
                          {spans.length > 1 && <span className="dim"> races {spans.join('–')}</span>}
                          <Outcome grade={grade} />
                        </div>
                        {ticket.rationale_text && <div className="pick__why dim">{ticket.rationale_text}</div>}
                      </li>
                    );
                  })}
                </ul>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
