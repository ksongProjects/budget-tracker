import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceId, Timestamp } from '@budget/schema';
import { createNodeDriver } from './drivers/node.js';
import type { SqliteDriver } from './driver.js';
import { migrate } from './migrate.js';
import type { RepositoryContext } from './context.js';
import { chooseWinner, mergeAll, mergeTable } from './merge.js';
import type { MergeableRow } from './merge.js';
import { tombstonesFor } from './tombstones.js';

let driver: SqliteDriver;
let ctx: RepositoryContext;
let clockValue = 1_700_000_000_000;

beforeEach(async () => {
  clockValue = 1_700_000_000_000;
  driver = createNodeDriver();
  await migrate(driver);
  ctx = {
    driver,
    deviceId: 'device-a' as DeviceId,
    clock: (): Timestamp => (clockValue += 1) as Timestamp,
  };
});

afterEach(async () => {
  await driver.close();
});

const row = (over: Partial<MergeableRow> = {}): MergeableRow => ({
  rev: 1,
  updated_at: 1000,
  origin_device: 'device-a',
  ...over,
});

const txn = (over: Partial<MergeableRow> = {}): MergeableRow => ({
  id: 't1',
  capture_id: null,
  account_id: null,
  merchant_id: null,
  category_id: null,
  amount_minor: 1000,
  currency: 'USD',
  occurred_at: 1000,
  posted_at: null,
  note: null,
  source: 'manual',
  confirmed_at: 1000,
  fx_original_minor: null,
  fx_original_currency: null,
  fx_rate: null,
  reconciled: 0,
  rev: 1,
  updated_at: 1000,
  deleted_at: null,
  origin_device: 'device-a',
  ...over,
});

describe('chooseWinner', () => {
  it('prefers the higher rev', () => {
    expect(chooseWinner(row({ rev: 1 }), row({ rev: 2 }))).toBe('incoming');
    expect(chooseWinner(row({ rev: 2 }), row({ rev: 1 }))).toBe('local');
  });

  it('breaks a rev tie with the later timestamp', () => {
    expect(chooseWinner(row({ updated_at: 1000 }), row({ updated_at: 2000 }))).toBe('incoming');
    expect(chooseWinner(row({ updated_at: 2000 }), row({ updated_at: 1000 }))).toBe('local');
  });

  it('breaks a full tie with the device id, so the result is deterministic', () => {
    expect(chooseWinner(row({ origin_device: 'a' }), row({ origin_device: 'b' }))).toBe('incoming');
    expect(chooseWinner(row({ origin_device: 'b' }), row({ origin_device: 'a' }))).toBe('local');
  });

  it('reports identical rows as identical', () => {
    expect(chooseWinner(row(), row())).toBe('identical');
  });

  it('is antisymmetric for every combination', () => {
    // The property that makes merging order-independent: whichever way round
    // the two revisions arrive, the same one wins.
    const revs = [1, 2];
    const times = [1000, 2000];
    const devices = ['device-a', 'device-b'];

    for (const rev of revs) {
      for (const updated of times) {
        for (const device of devices) {
          for (const otherRev of revs) {
            for (const otherUpdated of times) {
              for (const otherDevice of devices) {
                const a = row({ rev, updated_at: updated, origin_device: device });
                const b = row({
                  rev: otherRev,
                  updated_at: otherUpdated,
                  origin_device: otherDevice,
                });

                const forward = chooseWinner(a, b);
                const backward = chooseWinner(b, a);

                if (forward === 'identical') {
                  expect(backward).toBe('identical');
                } else {
                  // "incoming wins" one way must mean "local wins" the other.
                  expect(backward).toBe(forward === 'incoming' ? 'local' : 'incoming');
                }
              }
            }
          }
        }
      }
    }
  });
});

