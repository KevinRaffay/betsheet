import React, { useEffect, useState } from 'react';
import { getActiveTheme, getTheme, setTheme } from './prefs.js';

export default function App() {
  const [theme, setThemeState] = useState(getActiveTheme());

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
        <h1 className="topbar__brand">BetSheet</h1>
        <button className="topbar__theme" onClick={toggleTheme} title="Toggle theme">
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>
      <main className="pane">
        <p className="placeholder">
          Card generation lands with the ingest and engine PRs. This scaffold
          establishes the stack, styling system, and server wiring.
        </p>
      </main>
    </div>
  );
}
