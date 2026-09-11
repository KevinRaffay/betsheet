import React, { useEffect, useState } from 'react';
import { validateStaticPayload } from '@shared/static-payload.js';
import Home from './Home.jsx';
import DayList from './DayList.jsx';
import Calendar from './Calendar.jsx';
import DayView from './DayView.jsx';
import RaceView from './RaceView.jsx';
import CardView from './CardView.jsx';
import { useTheme } from './theme.js';

// The static app's shell (D150, redesigned to a read-only multi-day viewer
// by D236/D329, laid out on the emubets.com model by D364).
//
// This app has no corpus, no grading, no generation and no database - it
// reads one bundled payload file and renders it. D236 removed the
// CONSTRUCTION half that used to live here; D329 redesigned the payload
// itself to bundle multiple race days, each carrying every card on it
// (including grades), so a real calendar and card sheets have something to
// navigate. D364 gave it the shape of a picks site: a home with the numbers,
// the next race and the meetings; a day page that scrolls every race with
// its picks and result; a persistent top bar; light and dark.
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
    if (raw === '/days') return { name: 'list' };
    return { name: 'home' };
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

// A route change is a new page, and a new page starts at the top - without
// this, opening a race from the bottom of a long day page leaves the viewer
// scrolled to the bottom of the race page. Keyed on the hash string, so the
// pills' in-page scrolls (which never change the hash) are unaffected.
function useScrollToTopOnRoute(route) {
  const key = JSON.stringify(route);
  useEffect(() => { window.scrollTo(0, 0); }, [key]);
}

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

function TopBar({ route, theme, onToggleTheme }) {
  const link = (name, to, label) => (
    <a href={`#${to}`} className={`topnav__link${route.name === name ? ' topnav__link--active' : ''}`}>{label}</a>
  );
  return (
    <header className="pagehead pagehead--static topnav">
      <a href="#/" className="topnav__brand">BetSheet</a>
      <nav className="topnav__links" aria-label="Sections">
        {link('home', '/', 'Home')}
        {link('list', '/days', 'Race days')}
        {link('calendar', '/calendar', 'Calendar')}
      </nav>
      <button type="button" className="topbar__theme" onClick={onToggleTheme} title="Toggle theme">
        {theme === 'dark' ? 'Light' : 'Dark'}
      </button>
    </header>
  );
}

export default function App() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const route = useHashRoute();
  const { theme, toggle } = useTheme();
  useScrollToTopOnRoute(route);

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
        <TopBar route={route} theme={theme} onToggleTheme={toggle} />
        <div className="notice notice--error"><pre className="wrap">{error}</pre></div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="app">
        <TopBar route={route} theme={theme} onToggleTheme={toggle} />
        <p className="dim">Loading the snapshot…</p>
      </div>
    );
  }

  const { raceDays } = payload;
  const day = 'dayId' in route ? raceDays.find((d) => d.raceDay.raceDayId === route.dayId) : null;

  let body;
  if (route.name === 'home') {
    body = <Home raceDays={raceDays} generatedAt={payload.generatedAt} />;
  } else if (route.name === 'calendar') {
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
      <TopBar route={route} theme={theme} onToggleTheme={toggle} />
      {body}
      <footer className="static-foot dim">
        {raceDays.length} race day{raceDays.length === 1 ? '' : 's'} in this snapshot · generated {payload.generatedAt}
      </footer>
    </div>
  );
}
