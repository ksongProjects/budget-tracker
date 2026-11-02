import { defineConfig } from 'vitest/config';

/**
 * Coverage floors, per package, at what the suite measured when they were set
 * (rounded down). They only ratchet: raise one when a change lifts it, never
 * lower one to make a red run green — a drop means tests were deleted or new
 * code arrived without any.
 *
 * The mobile app's screens are measured by its own Jest suite
 * (apps/mobile/jest.config.js); the floor here covers only the logic modules
 * this runner can load without React Native.
 */
const FLOORS = {
  'packages/backup/src/**': { lines: 95, branches: 82, functions: 98, statements: 93 },
  'packages/crypto/src/**': { lines: 97, branches: 64, functions: 97, statements: 96 },
  'packages/db/src/**': { lines: 96, branches: 87, functions: 96, statements: 95 },
  'packages/extract/src/**': { lines: 97, branches: 87, functions: 98, statements: 94 },
  'packages/report/src/**': { lines: 83, branches: 59, functions: 96, statements: 82 },
  'packages/schema/src/**': { lines: 100, branches: 82, functions: 100, statements: 100 },
  'apps/mobile/src/**': { lines: 25, branches: 31, functions: 27, statements: 26 },
};

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    // The web suite needs a real browser — OPFS, workers and a WASM build do
    // not exist in a simulated DOM. It runs under apps/web's own config.
    exclude: ['**/node_modules/**', 'apps/web/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/mobile/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: FLOORS,
    },
  },
});
