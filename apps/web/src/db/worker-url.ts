/**
 * How the app makes a database worker.
 *
 * Kept apart from the driver because the URL form is bundler syntax, and a
 * driver that hard-codes it cannot be constructed by anything but the app.
 */
export function createDatabaseWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}
