/**
 * @budget/db — the local SQLite ledger: schema, migrations, and repositories.
 * See docs/data-model.md.
 *
 * Platform drivers are separate entry points on purpose. Importing this module
 * must never pull `node:sqlite` into a mobile or browser bundle.
 */
export * from './driver.js';
export * from './migrate.js';
export type { Migration } from './migrations.js';
export { MIGRATIONS } from './migrations.js';
