import { defineConfig } from 'vite';

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
    // The WASM glue loads its own binary; pre-bundling breaks that.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  build: {
    target: 'es2022',
    // The manifest is what lets the budget check tell code that loads on every
    // visit from code that loads only when someone opens a backup.
    manifest: true,
  },
});
