import React, { useEffect, useState } from 'react';
import { getNextRace } from '../api.js';

// The "Next race" card on the desktop home (D378, user request: "add the
// Next Race card to the home page of the app in all versions"). The static
// app's Home.jsx renders the same card over its bundle; this one asks
// GET /api/next-race, which runs the same shared/race-calendar.js function
// over every stored day, so the two homes cannot disagree about what is
// next. Always rendered: on a historical corpus - the ordinary case - it says
// nothing is still to run and points at the latest stored day instead of
// vanishing, which is what would make a person wonder whether it works.
export default function NextRaceCard({ onOpen, refreshKey }) {
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
  const target = next ?? latest;
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
              {latest ? `Latest stored day: ${latest.track}, ${latest.date}` : 'No race days stored yet.'}
            </div>
          </>
        )}
      </div>
      {target && (
        <button type="button" className="btn btn--primary" onClick={() => onOpen(target.raceDayId)}>
          Open day →
        </button>
      )}
    </section>
  );
}
