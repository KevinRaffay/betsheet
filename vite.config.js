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
    port: 5175,
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://localhost:8788' },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
