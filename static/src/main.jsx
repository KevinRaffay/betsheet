import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app.jsx';
// The desktop stylesheet, unmodified: the static app renders the same
// components (TicketBuilder, EntriesTable) and must not grow a second,
// drifting copy of their styles. static.css adds only what is new here.
import '@client/styles.css';
import './static.css';

createRoot(document.getElementById('root')).render(<App />);

// The offline shell (D155). Production only: the dev server has no sw.js to
// register, and a worker cached against a dev origin would shadow HMR.
//
// Registered relative to the DOCUMENT, not to this module - the module lives
// under ./assets/, so a worker registered from there would take a scope that
// excludes index.html and payload.json. `document.baseURI` resolves to the
// deployed base whether that is a Pages sub-path or a domain root, and the
// URL parser drops the hash route, so `#/race/3` registers the same worker as
// `#/` does.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(new URL('sw.js', document.baseURI), { scope: './' })
      // A refused registration is not worth surfacing: the app works, it just
      // will not work in a dead zone, and there is nothing the user can do
      // about it standing at a racetrack.
      .catch(() => {});
  });
}
