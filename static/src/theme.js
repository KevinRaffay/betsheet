// Light/dark for the static app (D364), mirroring client/src/prefs.js +
// App.jsx's toggle rather than importing them: prefs.js is a desktop module
// and the static app's import surface is deliberately five files (CLAUDE.md,
// D168). Same semantics - an explicit choice in localStorage wins, otherwise
// the OS preference is followed live - and the same `.dark-theme` class on
// <html>, which is what client/src/styles.css's tokens key on, so the shared
// components render in either theme exactly as they do on the desktop.
//
// emubets.com is dark by default; this app follows the phone instead, because
// a phone in racetrack sunlight is usually set to light for a reason.

import { useEffect, useState } from 'react';

const KEY = 'betsheet_static_prefs';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function write(prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* no persistence, still works */ }
}

const osTheme = () => {
  try { return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { return 'light'; }
};

function activeTheme() {
  const t = read().theme;
  return t === 'light' || t === 'dark' ? t : osTheme();
}

export function useTheme() {
  const [theme, setTheme] = useState(activeTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark-theme', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    let mq = null;
    try { mq = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null; } catch { mq = null; }
    if (!mq) return undefined;
    const onChange = () => { if (!read().theme) setTheme(osTheme()); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    write({ ...read(), theme: next });
    setTheme(next);
  };

  return { theme, toggle };
}
