import type { SqliteDriver } from './driver.js';
import { DatabaseError } from './driver.js';
import { MIGRATIONS } from './migrations.js';
import type { Migration } from './migrations.js';

export const SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

export async function currentVersion(driver: SqliteDriver): Promise<number> {
  const row = await driver.get<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/**
 * Apply every migration newer than the database's recorded version, in order,
 * each in its own transaction. A failed migration rolls back and leaves
 * `user_version` where it was, so a retry starts from a known point rather than
 * a half-applied schema.
 *
 * A database newer than this build is refused: silently running old code
 * against a new schema is how data gets corrupted.
 */
export async function migrate(
  driver: SqliteDriver,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number> {
  const target = migrations.reduce((highest, m) => Math.max(highest, m.version), 0);
  const from = await currentVersion(driver);

  if (from > target) {
    throw new DatabaseError(
      `database is at schema version ${String(from)}, newer than this build's ${String(target)}; update the app`,
    );
  }

  const pending = [...migrations]
    .filter((migration) => migration.version > from)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    await driver.transaction(async () => {
      await driver.exec(migration.sql);
      // PRAGMA does not accept bound parameters; the value is a checked integer.
      await driver.exec(`PRAGMA user_version = ${String(migration.version)}`);
    });
  }

  return target;
}
