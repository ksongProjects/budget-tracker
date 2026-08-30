/**
 * @budget/db — the local SQLite ledger: schema, migrations, and repositories.
 * See docs/data-model.md.
 *
 * Platform drivers are separate entry points on purpose. Importing this module
 * must never pull `node:sqlite` into a mobile or browser bundle.
 */
export * from './driver.js';
export * from './context.js';
export * from './migrate.js';
export * from './mapping.js';
export * from './transactions.js';
export * from './categories.js';
export * from './accounts.js';
export * from './driver-contract.js';
export * from './tombstones.js';
export * from './merchants.js';
export type { Migration } from './migrations.js';
export { MIGRATIONS } from './migrations.js';
export * from './merge.js';
