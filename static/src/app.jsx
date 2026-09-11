import React, { useEffect, useState } from 'react';
import { validateStaticPayload } from '@shared/static-payload.js';
import DayView from './DayView.jsx';
import RaceView from './RaceView.jsx';

// The static app's shell (D150-D151, construction removed by D236).
//
// This app has no corpus, no grading, no generation and no database - it
// reads one payload file and renders it. D236 removed the CONSTRUCTION half
// (card building, IndexedDB drafts, export/import) that used to live here;
// what's left is view-only, on the same read-only payload this app always
// consumed. A future deliverable (D150-D158's schema is unchanged in this
// commit) will redesign the payload itself for a multi-day, cards-included
// snapshot - this shell does not anticipate that shape.
//
// HASH ROUTING, deliberately (D154): GitHub Pages serves static files and
// answers an unknown path with its own 404, so a History-API deep link would
// break on refresh. A fragment never reaches the server, so `#/race/3`
// survives a reload, a bookmark and a share with no SPA fallback to configure.

function useHashRoute() {
  const read = () => {
    const raw = window.location.hash.replace(/^#/, '') || '/';
    const m = /^\/race\/(\d+)$/.exec(raw);
    if (m) return { name: 'race', number: Number(m[1]) };
    return { name: 'day' };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const navigate = (to) => { window.location.hash = to; };

/** The payload is a static asset beside index.html, so it moves with the deploy. */
async function loadPayload() {
  const url = new URL('payload.json', document.baseURI);
  // cache: 'no-cache' revalidates rather than serving a stale race day from
  // the HTTP cache after a redeploy. The service worker (D155) has its own,
  // stronger rule for the same problem.
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`payload.json came back ${res.status}. No race day is deployed here yet.`);
  const payload = await res.json();
  const problems = validateStaticPayload(payload);
  if (problems.length) throw new Error(`The deployed payload is not valid:\n- ${problems.join('\n- ')}`);
  return payload;
}

export default function App() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const route = useHashRoute();

  useEffect(() => {
    let cancelled = false;
    loadPayload()
      .then((loaded) => { if (!cancelled) setPayload(loaded); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    // An effect that fetches must guard against its own stale response
    // (CLAUDE.md, Gotchas) - and the cleanup must be a FUNCTION, never a
    // returned promise, or React unmounts the whole root on teardown.
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div className="app">
        <header className="pagehead"><h1>BetSheet</h1></header>
        <div className="notice notice--error"><pre className="wrap">{error}</pre></div>
      </div>
    );
  }

  if (!payload) {
    return <div className="app"><p className="dim">Loading the race day…</p></div>;
  }

  const day = payload.raceDay;

  return (
    <div className="app">
      <header className="pagehead pagehead--static">
        <div>
          <h1>{day.track} — {day.date}</h1>
          <p className="dim">{payload.races.length} race(s)</p>
        </div>
      </header>

      {route.name === 'race' ? (
        <RaceView payload={payload} raceNumber={route.number} />
      ) : (
        <DayView payload={payload} />
      )}
    </div>
  );
}
