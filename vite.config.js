import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built index.html works when loaded from file:// inside Electron.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
