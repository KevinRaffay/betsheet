import React, { useEffect, useState } from 'react';
import { getActiveTheme, getTheme, setTheme } from './prefs.js';
import RaceDayList from './components/RaceDayList.jsx';
import NewRaceDay from './components/NewRaceDay.jsx';
import RaceDayView from './components/RaceDayView.jsx';
import CardView from './components/CardView.jsx';
import PLView from './components/PLView.jsx';
import SimView from './components/SimView.jsx';
import { parseRoute, pathForView } from './routes.js';
import BackfillQueue from './components/BackfillQueue.jsx';

export default function App() {
  const [theme, setThemeState] = useState(getActiveTheme());
  // view: { name: 'list' } | { name: 'new' } | { name: 'day', id }
  const [view, setView] = useState(() => parseRoute(window.location.pathname));
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const route = parseRoute(window.location.pathname);
    if (pathForView(route) !== window.location.pathname) {
      window.history.replaceState(null, '', pathForView(route));
    }
    const onPopState = () => setView(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (nextView) => {
    setView(nextView);
    window.history.pushState(null, '', pathForView(nextView));
  };

  useEffect(() => {
    document.documentElement.classList.toggle('dark-theme', theme === 'dark');
  }, [theme]);

  // Follow the OS preference live unless the user has set an override.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => { if (!getTheme()) setThemeState(getActiveTheme()); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="topbar__brand" onClick={() => navigate({ name: 'list' })}>BetSheet</h1>
        <button className="topbar__theme" onClick={toggleTheme} title="Toggle theme">
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>
      <main className="pane">
        {view.name === 'list' && (
          <RaceDayList
            refreshKey={refreshKey}
            onNew={() => navigate({ name: 'new' })}
            onOpen={(id) => navigate({ name: 'day', id })}
            onPL={() => navigate({ name: 'pl' })}
            onSim={() => navigate({ name: 'sim' })}
            onBackfill={() => navigate({ name: 'backfill' })}
          />
        )}
        {view.name === 'pl' && (
          <PLView
            onBack={() => navigate({ name: 'list' })}
            onOpenDay={(id) => navigate({ name: 'day', id })}
            onOpenCard={(cardId, dayId) => navigate({ name: 'card', id: cardId, dayId })}
          />
        )}
        {view.name === 'sim' && (
          <SimView
            onBack={() => navigate({ name: 'list' })}
            onOpenDay={(id) => navigate({ name: 'day', id })}
          />
        )}
        {view.name === 'backfill' && (
          <BackfillQueue
            onBack={() => navigate({ name: 'list' })}
            onOpenDay={(id) => { setRefreshKey((k) => k + 1); navigate({ name: 'day', id }); }}
          />
        )}
        {view.name === 'new' && (
          <NewRaceDay
            onCancel={() => navigate({ name: 'list' })}
            onSaved={(id) => { setRefreshKey((k) => k + 1); navigate({ name: 'day', id }); }}
          />
        )}
        {view.name === 'day' && (
          <RaceDayView
            id={view.id}
            onBack={() => navigate({ name: 'list' })}
            onOpenCard={(cardId) => navigate({ name: 'card', id: cardId, dayId: view.id })}
          />
        )}
        {view.name === 'card' && (
          <CardView
            cardId={view.id}
            onBack={() => navigate(view.dayId ? { name: 'day', id: view.dayId } : { name: 'list' })}
          />
        )}
      </main>
    </div>
  );
}
