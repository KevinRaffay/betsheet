import React, { useEffect, useRef, useState } from 'react';
import { getCalendar, listCards } from '../api.js';
import { CALENDAR_COLUMNS, CALENDAR_START_HOUR } from '@shared/race-calendar.js';

// "Today" is always the Pacific calendar date (D210/2026-09-10 decision: the
// user is always Pacific), computed explicitly rather than read off the
// browser's own `new Date()` - a browser whose OS clock sits in a different
// zone would otherwise default to the wrong day right when it matters most
// (late evening Pacific, already past midnight elsewhere).
function todayPacific() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Column i's header label, matching the endpoint's own hourBucket convention
// (column 0 is CALENDAR_START_HOUR:00 Pacific, wrapping past midnight).
function columnLabel(i) {
  const hour = (CALENDAR_START_HOUR + i) % 24;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h12}:00 ${ampm} PT`;
}

// Get the current hour in Pacific time (0-23).
function currentPacificHour() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit',
  });
  return Number(fmt.format(new Date()));
}

const COLUMNS = Array.from({ length: CALENDAR_COLUMNS }, (_, i) => i);

// Race day calendar (D210, phase C-3 of docs/requirements/race-day-calendar.md):
// tracks x hourly Pacific columns, so a card can be built as close to post as
// possible. Every displayed time is Pacific - there is no per-track zone
// shown anywhere on this screen, by the same 2026-09-10 decision that shaped
// the endpoint this reads.
export default function RaceDayCalendar({ onBack, onOpenDay }) {
  const [date, setDate] = useState(todayPacific);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [daysWithCards, setDaysWithCards] = useState(new Set());
  const scrollContainerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getCalendar(date)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e.message)); });
    return () => { cancelled = true; };
  }, [date]);

  // Fetch cards for all race days to determine button styling
  useEffect(() => {
    if (!data || data.tracks.length === 0) {
      setDaysWithCards(new Set());
      return;
    }
    let cancelled = false;
    const daysToCheck = new Set(data.tracks.map((t) => t.raceDayId));
    const cardsMap = new Set();

    Promise.all(
      [...daysToCheck].map((dayId) =>
        listCards(dayId)
          .then((cards) => {
            if (!cancelled && cards.length > 0) {
              cardsMap.add(dayId);
            }
          })
          .catch(() => {
            // Silently ignore errors when fetching cards
          })
      )
    ).then(() => {
      if (!cancelled) setDaysWithCards(cardsMap);
    });

    return () => { cancelled = true; };
  }, [data]);

  // Auto-scroll to the current Pacific hour when data loads
  useEffect(() => {
    if (!data || !scrollContainerRef.current || data.tracks.length === 0) return;

    const current = currentPacificHour();
    // Column for the current hour: (hour - CALENDAR_START_HOUR + CALENDAR_COLUMNS) % CALENDAR_COLUMNS
    const column = (current - CALENDAR_START_HOUR + CALENDAR_COLUMNS) % CALENDAR_COLUMNS;

    // Estimate column width: account for the track column + padding
    // Approximate column width based on typical table styling
    const trackColumnWidth = 100; // approximate width of track column (in px)
    const columnWidth = 120; // approximate width of each hour column (in px)
    const scrollLeft = Math.max(0, column * columnWidth - columnWidth); // scroll to show current hour near the start

    // Use requestAnimationFrame to ensure the DOM is ready
    requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ left: scrollLeft, behavior: 'auto' });
    });
  }, [data]);

  const totalUnplaceable = data ? data.tracks.reduce((n, t) => n + t.unplaceable.length, 0) : 0;

  return (
    <section>
      <div className="pagehead">
        <h2>Race day calendar</h2>
        <div className="formrow formrow--tight">
          <label>
            Date{' '}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <button className="btn" onClick={() => setDate(todayPacific())}>Today</button>
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>

      {error && <p className="notice notice--error">{error}</p>}
      {!error && !data && <p className="placeholder">Loading…</p>}
      {!error && data && data.tracks.length === 0 && (
        <p className="placeholder">No race days for {date}.</p>
      )}

      {!error && data && data.tracks.length > 0 && (
        <>
          <div className="grid--wide-scroll" ref={scrollContainerRef}>
            <table className="grid grid--matrix">
              <thead>
                <tr>
                  <th>Track</th>
                  {COLUMNS.map((i) => <th key={i}>{columnLabel(i)}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.tracks.map((t) => {
                  const hasCards = daysWithCards.has(t.raceDayId);
                  return (
                  <tr key={t.raceDayId}>
                    <td>
                      <button
                        type="button"
                        className={hasCards ? 'btn btn--primary' : 'btn'}
                        onClick={() => onOpenDay(t.raceDayId)}
                      >
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
                                <button
                                  type="button"
                                  className={hasCards ? 'btn btn--primary btn--sm' : 'btn btn--sm'}
                                  onClick={() => onOpenDay(t.raceDayId, r.number)}
                                >
                                  Race {r.number} - {r.postTimePacific}
                                </button>
                              </div>
                            ))}
                        </td>
                      );
                    })}
                  </tr>
                  );
                })}
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
