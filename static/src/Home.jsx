import React from 'react';
import { navigate } from './app.jsx';
import { bundleStats, cashedTickets, dayStats, nextRace, orderDays } from './day-stats.js';
import { producerOf } from './card-label.js';
import { longDate, money, plural, plClass, signedMoney } from './format.js';

// The landing screen, on the emubets.com model (D364): a stats strip for the
// whole snapshot, the next race to go, the meetings as cards ("Delaware Park
// · Fri, Sep 11 · 10 races · View Tips →"), and the recent cashed tickets
// ("Recent Winning Selections"). Everything here is read off the bundle -
// the strip's P/L is the sum of the graded cards' own summaries and is shown
// WITH its n, because a P&L figure without one is the thing this codebase
// refuses to print (CLAUDE.md, Findings).
//
// The filterable table this replaced is one click away at #/days
// (DayList.jsx, unchanged): a bundle of a season is still easier to search
// than to scroll.

function todayPacific() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function Stat({ value, label, className }) {
  return (
    <div className="stat">
      <div className={`stat__value ${className ?? ''}`}>{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

function Meeting({ day }) {
  const s = dayStats(day);
  return (
    <article className="meeting">
      <h3 className="meeting__track">{day.raceDay.track}</h3>
      <p className="meeting__date">{longDate(day.raceDay.date)}</p>
      <p className="dim meeting__facts">
        {plural(s.races, 'race')} · {plural(s.cards, 'card')}
        {s.graded > 0 && <> · <span className={plClass(s.plCents)}>{signedMoney(s.plCents)}</span> on {s.graded} graded</>}
        {s.hasResults && s.graded === 0 && ' · results in'}
      </p>
      <button type="button" className="btn btn--primary meeting__cta" onClick={() => navigate(`/day/${day.raceDay.raceDayId}`)}>
        View picks →
      </button>
    </article>
  );
}

export default function Home({ raceDays, generatedAt }) {
  const stats = bundleStats(raceDays);
  const next = nextRace(raceDays);
  const { upcoming, past } = orderDays(raceDays, todayPacific());
  const cashed = cashedTickets(raceDays, 10);

  return (
    <>
      <section className="hero">
        <h2 className="hero__title">Race days, cards and grades</h2>
        <p className="dim hero__sub">
          A read-only snapshot of every card bet on {plural(stats.days, 'race day')} at {plural(stats.tracks, 'track')},
          graded against the charts. Generated {generatedAt}.
        </p>
        <div className="stats">
          <Stat value={stats.tracks} label="Tracks" />
          <Stat value={stats.races} label="Races" />
          <Stat value={stats.cards} label="Cards" />
          <Stat
            value={stats.plCents == null ? '—' : signedMoney(stats.plCents)}
            label={stats.gradedCards > 0 ? `P/L, ${stats.gradedCards} graded` : 'P/L (nothing graded)'}
            className={stats.plCents == null ? 'dim' : plClass(stats.plCents)}
          />
        </div>
      </section>

      {next && (
        <section className="panel next-race">
          <div>
            <div className="eyebrow">Next race</div>
            <div className="next-race__what">{next.day.raceDay.track} · Race {next.race.number}</div>
            <div className="dim">
              {next.postTimePacific}
              {next.race.distance ? ` · ${next.race.distance}` : ''}
              {' · '}{plural(next.race.entries.filter((e) => !e.scratched).length, 'runner')}
            </div>
          </div>
          <button type="button" className="btn btn--primary"
            onClick={() => navigate(`/day/${next.day.raceDay.raceDayId}/race/${next.race.number}`)}>
            View race →
          </button>
        </section>
      )}

      <section className="panel">
        <div className="pagehead">
          <h3>{upcoming.length > 0 ? "Today's & upcoming race days" : 'Race days'}</h3>
          <div className="formrow formrow--tight">
            <button type="button" className="btn btn--sm" onClick={() => navigate('/calendar')}>Calendar</button>
            <button type="button" className="btn btn--sm" onClick={() => navigate('/days')}>All days · filter</button>
          </div>
        </div>
        {upcoming.length > 0 && (
          <div className="meeting-grid">{upcoming.map((d) => <Meeting key={d.raceDay.raceDayId} day={d} />)}</div>
        )}
        {upcoming.length > 0 && past.length > 0 && <h3 className="section-sub">Recent race days</h3>}
        {past.length > 0 && (
          <div className="meeting-grid">{past.map((d) => <Meeting key={d.raceDay.raceDayId} day={d} />)}</div>
        )}
        {raceDays.length === 0 && <p className="placeholder">No race days in this snapshot.</p>}
      </section>

      <section className="panel">
        <div className="pagehead"><h3>Recent cashed tickets</h3></div>
        {cashed.length === 0 ? (
          <p className="dim">No graded ticket in this snapshot has returned money yet.</p>
        ) : (
          <ul className="cashed">
            {cashed.map(({ day, card, grade, raceNumber }) => {
              const p = producerOf(card);
              const dayId = day.raceDay.raceDayId;
              return (
                <li key={`${card.id}-${grade.sequence}`} className="cashed__row">
                  <button type="button" className="cashed__link"
                    onClick={() => navigate(raceNumber ? `/day/${dayId}/race/${raceNumber}` : `/day/${dayId}/card/${card.id}`)}>
                    <span className="cashed__call"><code>{grade.teller_call}</code></span>
                    <span className="cashed__where dim">
                      {day.raceDay.track}{raceNumber ? ` · Race ${raceNumber}` : ''} · {longDate(day.raceDay.date)}
                    </span>
                    <span className={`chip chip--${p.chip}`}>{p.label}</span>
                    <span className="cashed__pay pl--pos">{money(grade.returned_cents)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
