import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5311, strictPort: true },
  build: { target: 'es2020', assetsInlineLimit: 0, chunkSizeWarningLimit: 400 },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
