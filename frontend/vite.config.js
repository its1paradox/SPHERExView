import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two pages: the main viewer (index.html) and the spectrum viewer opened in
// a new tab (spectrum.html).  API + static cutout requests proxy to the
// FastAPI backend in dev.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        spectrum: resolve(__dirname, 'spectrum.html'),
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