describe('mergeTable', () => {
  it('inserts a row the ledger has never seen', async () => {
    const stats = await mergeTable(ctx, { name: 'transactions', key: 'id' }, [txn()]);

    expect(stats.inserted).toBe(1);
    expect(await driver.get('SELECT id FROM transactions WHERE id = ?', ['t1'])).toBeDefined();
  });

  it('keeps the local row when it is newer', async () => {
    await mergeTable(ctx, { name: 'transactions', key: 'id' }, [txn({ rev: 5, amount_minor: 500 })]);
    const stats = await mergeTable(ctx, { name: 'transactions', key: 'id' }, [
      txn({ rev: 2, amount_minor: 999 }),
    ]);

    expect(stats.kept).toBe(1);
    const stored = await driver.get<{ amount_minor: number }>(
      'SELECT amount_minor FROM transactions WHERE id = ?',
      ['t1'],
    );
    expect(stored?.amount_minor).toBe(500);
  });

  it('takes the incoming row when it is newer, and keeps the old one', async () => {
    await mergeTable(ctx, { name: 'transactions', key: 'id' }, [txn({ rev: 1, amount_minor: 500 })]);
    const stats = await mergeTable(ctx, { name: 'transactions', key: 'id' }, [
      txn({ rev: 2, amount_minor: 999 }),
    ]);

    expect(stats.updated).toBe(1);
    expect(stats.tombstoned).toBe(1);

    const stored = await driver.get<{ amount_minor: number }>(
      'SELECT amount_minor FROM transactions WHERE id = ?',
      ['t1'],
    );
    expect(stored?.amount_minor).toBe(999);

    // The overwritten amount is still recoverable.
    const history = await tombstonesFor(ctx, 'transactions', 't1');
    const payload = JSON.parse(history[0]?.payload ?? '{}') as { amount_minor: number };
    expect(payload.amount_minor).toBe(500);
  });

  it('treats a delete as a value, so a later edit can win over it', async () => {
    await mergeTable(ctx, { name: 'transactions', key: 'id' }, [
      txn({ rev: 3, deleted_at: 5000 }),
    ]);
    await mergeTable(ctx, { name: 'transactions', key: 'id' }, [
      txn({ rev: 4, deleted_at: null, amount_minor: 777 }),
    ]);

    const stored = await driver.get<{ deleted_at: number | null; amount_minor: number }>(
      'SELECT deleted_at, amount_minor FROM transactions WHERE id = ?',
      ['t1'],
    );
    expect(stored?.deleted_at).toBeNull();
    expect(stored?.amount_minor).toBe(777);
  });

  it('carries a delete in when the delete is newer', async () => {
    await mergeTable(ctx, { name: 'transactions', key: 'id' }, [txn({ rev: 1 })]);
    await mergeTable(ctx, { name: 'transactions', key: 'id' }, [
      txn({ rev: 2, deleted_at: 5000 }),
    ]);

    const stored = await driver.get<{ deleted_at: number | null }>(
      'SELECT deleted_at FROM transactions WHERE id = ?',
      ['t1'],
    );
    expect(stored?.deleted_at).toBe(5000);
  });
});

describe('merging is order-independent', () => {
  /** Apply two divergent edits of the same row in both orders. */
  const applyBothOrders = async (
    first: MergeableRow,
    second: MergeableRow,
  ): Promise<[Record<string, unknown>, Record<string, unknown>]> => {
    const table = { name: 'transactions', key: 'id' } as const;

    const forwardDriver = createNodeDriver();
    await migrate(forwardDriver);
    const forwardCtx = { ...ctx, driver: forwardDriver };
    await mergeTable(forwardCtx, table, [first]);
    await mergeTable(forwardCtx, table, [second]);
    const forward = await forwardDriver.get<Record<string, unknown>>(
      'SELECT * FROM transactions WHERE id = ?',
      ['t1'],
    );
    await forwardDriver.close();

    const backwardDriver = createNodeDriver();
    await migrate(backwardDriver);
    const backwardCtx = { ...ctx, driver: backwardDriver };
    await mergeTable(backwardCtx, table, [second]);
    await mergeTable(backwardCtx, table, [first]);
    const backward = await backwardDriver.get<Record<string, unknown>>(
      'SELECT * FROM transactions WHERE id = ?',
      ['t1'],
    );
    await backwardDriver.close();

    return [forward ?? {}, backward ?? {}];
  };

  it('reaches the same ledger whichever order two backups are restored in', async () => {
    const [forward, backward] = await applyBothOrders(
      txn({ rev: 2, updated_at: 2000, origin_device: 'device-a', amount_minor: 100 }),
      txn({ rev: 3, updated_at: 1000, origin_device: 'device-b', amount_minor: 200 }),
    );

    expect(forward).toEqual(backward);
    expect(forward['amount_minor']).toBe(200);
  });

  it('is order-independent even when rev and timestamp both tie', async () => {
    const [forward, backward] = await applyBothOrders(
      txn({ rev: 2, updated_at: 2000, origin_device: 'device-a', amount_minor: 100 }),
      txn({ rev: 2, updated_at: 2000, origin_device: 'device-b', amount_minor: 200 }),
    );

    expect(forward).toEqual(backward);
    // The device tie-break decides, and decides the same way both times.
    expect(forward['amount_minor']).toBe(200);
  });

  it('is order-independent when only the timestamp differs', async () => {
    const [forward, backward] = await applyBothOrders(
      txn({ rev: 1, updated_at: 3000, amount_minor: 100 }),
      txn({ rev: 1, updated_at: 9000, amount_minor: 200 }),
    );

    expect(forward).toEqual(backward);
    expect(forward['amount_minor']).toBe(200);
  });
});

