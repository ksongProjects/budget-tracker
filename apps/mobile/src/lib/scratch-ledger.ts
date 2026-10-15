import { migrate } from '@budget/db';
import type { SqliteDriver } from '@budget/db';
import { CurrencySchema, uuidv7 } from '@budget/schema';
import type { MinorUnits, Timestamp } from '@budget/schema';
import { loadDeviceId } from '../db/device-id';
import { buildLedger } from '../db/ledger';
import type { Ledger } from '../db/ledger';

/**
 * A scratch ledger for the screens that need to write test data.
 *
 * The benchmark seeds ten thousand rows and the failure checks feed restores
 * archives they expect to be refused. Both used to do it to whatever ledger was
 * open, and the release build ships both screens — so on a phone holding real
 * spending, a benchmark run would have written ten thousand fake transactions
 * into it, and the next backup would have carried them everywhere.
 *
 * A scratch ledger is a separate database file, opened on its own connection,
 * discarded before it is opened and again when it is closed. Nothing about it
 * can reach the user's ledger, and the type below is how the code that writes
 * test rows says so: it takes a ScratchLedger, which only `openScratchLedger`
 * makes.
 */

export const BENCHMARK_DATABASE = 'benchmark.db';
export const FAILURE_CHECK_DATABASE = 'failure-checks.db';

declare const scratch: unique symbol;

export type ScratchLedger = Ledger & { readonly [scratch]: true };

export interface ScratchDatabase {
  readonly ledger: ScratchLedger;
  /** Close the connection and delete the file. */
  readonly discard: () => Promise<void>;
}

export interface ScratchStorage {
  /** Open a database by name on a connection nobody else holds. */
  readonly open: (name: string) => Promise<SqliteDriver>;
  /** Delete a database by name, if it exists. */
  readonly remove: (name: string) => Promise<void>;
}

export async function openScratchLedger(
  name: string,
  storage: ScratchStorage,
): Promise<ScratchDatabase> {
  // Left over from a run that was killed partway: start from nothing, so a
  // half-seeded file never passes for a full one.
  await storage.remove(name);

  const driver = await storage.open(name);
  await migrate(driver);
  const deviceId = await loadDeviceId(driver);

  return {
    ledger: buildLedger(driver, deviceId) as ScratchLedger,
    discard: async () => {
      await driver.close();
      await storage.remove(name);
    },
  };
}

const USD = CurrencySchema.parse('USD');
const DAY = 86_400_000;

/**
 * Seed rows spread across two years so month grouping and the date index have
 * something real to do.
 */
export async function seed(ledger: ScratchLedger, count: number): Promise<void> {
  const start = Date.now() - 730 * DAY;
  const merchants = ['Blue Bottle Coffee', 'Safeway', 'Shell', 'Tartine Bakery', 'Muni'];
  const notes = ['coffee', 'groceries', 'fuel', 'pastry', 'transit'];

  // One transaction: 10k separate commits would measure fsync, not the queries.
  await ledger.driver.transaction(async () => {
    for (let i = 0; i < count; i += 1) {
      const at = start + (i * (730 * DAY)) / count;
      await ledger.driver.run(
        `INSERT INTO transactions
           (id, amount_minor, currency, occurred_at, source, note, confirmed_at,
            reconciled, rev, updated_at, origin_device)
         VALUES (?, ?, ?, ?, 'manual', ?, ?, 0, 1, ?, ?)`,
        [
          uuidv7(at),
          100 + (i % 9_900),
          USD,
          at,
          `${notes[i % notes.length] ?? ''} ${merchants[i % merchants.length] ?? ''}`,
          at,
          at,
          ledger.deviceId,
        ],
      );
    }
  });
}

/** Insert one row shaped like one the add screen writes, for timing an insert. */
export async function insertBenchmarkRow(ledger: ScratchLedger): Promise<void> {
  const at = Date.now() as Timestamp;
  await ledger.transactions.create({
    captureId: null,
    accountId: null,
    merchantId: null,
    categoryId: null,
    amountMinor: 1234 as MinorUnits,
    currency: USD,
    occurredAt: at,
    postedAt: null,
    note: 'benchmark',
    source: 'manual',
    confirmedAt: at,
    fxOriginalMinor: null,
    fxOriginalCurrency: null,
    fxRate: null,
    reconciled: false,
  });
}
