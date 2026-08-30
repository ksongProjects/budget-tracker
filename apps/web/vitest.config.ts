import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

/**
 * The web suite runs in a real browser, not a simulated DOM.
 *
 * OPFS, workers and the SQLite WASM build are the things being checked, and
 * none of them exist in a shim. A green suite under happy-dom would be a green
 * suite that proves nothing about the storage the ledger actually lives in.
 */
export default defineConfig({
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
