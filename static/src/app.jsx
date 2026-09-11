import React, { useEffect, useState } from 'react';
import { validateStaticPayload } from '@shared/static-payload.js';
import DayList from './DayList.jsx';
import Calendar from './Calendar.jsx';
import DayView from './DayView.jsx';
import RaceView from './RaceView.jsx';
import CardView from './CardView.jsx';

// The static app's shell (D150, redesigned to a read-only multi-day viewer
// by D236/D329).
//
// This app has no corpus, no grading, no generation and no database - it
// reads one bundled payload file and renders it. D236 removed the
// CONSTRUCTION half that used to live here; D329 redesigned the payload
// itself to bundle multiple race days, each carrying every card on it
// (including grades), so a real calendar and card sheets have something to
// navigate.
//
// HASH ROUTING, deliberately (D154): GitHub Pages serves static files and
// answers an unknown path with its own 404, so a History-API deep link would
// break on refresh. A fragment never reaches the server, so `#/day/3/race/2`
// survives a reload, a bookmark and a share with no SPA fallback to configure.

function useHashRoute() {
  const read = () => {
    const raw = window.location.hash.replace(/^#/, '') || '/';
    let m;
    if ((m = /^\/day\/(\d+)\/race\/(\d+)$/.exec(raw))) return { name: 'race', dayId: Number(m[1]), number: Number(m[2]) };
    if ((m = /^\/day\/(\d+)\/card\/(\d+)$/.exec(raw))) return { name: 'card', dayId: Number(m[1]), cardId: Number(m[2]) };
    if ((m = /^\/day\/(\d+)$/.exec(raw))) return { name: 'day', dayId: Number(m[1]) };
    if (raw === '/calendar') return { name: 'calendar' };
    return { name: 'list' };
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
  if (!res.ok) throw new Error(`payload.json came back ${res.status}. No race days are deployed here yet.`);
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
    return <div className="app"><p className="dim">Loading the snapshot…</p></div>;
  }

  const { raceDays } = payload;
  const day = 'dayId' in route ? raceDays.find((d) => d.raceDay.raceDayId === route.dayId) : null;

  let body;
  if (route.name === 'calendar') {
    body = <Calendar raceDays={raceDays} />;
  } else if (route.name === 'list') {
    body = <DayList raceDays={raceDays} onOpenCalendar={() => navigate('/calendar')} />;
  } else if (!day) {
    body = (
      <section className="panel">
        <p className="notice notice--error">No race day {route.dayId} in this snapshot.</p>
        <button className="btn" onClick={() => navigate('/')}>Back to the list</button>
      </section>
    );
  } else if (route.name === 'race') {
    body = <RaceView day={day} raceNumber={route.number} />;
  } else if (route.name === 'card') {
    body = <CardView day={day} cardId={route.cardId} />;
  } else {
    body = <DayView day={day} />;
  }

  return (
    <div className="app">
      <header className="pagehead pagehead--static">
        <div>
          <h1>BetSheet</h1>
          <p className="dim">
            {raceDays.length} race day{raceDays.length === 1 ? '' : 's'} in this snapshot ·
            {' '}generated {payload.generatedAt}
          </p>
        </div>
      </header>
      {body}
    </div>
  );
}
