// Per-user preferences in localStorage, every access wrapped - same pattern
// as life-swipe's prefs.js. Holds only UI conveniences (theme); nothing here
// is ever the source of truth for card data, which lives in SQLite.

const KEY = 'betsheet_prefs';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function write(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable - preferences just don't persist */
  }
}

// 'light' | 'dark' | null (null = follow the OS preference)
export function getTheme() {
  const t = read().theme;
  return t === 'light' || t === 'dark' ? t : null;
}

export function setTheme(theme) {
  const prefs = read();
  if (theme === 'light' || theme === 'dark') prefs.theme = theme;
  else delete prefs.theme;
  write(prefs);
}

export function getActiveTheme() {
  const override = getTheme();
  if (override) return override;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
