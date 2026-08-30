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
  test: {
    include: ['src/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
