import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Порт бэкенда для /api-прокси: BACKEND_PORT=8015 ./scripts/dev.sh
const API = `http://127.0.0.1:${process.env.BACKEND_PORT ?? '8011'}`;

// Сборка кладётся в web/dist (в git не хранится): сервер — только каталог + uvicorn.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../web/dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    port: 8010,
    strictPort: true,
    proxy: {
      // Живая проверка: uvicorn из app/main.py на 8011 (порт 8000 занят сервером Льва).
      '/api': API,
    },
  },
  preview: {
    port: 8012,
    strictPort: true,
    proxy: {
      '/api': API,
    },
  },
  test: {
    environment: 'jsdom',
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/setupTests.ts'],
  },
});
