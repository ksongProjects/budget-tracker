import { afterEach, describe, expect, it } from 'vitest';
import { createNodeDriver } from './drivers/node.js';
import type { SqliteDriver } from './driver.js';
import { DatabaseError } from './driver.js';
import { MIGRATIONS } from './migrations.js';
import { SCHEMA_VERSION, currentVersion, migrate } from './migrate.js';

let driver: SqliteDriver | undefined;

const open = (): SqliteDriver => {
  driver = createNodeDriver();
  return driver;
};

afterEach(async () => {
  await driver?.close();
  driver = undefined;
});

const tableNames = async (db: SqliteDriver): Promise<string[]> => {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return rows.map((row) => row.name);
};

describe('migrate', () => {
  it('applies every migration from an empty database', async () => {
    const db = open();
    expect(await currentVersion(db)).toBe(0);

    await migrate(db);

    expect(await currentVersion(db)).toBe(SCHEMA_VERSION);
    expect(await tableNames(db)).toEqual(
      expect.arrayContaining([
        'accounts',
        'captures',
        'categories',
        'extractions',
        'line_items',
        'merchant_aliases',
        'merchants',
        'settings',
        'tombstones',
        'transactions',
      ]),
    );
  });

  it('is idempotent', async () => {
    const db = open();
    await migrate(db);
    const after = await tableNames(db);

    await migrate(db);
    await migrate(db);

    expect(await currentVersion(db)).toBe(SCHEMA_VERSION);
    expect(await tableNames(db)).toEqual(after);
  });

  it('applies from each intermediate version, which is what a shipped device does', async () => {
    for (let stop = 1; stop <= SCHEMA_VERSION; stop += 1) {
      const db = createNodeDriver();
      try {
        const partial = MIGRATIONS.filter((m) => m.version <= stop);
        await migrate(db, partial);
        expect(await currentVersion(db)).toBe(stop);

        // Now upgrade the rest of the way, as an app update would.
        await migrate(db);
        expect(await currentVersion(db)).toBe(SCHEMA_VERSION);
      } finally {
        await db.close();
      }
    }
  });

  it('refuses a database newer than the build rather than corrupting it', async () => {
    const db = open();
    await migrate(db);
    await db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 5)}`);

    await expect(migrate(db)).rejects.toThrow(DatabaseError);
  });

  it('rolls back a failing migration and leaves the version untouched', async () => {
    const db = open();
    await migrate(db);
    const before = await currentVersion(db);

    const broken = [
      ...MIGRATIONS,
      { version: SCHEMA_VERSION + 1, name: 'broken', sql: 'CREATE TABLE oops (id TEXT); SELECT nonexistent_fn();' },
    ];

    await expect(migrate(db, broken)).rejects.toThrow();
    expect(await currentVersion(db)).toBe(before);

    const tables = await tableNames(db);
    expect(tables).not.toContain('oops');
  });

  it('records a version for every migration, with no duplicates or gaps', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1));
  });
});

describe('schema constraints', () => {
  it('rejects an unknown capture kind', async () => {
    const db = open();
    await migrate(db);

    await expect(
      db.run(
        `INSERT INTO captures (capture_id, kind, captured_at, updated_at, origin_device)
         VALUES ('c1', 'telepathy', 1, 1, 'dev')`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a foreign-currency amount without its rate', async () => {
    const db = open();
    await migrate(db);

    await expect(
      db.run(
        `INSERT INTO transactions
           (id, amount_minor, currency, occurred_at, source, updated_at, origin_device,
            fx_original_minor, fx_original_currency, fx_rate)
         VALUES ('t1', 100, 'USD', 1, 'manual', 1, 'dev', 1500, 'EUR', NULL)`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-positive exchange rate', async () => {
    const db = open();
    await migrate(db);

    await expect(
      db.run(
        `INSERT INTO transactions
           (id, amount_minor, currency, occurred_at, source, updated_at, origin_device,
            fx_original_minor, fx_original_currency, fx_rate)
         VALUES ('t1', 100, 'USD', 1, 'manual', 1, 'dev', 1500, 'EUR', 0)`,
      ),
    ).rejects.toThrow();
  });

  it('enforces foreign keys', async () => {
    const db = open();
    await migrate(db);

    await expect(
      db.run(
        `INSERT INTO transactions (id, merchant_id, amount_minor, currency, occurred_at, source, updated_at, origin_device)
         VALUES ('t1', 'no-such-merchant', 100, 'USD', 1, 'manual', 1, 'dev')`,
      ),
    ).rejects.toThrow();
  });
});

describe('full-text search', () => {
  it('indexes notes and merchant names through the triggers', async () => {
    const db = open();
    await migrate(db);

    await db.run(
      `INSERT INTO merchants (id, canonical_name, updated_at, origin_device)
       VALUES ('m1', 'Blue Bottle Coffee', 1, 'dev')`,
    );
    await db.run(
      `INSERT INTO transactions (id, merchant_id, amount_minor, currency, occurred_at, source, note, updated_at, origin_device)
       VALUES ('t1', 'm1', 550, 'USD', 1, 'photo', 'oat latte before the flight', 1, 'dev')`,
    );

    const byNote = await db.all<{ id: string }>(
      `SELECT t.id FROM transactions_fts f JOIN transactions t ON t.rowid = f.rowid
       WHERE transactions_fts MATCH ?`,
      ['latte'],
    );
    expect(byNote.map((r) => r.id)).toEqual(['t1']);

    const byMerchant = await db.all<{ id: string }>(
      `SELECT t.id FROM transactions_fts f JOIN transactions t ON t.rowid = f.rowid
       WHERE transactions_fts MATCH ?`,
      ['bottle'],
    );
    expect(byMerchant.map((r) => r.id)).toEqual(['t1']);
  });

  it('keeps the index in step when a note changes', async () => {
    const db = open();
    await migrate(db);

    await db.run(
      `INSERT INTO transactions (id, amount_minor, currency, occurred_at, source, note, updated_at, origin_device)
       VALUES ('t1', 550, 'USD', 1, 'manual', 'parking meter', 1, 'dev')`,
    );
    await db.run(`UPDATE transactions SET note = 'bridge toll' WHERE id = 't1'`);

    const stale = await db.all(`SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH ?`, ['parking']);
    const fresh = await db.all(`SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH ?`, ['toll']);

    expect(stale).toHaveLength(0);
    expect(fresh).toHaveLength(1);
  });
});
