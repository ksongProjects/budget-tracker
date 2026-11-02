import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

/**
 * The web suite runs in a real browser, not a simulated DOM.
 *
 * OPFS, workers and the SQLite WASM build are the things being checked, and
 * none of them exist in a shim. A green suite under happy-dom would be a green
 * suite that proves nothing about the storage the ledger actually lives in.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The bundler-friendly SQLite build, by path rather than by specifier. */
function sqliteModule(): string {
  const packageJson = createRequire(import.meta.url).resolve('@sqlite.org/sqlite-wasm/package.json');
  return join(dirname(packageJson), 'sqlite-wasm', 'jswasm', 'sqlite3-bundler-friendly.mjs');
}

export default defineConfig({
  resolve: {
    alias: {
      // The package's entry also pulls in its "worker1" promiser, which this
      // app does not use and which costs about 200 KB uncompressed. Aliasing
      // straight to the module we do use drops it. It has to be a resolved file
      // path: the deep specifier is not in the package's exports map, so asking
      // for it by name fails.
      '@sqlite.org/sqlite-wasm': sqliteModule(),
    },
  },
  optimizeDeps: {
    // The WASM glue is served as-is; pre-bundling it breaks its own loader.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  define: {
    // The connector under test is pointed at the stand-in, not at Google.
    'import.meta.env.VITE_FAKE_DRIVE_URL': JSON.stringify('http://localhost:8788'),
  },
  test: {
    include: ['src/**/*.test.ts'],
    // One file at a time. The OPFS pool hands its access handles to a single
    // holder per origin, so two suites opening databases at once means the
    // second waits on the first and times out — intermittently, depending on
    // which finishes when.
    fileParallelism: false,
    globalSetup: ['./test/fake-drive-server.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The database worker runs in a Worker, which v8 coverage in the page
      // cannot see; driver.test.ts exercises it through the driver. main.ts
      // is the two-line entry point.
      exclude: ['**/*.test.ts', 'src/db/worker.ts', 'src/main.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      // Floors at what was measured when they were set, rounded down. They
      // only ratchet — see the root vitest.config.ts.
      thresholds: { lines: 81, branches: 57, functions: 75, statements: 79 },
    },
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
