import React, { useMemo, useState } from 'react';
import { CALENDAR_COLUMNS, CALENDAR_START_HOUR, placeRacePacific } from '@shared/race-calendar.js';
import { navigate } from './app.jsx';

// "Today" is always the Pacific calendar date (the same 2026-09-10 decision
// the desktop calendar was built under: the user is always Pacific).
function todayPacific() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function columnLabel(i) {
  const hour = (CALENDAR_START_HOUR + i) % 24;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h12}:00 ${ampm} PT`;
}

const COLUMNS = Array.from({ length: CALENDAR_COLUMNS }, (_, i) => i);

// The race calendar: tracks x hourly Pacific columns, for one date drawn
// from the bundled payload rather than an API fetch (there is no server
// here). Mirrors client/src/components/RaceDayCalendar.jsx's own matrix,
// using the same shared/race-calendar.js placement math against each day's
// precomputed `timezone` field - the browser never needs the track registry
// itself, only this one pure module.
export default function Calendar({ raceDays }) {
  const dates = useMemo(() => [...new Set(raceDays.map((d) => d.raceDay.date))].sort(), [raceDays]);
  const [date, setDate] = useState(() => {
    const today = todayPacific();
    if (dates.includes(today)) return today;
    // Closest bundled date to today, falling back to the first bundled date.
    return dates.reduce((best, d) => (Math.abs(new Date(d) - new Date(today)) < Math.abs(new Date(best) - new Date(today)) ? d : best), dates[0]) ?? today;
  });

  const daysOnDate = raceDays.filter((d) => d.raceDay.date === date);

  const placed = daysOnDate.map((d) => {
    const races = d.races.map((r) => {
      const p = placeRacePacific(d.raceDay.date, r.postTime, d.raceDay.timezone);
      return p ? { number: r.number, hourBucket: p.hourBucket, postTimePacific: p.postTimePacific } : null;
    });
    return {
      raceDayId: d.raceDay.raceDayId,
      track: d.raceDay.track,
      races: races.filter(Boolean),
      unplaceable: races.filter((r) => r === null).length,
    };
  });
  const totalUnplaceable = placed.reduce((n, t) => n + t.unplaceable, 0);

  return (
    <section className="panel">
      <div className="pagehead">
        <h2>Race day calendar</h2>
        <div className="formrow formrow--tight">
          <label>
            Date{' '}
            <select className="in in--sm" value={date} onChange={(e) => setDate(e.target.value)}>
              {dates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <button className="btn btn--sm" onClick={() => navigate('/')}>Back to list</button>
        </div>
      </div>

      {placed.length === 0 && <p className="placeholder">No race days for {date} in this snapshot.</p>}

      {placed.length > 0 && (
        <>
          <div className="grid--wide-scroll">
            <table className="grid grid--matrix">
              <thead>
                <tr>
                  <th>Track</th>
                  {COLUMNS.map((i) => <th key={i}>{columnLabel(i)}</th>)}
                </tr>
              </thead>
              <tbody>
                {placed.map((t) => (
                  <tr key={t.raceDayId}>
                    <td>
                      <button type="button" className="btn" onClick={() => navigate(`/day/${t.raceDayId}`)}>
                        {t.track}
                      </button>
                    </td>
                    {COLUMNS.map((i) => {
                      const races = t.races.filter((r) => r.hourBucket === i);
                      return (
                        <td key={i}>
                          {races.length === 0
                            ? <span className="dim">—</span>
                            : races.map((r) => (
                              <div key={r.number}>
                                <button type="button" className="btn btn--sm"
                                  onClick={() => navigate(`/day/${t.raceDayId}/race/${r.number}`)}>
                                  Race {r.number} · {r.postTimePacific}
                                </button>
                              </div>
                            ))}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalUnplaceable > 0 && (
            <p className="dim">
              {totalUnplaceable} race{totalUnplaceable === 1 ? '' : 's'} could not be placed on
              the grid (a missing post time, or a track with no known timezone) - open the day
              directly to see it.
            </p>
          )}
        </>
      )}
    </section>
  );
}
