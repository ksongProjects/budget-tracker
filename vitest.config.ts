import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    // The web suite needs a real browser — OPFS, workers and a WASM build do
    // not exist in a simulated DOM. It runs under apps/web's own config.
    exclude: ['**/node_modules/**', 'apps/web/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
