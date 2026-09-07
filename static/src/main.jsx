import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app.jsx';
// The desktop stylesheet, unmodified: the static app renders the same
// components (TicketBuilder, EntriesTable) and must not grow a second,
// drifting copy of their styles. static.css adds only what is new here.
import '@client/styles.css';
import './static.css';

createRoot(document.getElementById('root')).render(<App />);
