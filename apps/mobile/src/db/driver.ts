import * as SQLite from 'expo-sqlite';
import { DatabaseError } from '@budget/db';
import type { SqlParams, SqliteDriver } from '@budget/db';

/**
 * expo-sqlite behind the shared SqliteDriver contract.
 *
 * Correctness here is checked by running DRIVER_CONTRACT from @budget/db on a
 * device — see src/db/driver-contract.native.test.ts. CI cannot run it, so the
 * contract is the only thing keeping this honest against the node driver.
 */

export const DATABASE_NAME = 'budget.db';

export interface ExpoDriverOptions {
  /**
   * Where the file lives. Defaults to expo-sqlite's own directory; a restore
   * passes the path it wrote the archive's snapshot to, because opening that by
   * name alone would silently create an empty database next to the real one
   * instead of reading the snapshot.
   */
  readonly directory?: string;
  /**
   * Open a private connection rather than sharing the cached one.
   *
   * expo-sqlite caches connections by database name, so a second opener of
   * `budget.db` gets the *same* native handle — and closing it closes it for
   * whoever else is holding it. The scheduled backup runs in a process that may
   * still have the app's ledger open, and without this its tidy-up left the
   * running app with a dead database: every query after it failed with a
   * NullPointerException out of `execAsync`. Measured, not theorised.
   */
  readonly ownConnection?: boolean;
}

/**
 * Delete a database by name. Deleting one that does not exist is not an error.
 *
 * Anything else still is — expo-sqlite refuses to delete a database with an
 * open connection, and a scratch file that silently stays behind is the kind of
 * leak nobody notices until the phone is full.
 */
export async function deleteExpoDatabase(name: string): Promise<void> {
  if (name === DATABASE_NAME) {
    throw new DatabaseError(`refusing to delete the ledger (${DATABASE_NAME})`);
  }
  try {
    await SQLite.deleteDatabaseAsync(name);
  } catch (error) {
    if (!/not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
}

/** How a scratch ledger (src/lib/scratch-ledger.ts) is stored on the device. */
export const expoScratchStorage = {
  open: (name: string): Promise<SqliteDriver> => createExpoDriver(name, { ownConnection: true }),
  remove: deleteExpoDatabase,
};

export async function createExpoDriver(
  name: string = DATABASE_NAME,
  options: ExpoDriverOptions = {},
): Promise<SqliteDriver> {
  const db = await SQLite.openDatabaseAsync(
    name,
    options.ownConnection === true ? { useNewConnection: true } : undefined,
    options.directory,
  );

  // Per-connection, and not defaults. Without foreign_keys every referential
  // bug becomes silent corruption; without WAL a write blocks concurrent reads.
  await db.execAsync('PRAGMA journal_mode = WAL');
  await db.execAsync('PRAGMA foreign_keys = ON');
  await db.execAsync('PRAGMA busy_timeout = 5000');

  let inTransaction = false;

  return {
    async exec(sql) {
      await db.execAsync(sql);
    },

    async run(sql, params = []) {
      const result = await db.runAsync(sql, params as SQLite.SQLiteBindValue[]);
      return { changes: result.changes };
    },

    async all<T>(sql: string, params: SqlParams = []) {
      return await db.getAllAsync<T>(sql, params as SQLite.SQLiteBindValue[]);
    },

    async get<T>(sql: string, params: SqlParams = []) {
      const row = await db.getFirstAsync(sql, params as SQLite.SQLiteBindValue[]);
      return (row ?? undefined) as T | undefined;
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (inTransaction) {
        throw new DatabaseError('transactions must not be nested; compose within one call');
      }
      inTransaction = true;
      await db.execAsync('BEGIN');
      try {
        const result = await fn();
        await db.execAsync('COMMIT');
        return result;
      } catch (error) {
        await db.execAsync('ROLLBACK');
        throw error;
      } finally {
        inTransaction = false;
      }
    },

    async close() {
      await db.closeAsync();
    },
  };
}
