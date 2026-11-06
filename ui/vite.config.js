import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// La UI se sirve desde FastAPI en /ui/; en desarrollo, /api se reenvía a FastAPI local.
export default defineConfig({
  base: '/ui/',
  plugins: [react()],
  server: {port: 5173, proxy: {'/api': process.env.VITE_API_TARGET || 'http://127.0.0.1:8000'}},
  build: {outDir: 'dist', emptyOutDir: true, sourcemap: false},
  test: {environment: 'node', include: ['src/**/*.spec.js']}
});
