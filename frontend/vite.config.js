import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Four pages: the main viewer, spectrum viewer, epoch blink and
// six-detector comparison. The auxiliary viewers open in new tabs.
// API + static cutout requests proxy to the FastAPI backend in dev.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        spectrum: resolve(__dirname, 'spectrum.html'),
        blink: resolve(__dirname, 'blink.html'),
        compare: resolve(__dirname, 'compare.html'),
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
