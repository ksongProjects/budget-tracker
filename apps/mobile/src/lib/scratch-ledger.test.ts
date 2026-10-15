import { describe, expect, it } from 'vitest';
import { createNodeDriver } from '@budget/db/drivers/node';
import type { SqliteDriver } from '@budget/db';
import {
  BENCHMARK_DATABASE,
  FAILURE_CHECK_DATABASE,
  insertBenchmarkRow,
  openScratchLedger,
  seed,
} from './scratch-ledger';
import type { ScratchLedger, ScratchStorage } from './scratch-ledger';
import type { Ledger } from '../db/ledger';

/** The app's own database name, from src/db/driver.ts, which needs a device to import. */
const LEDGER_DATABASE = 'budget.db';

/** In-memory storage that records every name it is asked to open or remove. */
function recordingStorage(): ScratchStorage & {
  readonly opened: string[];
  readonly removed: string[];
  readonly drivers: SqliteDriver[];
} {
  const opened: string[] = [];
  const removed: string[] = [];
  const drivers: SqliteDriver[] = [];

  return {
    opened,
    removed,
    drivers,
    open: (name) => {
      opened.push(name);
      const driver = createNodeDriver();
      drivers.push(driver);
      return Promise.resolve(driver);
    },
    remove: (name) => {
      removed.push(name);
      return Promise.resolve();
    },
  };
}

async function count(ledger: ScratchLedger): Promise<number> {
  return (
    (await ledger.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions'))?.n ?? 0
  );
}

describe('scratch ledgers', () => {
  it('are never the ledger', () => {
    expect(BENCHMARK_DATABASE).not.toBe(LEDGER_DATABASE);
    expect(FAILURE_CHECK_DATABASE).not.toBe(LEDGER_DATABASE);
    expect(BENCHMARK_DATABASE).not.toBe(FAILURE_CHECK_DATABASE);
  });

  it('open only the file they were named, and clear it first', async () => {
    const storage = recordingStorage();
    const scratch = await openScratchLedger(BENCHMARK_DATABASE, storage);

    expect(storage.opened).toEqual([BENCHMARK_DATABASE]);
    // Removed before opening, so a half-seeded file from a killed run is gone.
    expect(storage.removed).toEqual([BENCHMARK_DATABASE]);

    await scratch.discard();
  });

  it('are migrated and usable', async () => {
    const scratch = await openScratchLedger(BENCHMARK_DATABASE, recordingStorage());

    await seed(scratch.ledger, 40);
    await insertBenchmarkRow(scratch.ledger);

    expect(await count(scratch.ledger)).toBe(41);
    expect(await scratch.ledger.transactions.list({ limit: 50 })).toHaveLength(41);
    expect(await scratch.ledger.transactions.search('coffee')).not.toHaveLength(0);

    await scratch.discard();
  });

  it('close and delete their file when discarded', async () => {
    const storage = recordingStorage();
    const scratch = await openScratchLedger(FAILURE_CHECK_DATABASE, storage);

    await scratch.discard();

    expect(storage.removed).toEqual([FAILURE_CHECK_DATABASE, FAILURE_CHECK_DATABASE]);
    await expect(storage.drivers[0]?.get('SELECT 1')).rejects.toThrow();
  });

  it('are the only thing test rows can be written to', () => {
    // Compile-time, and the reason ScratchLedger is a distinct type: the app's
    // ledger is a Ledger, and seeding one is a type error rather than a habit.
    const appLedger = {} as Ledger;
    // @ts-expect-error a Ledger is not a ScratchLedger
    const attempt = (): Promise<void> => seed(appLedger, 1);
    expect(typeof attempt).toBe('function');
  });
});