describe('mergeAll', () => {
  it('merges tables in an order that satisfies foreign keys', async () => {
    const stats = await mergeAll(ctx, {
      merchants: [row({ id: 'm1', canonical_name: 'Blue Bottle', deleted_at: null })],
      transactions: [txn({ merchant_id: 'm1' })],
    });

    expect(stats['merchants']?.inserted).toBe(1);
    expect(stats['transactions']?.inserted).toBe(1);
  });

  it('rolls back completely when any row fails', async () => {
    await expect(
      mergeAll(ctx, {
        // The merchant this transaction points at is not in the archive.
        transactions: [txn({ merchant_id: 'missing' })],
      }),
    ).rejects.toThrow();

    // A half-applied merge would leave a ledger that is neither the old one nor
    // the new one.
    const count = await driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(count?.n).toBe(0);
  });

  it('is idempotent: merging the same backup twice changes nothing', async () => {
    const rows = {
      merchants: [row({ id: 'm1', canonical_name: 'Blue Bottle', deleted_at: null })],
      transactions: [txn({ merchant_id: 'm1' })],
    };

    await mergeAll(ctx, rows);
    const afterFirst = await driver.all('SELECT * FROM transactions');

    const stats = await mergeAll(ctx, rows);
    const afterSecond = await driver.all('SELECT * FROM transactions');

    expect(afterSecond).toEqual(afterFirst);
    expect(stats['transactions']?.kept).toBe(1);
    expect(stats['transactions']?.updated).toBe(0);
    // Re-importing a backup must not fill the tombstone log with noise.
    expect(await tombstonesFor(ctx, 'transactions', 't1')).toHaveLength(0);
  });

  it('applies the newer of two revisions of one row in the same batch', async () => {
    // Batched lookups must not compare the second copy against a stale row.
    await mergeTable(ctx, { name: 'transactions', key: 'id' }, [
      txn({ rev: 1, amount_minor: 100 }),
      txn({ rev: 2, amount_minor: 200 }),
    ]);

    const stored = await driver.get<{ amount_minor: number }>(
      'SELECT amount_minor FROM transactions WHERE id = ?',
      ['t1'],
    );
    expect(stored?.amount_minor).toBe(200);
  });

  it('keeps the newer revision when the older one comes second', async () => {
    await mergeTable(ctx, { name: 'transactions', key: 'id' }, [
      txn({ rev: 2, amount_minor: 200 }),
      txn({ rev: 1, amount_minor: 100 }),
    ]);

    const stored = await driver.get<{ amount_minor: number }>(
      'SELECT amount_minor FROM transactions WHERE id = ?',
      ['t1'],
    );
    expect(stored?.amount_minor).toBe(200);
  });

  it('ignores tables the archive does not carry', async () => {
    const stats = await mergeAll(ctx, { transactions: [txn()] });
    expect(stats['merchants']).toBeUndefined();
  });
});

/**
 * What a restore does when something goes wrong halfway.
 *
 * A restore merges seven tables in one pass. If the fourth one fails, the three
 * before it must not remain — a ledger holding half of someone's backup is
 * worse than one holding none of it, because nothing tells the user which half
 * they got. The transaction around `mergeAll` is what guarantees that, and this
 * is the test that says so.
 */
describe('a merge that fails partway', () => {
  it('leaves the ledger exactly as it was', async () => {
    await mergeAll(ctx, {
      merchants: [row({ id: 'm-existing', canonical_name: 'Existing', deleted_at: null })],
    });

    const before = await driver.all<{ id: string }>('SELECT id FROM merchants ORDER BY id');

    await expect(
      mergeAll(ctx, {
        merchants: [row({ id: 'm-new', canonical_name: 'Arrives first', deleted_at: null })],
        // A transaction row pointing at a capture that is not in the archive.
        // The foreign key fails, and it fails *after* the merchant above has
        // already been inserted inside the same transaction.
        transactions: [txn({ id: 't-broken', capture_id: 'capture-that-does-not-exist' })],
      }),
    ).rejects.toThrow();

    const after = await driver.all<{ id: string }>('SELECT id FROM merchants ORDER BY id');

    expect(after).toEqual(before);
    expect(await driver.all('SELECT id FROM transactions')).toEqual([]);
  });

  it('reports the failure rather than returning partial statistics', async () => {
    // Silently returning "3 tables merged" for a restore that did not happen is
    // the failure mode this rules out: the screen would say it worked.
    await expect(
      mergeAll(ctx, {
        transactions: [txn({ id: 't-broken', capture_id: 'nope' })],
      }),
    ).rejects.toThrow();
  });
});

/**
 * The profile is ledger data, not a device setting.
 *
 * Someone restoring onto a new phone has just lost the old one. Asking them to
 * type their name and pick a currency again, on that day, to see their own
 * money, is the wrong moment for a form.
 */
describe('merging the profile', () => {
  it('arrives with a restore', async () => {
    await mergeAll(ctx, {
      profile: [
        row({
          id: 'profile',
          display_name: 'Sam',
          email: 'sam@example.com',
          default_currency: 'EUR',
          deleted_at: null,
        }),
      ],
    });

    const found = await driver.get<{ display_name: string; default_currency: string }>(
      'SELECT display_name, default_currency FROM profile',
    );

    expect(found).toMatchObject({ display_name: 'Sam', default_currency: 'EUR' });
  });

  it('keeps the newer of two, like every other row', async () => {
    const base = {
      id: 'profile',
      display_name: 'Old name',
      email: null,
      default_currency: 'USD',
      deleted_at: null,
    };

    await mergeAll(ctx, { profile: [row({ ...base, rev: 2 })] });
    await mergeAll(ctx, { profile: [row({ ...base, display_name: 'Older', rev: 1 })] });

    const found = await driver.get<{ display_name: string }>('SELECT display_name FROM profile');
    expect(found?.display_name).toBe('Old name');
  });
});
