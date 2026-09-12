import React, { useState, useEffect } from 'react';
import { navigate } from './app.jsx';
import { latestDay, nextRace } from './day-stats.js';
import { longDate, plural } from './format.js';

// The "Next race" tile (D378, extracted by D380 so the home AND the calendar
// render the identical card). Always rendered; the button ALWAYS opens a
// race, never a day (user rule 2026-09-11): the soonest race still to run
// when there is one, otherwise the last race of the latest bundled day - on
// a historical snapshot, which is the ordinary case, that is the most recent
// race that ran, and the closest thing to "next" the bundle has.
export default function NextRaceTile({ raceDays }) {
  const next = nextRace(raceDays);
  const latest = latestDay(raceDays);
  const lastRace = latest ? latest.races.reduce((m, r) => (r.number > m ? r.number : m), 0) : 0;
  const target = next
    ? { dayId: next.day.raceDay.raceDayId, number: next.race.number }
    : latest && lastRace ? { dayId: latest.raceDay.raceDayId, number: lastRace } : null;

  const [timeUntil, setTimeUntil] = useState(null);

  useEffect(() => {
    if (!next?.at) return;

    const updateCountdown = () => {
      const now = new Date();
      const diff = next.at - now;
      const minutes = Math.ceil(diff / (1000 * 60));
      if (minutes > 0) {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        setTimeUntil(hours > 0 ? `${hours}:${String(mins).padStart(2, '0')}` : `${mins} MINUTE${mins === 1 ? '' : 'S'}`);
      } else {
        setTimeUntil(null);
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 60 * 1000);
    return () => clearInterval(interval);
  }, [next?.at]);

  return (
    <section className="next-race">
      <div>
        <div className="eyebrow">
          {timeUntil ? `${timeUntil} TO NEXT RACE` : 'Next race'}
        </div>
        {next ? (
          <>
            <div className="next-race__what">{next.day.raceDay.track} · Race {next.race.number}</div>
            <div className="dim">
              {next.postTimePacific} · {longDate(next.day.raceDay.date)}
              {next.race.distance ? ` · ${next.race.distance}` : ''}
              {' · '}{plural(next.race.entries.filter((e) => !e.scratched).length, 'runner')}
            </div>
          </>
        ) : (
          <>
            <div className="next-race__what">No race still to run in this snapshot</div>
            <div className="dim">
              {latest
                ? `Latest: ${latest.raceDay.track}, ${longDate(latest.raceDay.date)}${lastRace ? `, race ${lastRace}` : ''}`
                : 'No race days bundled.'}
            </div>
          </>
        )}
      </div>
      {target && (
        <button type="button" className="btn btn--primary"
          onClick={() => navigate(`/day/${target.dayId}/race/${target.number}`)}>
          Open race →
        </button>
      )}
    </section>
  );
}
