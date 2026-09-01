import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: 'client',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./shared'),
    },
  },
  server: {
    port: Number(process.env.BETSHEET_VITE_PORT) || 5175,
    fs: { allow: ['..'] },
    // Tracks the API port so a second dev instance (or a verification run
    // beside an already-running npm start) can move both ports together.
    proxy: { '/api': `http://localhost:${Number(process.env.BETSHEET_PORT) || 8788}` },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
