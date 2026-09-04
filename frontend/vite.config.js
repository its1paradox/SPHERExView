import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Three pages: the main viewer (index.html), the spectrum viewer
// (spectrum.html) and the time-resolved epoch blink (blink.html), both
// opened in new tabs.  API + static cutout requests proxy to the FastAPI
// backend in dev.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        spectrum: resolve(__dirname, 'spectrum.html'),
        blink: resolve(__dirname, 'blink.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/static': 'http://localhost:8000',
    },
  },
});
