/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.WP_API ?? 'http://127.0.0.1:4400';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5290,
    strictPort: true,
    // The browser only talks to /api on its own origin; Vite forwards it to the API server.
    proxy: { '/api': { target: API_TARGET, changeOrigin: false, ws: true } },
  },
  preview: { port: 4290, proxy: { '/api': { target: API_TARGET, ws: true } } },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
