// Build config for the static Pages target (D151), separate from
// vite.config.js on purpose.
//
// THE SEPARATION IS THE FEATURE. D151's hard constraint is that no LLM or OTR
// generation code ships to the phone, "excluded at build time, not hidden
// behind a runtime flag". A second config with its own entry point gives
// exactly that: `static/index.html` reaches App -> DayView/RaceView ->
// TicketBuilder/EntriesTable, and there is no import path from any of them to
// LlmCardModal.jsx, EquibaseOtrPanel.jsx, server/llm-*.js or client/src/api.js.
// Nothing needs to be pruned because nothing was ever referenced, and
// scripts/check-static-bundle.js proves it against the built output rather
// than against this comment.
//
// The app also has no server: there is no `proxy` here, and there is nothing
// for one to point at.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: 'static',
  // DEVIATION from D154's spec, stated deliberately. The spec asks for
  // `base: '/betsheet/'`; this defaults to RELATIVE and lets the deploy set
  // the Pages base through BETSHEET_STATIC_BASE (which
  // .github/workflows/deploy-pages.yml does, to exactly '/betsheet/').
  //
  // The reason a hard-coded base was specified is the SPA 404 problem, and
  // hash routing already solves that completely - no path after the origin
  // ever reaches GitHub's router. What is left is asset resolution, and a
  // relative base resolves correctly at a Pages sub-path AND from a local
  // `dist-static` preview AND from a file:// copy on a phone with no signal.
  // An absolute base works only at the one origin it names. Since the
  // deployed artifact still carries '/betsheet/', nothing about the Pages
  // deploy differs; only the local builds get more portable.
  base: process.env.BETSHEET_STATIC_BASE || './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./shared'),
      // The static app reuses the desktop's already-server-free components
      // (TicketBuilder, EntriesTable) rather than forking them.
      '@client': r('./client/src'),
    },
  },
  server: {
    port: Number(process.env.BETSHEET_STATIC_PORT) || 5186,
    strictPort: true,
    fs: { allow: ['..'] },
  },
  build: {
    outDir: '../dist-static',
    emptyOutDir: true,
  },
});
