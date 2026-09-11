import React, { useEffect, useState } from 'react';
import { getNextRace } from '../api.js';

// The "Next race" card on the desktop home AND calendar (D378, D380; user
// request: "add the Next Race card to the home page of the app in all
// versions", then "to the calendar page too"). The static app's
// NextRaceTile.jsx renders the same card over its bundle; this one asks
// GET /api/next-race, which runs the same shared/race-calendar.js function
// over every stored day, so the two apps cannot disagree about what is next.
//
// Always rendered, and the button ALWAYS opens a race, never a day (user
// rule 2026-09-11, D380): the soonest race still to run when there is one,
// otherwise the last race of the latest stored day - on a historical corpus,
// the ordinary case, that is the most recent race that ran. `onOpenRace(dayId,
// raceNumber)` is App.jsx's open-the-day-scrolled-to-that-race navigation,
// the same one the calendar's race buttons already use.
export default function NextRaceCard({ onOpenRace, refreshKey }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getNextRace()
      .then((r) => { if (!cancelled) setState(r); })
      .catch((e) => { if (!cancelled) setError(String(e.message)); });
    // A function, never a promise (CLAUDE.md, Gotchas), and guarded against
    // its own stale response.
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (error) return <p className="notice notice--error">Next race: {error}</p>;
  if (!state) return null;

  const { next, latest } = state;
  const target = next
    ? { dayId: next.raceDayId, number: next.number }
    : latest ? { dayId: latest.raceDayId, number: latest.lastRaceNumber ?? null } : null;

  return (
    <section className="next-race">
      <div>
        <div className="eyebrow">Next race</div>
        {next ? (
          <>
            <div className="next-race__what">{next.track} · Race {next.number}</div>
            <div className="dim">
              {next.postTimePacific} · {next.date}
              {next.runners > 0 ? ` · ${next.runners} runner${next.runners === 1 ? '' : 's'}` : ''}
            </div>
          </>
        ) : (
          <>
            <div className="next-race__what">No race still to run</div>
            <div className="dim">
              {latest
                ? `Latest: ${latest.track}, ${latest.date}${latest.lastRaceNumber ? `, race ${latest.lastRaceNumber}` : ''}`
                : 'No race days stored yet.'}
            </div>
          </>
        )}
      </div>
      {target && (
        <button type="button" className="btn btn--primary" onClick={() => onOpenRace(target.dayId, target.number)}>
          Open race →
        </button>
      )}
    </section>
  );
}
