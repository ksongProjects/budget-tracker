import type { SqliteDriver } from './driver.js';

/**
 * Behaviour every SqliteDriver must exhibit, as data rather than as a test file.
 *
 * The node driver is verified in CI, but expo-sqlite and SQLite WASM can only be
 * exercised on a device or in a browser, where this repository's test runner
 * does not reach. Shipping the contract as plain functions lets each platform
 * run the same cases in whatever harness it has — and makes "the mobile driver
 * behaves like the tested one" a checked claim instead of an assumption.
 *
 * Deliberately free of any test framework and any Node API.
 */

export interface DriverContractCase {
  readonly name: string;
  run(driver: SqliteDriver): Promise<void>;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`driver contract: ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  assert(
    actual === expected,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

async function setup(driver: SqliteDriver): Promise<void> {
  await driver.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, s TEXT)');
}

export const DRIVER_CONTRACT: readonly DriverContractCase[] = [
  {
    name: 'exec runs statements and all reads them back',
    async run(driver) {
      await setup(driver);
      await driver.exec("INSERT INTO t (id, n) VALUES ('a', 1)");

      const rows = await driver.all<{ id: string; n: number }>('SELECT id, n FROM t');
      assertEqual(rows.length, 1, 'expected one row');
      assertEqual(rows[0]?.id, 'a', 'wrong id');
      assertEqual(rows[0]?.n, 1, 'wrong n');
    },
  },
  {
    name: 'get returns one row, or undefined when there is none',
    async run(driver) {
      await setup(driver);
      await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);

      const found = await driver.get<{ id: string }>('SELECT id FROM t WHERE id = ?', ['a']);
      assertEqual(found?.id, 'a', 'expected to find the row');

      const missing = await driver.get('SELECT id FROM t WHERE id = ?', ['nope']);
      assertEqual(missing, undefined, 'expected undefined for no match');
    },
  },
  {
    name: 'run reports how many rows changed',
    async run(driver) {
      await setup(driver);
      await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
      await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['b', 2]);

      const result = await driver.run('UPDATE t SET n = n + 1');
      assertEqual(result.changes, 2, 'wrong change count');
    },
  },
  {
    name: 'parameters bind by position, including null',
    async run(driver) {
      await setup(driver);
      await driver.run('INSERT INTO t (id, n, s) VALUES (?, ?, ?)', ['a', null, 'text']);

      const row = await driver.get<{ n: number | null; s: string }>(
        'SELECT n, s FROM t WHERE id = ?',
        ['a'],
      );
      assertEqual(row?.n, null, 'null did not round-trip');
      assertEqual(row?.s, 'text', 'string did not round-trip');
    },
  },
  {
    name: 'integers survive to the safe-integer boundary',
    async run(driver) {
      // Money is stored as integer minor units. A driver that routes integers
      // through a float loses precision here, and every large amount is wrong.
      await setup(driver);
      const big = Number.MAX_SAFE_INTEGER;
      await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', big]);

      const row = await driver.get<{ n: number }>('SELECT n FROM t WHERE id = ?', ['a']);
      assertEqual(row?.n, big, 'large integer lost precision');
      assertEqual(typeof row?.n, 'number', 'integer came back as the wrong type');
    },
  },
  {
    name: 'negative integers round-trip',
    async run(driver) {
      await setup(driver);
      await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', -12_345]);

      const row = await driver.get<{ n: number }>('SELECT n FROM t WHERE id = ?', ['a']);
      assertEqual(row?.n, -12_345, 'negative integer did not round-trip');
    },
  },
  {
    name: 'a transaction commits its writes',
    async run(driver) {
      await setup(driver);
      await driver.transaction(async () => {
        await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
        await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['b', 2]);
      });

      const rows = await driver.all('SELECT id FROM t');
      assertEqual(rows.length, 2, 'committed rows are missing');
    },
  },
  {
    name: 'a throwing transaction rolls back every write in it',
    async run(driver) {
      await setup(driver);
      await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['keep', 1]);

      let threw = false;
      try {
        await driver.transaction(async () => {
          await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['gone', 2]);
          throw new Error('rollback please');
        });
      } catch {
        threw = true;
      }

      assert(threw, 'transaction swallowed the error');

      const rows = await driver.all<{ id: string }>('SELECT id FROM t');
      assertEqual(rows.length, 1, 'rollback left rows behind');
      assertEqual(rows[0]?.id, 'keep', 'rollback removed the wrong row');
    },
  },
  {
    name: 'a transaction returns its callback value',
    async run(driver) {
      await setup(driver);
      const result = await driver.transaction(async () => {
        await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
        return 'value';
      });
      assertEqual(result, 'value', 'transaction did not return the callback value');
    },
  },
  {
    name: 'nested transactions are refused rather than silently flattened',
    async run(driver) {
      await setup(driver);

      let threw = false;
      try {
        await driver.transaction(async () => {
          await driver.transaction(async () => {
            await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
          });
        });
      } catch {
        threw = true;
      }

      assert(threw, 'nested transaction was allowed; rollback semantics would be a lie');
    },
  },
  {
    name: 'SQL errors reject rather than throwing synchronously',
    async run(driver) {
      await setup(driver);

      // A driver that throws synchronously forces callers to write both a
      // try/catch and a .catch for the same failure. Typed as unknown because
      // the point is to check the runtime value, not what the types claim.
      const promise: unknown = driver.run('INSERT INTO nonexistent_table (x) VALUES (1)');
      assert(
        typeof (promise as { then?: unknown }).then === 'function',
        'run did not return a promise',
      );

      let rejected = false;
      try {
        await promise;
      } catch {
        rejected = true;
      }
      assert(rejected, 'a bad statement did not reject');
    },
  },
  {
    name: 'a constraint violation rejects and leaves the row untouched',
    async run(driver) {
      await setup(driver);
      await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);

      let rejected = false;
      try {
        await driver.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 2]);
      } catch {
        rejected = true;
      }
      assert(rejected, 'duplicate primary key was accepted');

      const row = await driver.get<{ n: number }>('SELECT n FROM t WHERE id = ?', ['a']);
      assertEqual(row?.n, 1, 'failed insert modified the existing row');
    },
  },
  {
    name: 'foreign keys are enforced',
    async run(driver) {
      // PRAGMA foreign_keys is per-connection and off by default. A driver that
      // forgets it turns every referential bug into silent corruption.
      await driver.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)');
      await driver.exec('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))');

      let rejected = false;
      try {
        await driver.run('INSERT INTO child (id, parent_id) VALUES (?, ?)', ['c', 'missing']);
      } catch {
        rejected = true;
      }
      assert(rejected, 'foreign keys are not enforced on this connection');
    },
  },
];
