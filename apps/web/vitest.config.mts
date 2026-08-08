import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The web test runner.
 *
 * Vitest rather than Jest: `motion` is ESM-only and several of the modules under
 * test import it transitively, and `next/jest` drags the whole Next build
 * pipeline into the test process for no benefit here.
 *
 * Deliberately NOT Playwright — a browser suite would need a live API, Postgres,
 * Redis and MinIO in CI to assert what the API's own e2e specs already cover.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json. Resolved through
    // fileURLToPath rather than `new URL(...).pathname`, which yields a
    // leading-slash drive path ("/D:/…") on Windows and fails to resolve.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // `globals` stays off: every spec imports describe/it/expect explicitly, so
    // no ambient types need adding to tsconfig and a reader can see where the
    // helpers come from.
    globals: false,
  },
});
