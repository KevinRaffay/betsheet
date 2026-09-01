import React, { useEffect, useState } from 'react';
import { getActiveTheme, getTheme, setTheme } from './prefs.js';
import RaceDayList from './components/RaceDayList.jsx';
import NewRaceDay from './components/NewRaceDay.jsx';
import RaceDayView from './components/RaceDayView.jsx';

export default function App() {
  const [theme, setThemeState] = useState(getActiveTheme());
  // view: { name: 'list' } | { name: 'new' } | { name: 'day', id }
  const [view, setView] = useState({ name: 'list' });
  const [refreshKey, setRefreshKey] = useState(0);

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
        <h1 className="topbar__brand" onClick={() => setView({ name: 'list' })}>BetSheet</h1>
        <button className="topbar__theme" onClick={toggleTheme} title="Toggle theme">
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>
      <main className="pane">
        {view.name === 'list' && (
          <RaceDayList
            refreshKey={refreshKey}
            onNew={() => setView({ name: 'new' })}
            onOpen={(id) => setView({ name: 'day', id })}
          />
        )}
        {view.name === 'new' && (
          <NewRaceDay
            onCancel={() => setView({ name: 'list' })}
            onSaved={(id) => { setRefreshKey((k) => k + 1); setView({ name: 'day', id }); }}
          />
        )}
        {view.name === 'day' && (
          <RaceDayView id={view.id} onBack={() => setView({ name: 'list' })} />
        )}
      </main>
    </div>
  );
}
