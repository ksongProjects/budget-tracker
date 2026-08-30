import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // The WASM glue loads its own binary; pre-bundling breaks that.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  build: {
    target: 'es2022',
  },
});
