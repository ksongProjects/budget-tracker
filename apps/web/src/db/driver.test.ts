import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DRIVER_CONTRACT, migrate } from '@budget/db';
import { createWebDriver } from './driver';
import type { WebDriver } from './driver';
import { createDatabaseWorker } from './worker-url';

/**
 * The same contract CI runs against node:sqlite and the phone runs against
 * expo-sqlite, run here against SQLite compiled to WASM over OPFS.
 *
 * This is the claim being checked: that the repositories — plain TypeScript,
 * written once — behave identically on all three. Without it, "shared logic"
 * is an aspiration rather than a fact, and the first divergence would surface
 * as a user's ledger disagreeing with itself across devices.
 *
 * One driver for the whole file, reopened per case. The OPFS pool holds its
 * access handles exclusively for the origin, so a second worker asking for the
 * same pool waits on the first indefinitely — which is exactly what a worker
 * per test produced before this was understood.
 */

let driver: WebDriver;

beforeAll(async () => {
  driver = await createWebDriver({ worker: createDatabaseWorker(), name: 'suite.db' });
});

afterAll(async () => {
  await driver.close();
});

let caseNumber = 0;

/** A database no earlier case has touched. */
async function fresh(): Promise<WebDriver> {
  caseNumber += 1;
  await driver.reopen(`case-${String(caseNumber)}.db`);
  return driver;
}

afterEach(async () => {
  await driver.wipe();
});

describe('the driver contract, in a browser', () => {
  for (const testCase of DRIVER_CONTRACT) {
    it(testCase.name, async () => {
      await testCase.run(await fresh());
    });
  }
});

describe('web specifics', () => {
  it('stores the ledger in OPFS rather than in memory', async () => {
    // The whole local-first story rests on this. Falling back to memory is a
    // supported degraded mode, but it must never be the silent default in a
    // browser that can do better.
    expect((await fresh()).storage).toBe('opfs');
  });

  it('keeps data across a reopen of the same database', async () => {
    // Durability is the reason for OPFS. A driver that passes every contract
    // case in memory would still be useless here.
    const instance = await fresh();
    await instance.exec('CREATE TABLE kept (id TEXT PRIMARY KEY)');
    await instance.run('INSERT INTO kept (id) VALUES (?)', ['a']);

    await instance.reopen('somewhere-else.db');
    await instance.reopen(`case-${String(caseNumber)}.db`);

    expect(await instance.all<{ id: string }>('SELECT id FROM kept')).toEqual([{ id: 'a' }]);
  });

  it('runs the real migrations', async () => {
    const instance = await fresh();
    await migrate(instance);

    const tables = await instance.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );

    expect(tables.map((table) => table.name)).toContain('transactions');
  });

  it('rolls back a failed transaction', async () => {
    const instance = await fresh();
    await instance.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');

    await expect(
      instance.transaction(async () => {
        await instance.run('INSERT INTO t (id) VALUES (?)', ['a']);
        throw new Error('no');
      }),
    ).rejects.toThrow('no');

    expect(await instance.all('SELECT id FROM t')).toEqual([]);
  });
});
