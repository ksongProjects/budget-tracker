import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, systemClock } from '@budget/db';
import { createNodeDriver } from '@budget/db/drivers/node';
import type { RepositoryContext, SqliteDriver } from '@budget/db';
import type { DeviceId } from '@budget/schema';
import { ledgerChangedSince, runScheduledBackup } from './schedule';
import type { BackupHooks } from './schedule';

/**
 * These run against a real SQLite ledger, because the question they answer —
 * "is there anything here that is not in a backup yet?" — is a question about
 * SQL, and a mock would only confirm the SQL I already believe.
 */

let driver: SqliteDriver;
let ctx: RepositoryContext;

beforeEach(async () => {
  driver = createNodeDriver();
  await migrate(driver);
  ctx = { driver, deviceId: 'device-a' as DeviceId, clock: systemClock };
});

afterEach(async () => {
  await driver.close();
});

async function insertTransaction(updatedAt: number, id = `t-${String(updatedAt)}`): Promise<void> {
  await driver.run(
    `INSERT INTO transactions
       (id, amount_minor, currency, occurred_at, source, confirmed_at,
        reconciled, rev, updated_at, origin_device)
     VALUES (?, 500, 'USD', ?, 'manual', ?, 0, 1, ?, 'device-a')`,
    [id, updatedAt, updatedAt, updatedAt],
  );
}

const MINUTE = 60_000;
const SIX_HOURS = 6 * 60 * MINUTE;
const NOW = 10_000_000_000;
/** Older than the interval, so only the "did anything change" guard is left. */
const STALE = NOW - 7 * 60 * MINUTE;

describe('ledgerChangedSince', () => {
  it('is false on an untouched ledger', async () => {
    await insertTransaction(1000);
    expect(await ledgerChangedSince(ctx, 2000)).toBe(false);
  });

  it('is true when a row was written after the backup', async () => {
    await insertTransaction(3000);
    expect(await ledgerChangedSince(ctx, 2000)).toBe(true);
  });

  it('counts a row written in the same millisecond as the backup', async () => {
    // Inclusive on purpose. An exclusive comparison would drop this row from
    // every future backup until something unrelated changed it — silent loss of
    // money data, which is worse than one redundant backup.
    await insertTransaction(2000);
    expect(await ledgerChangedSince(ctx, 2000)).toBe(true);
  });

  it('sees a change in any backed-up table, not just transactions', async () => {
    await driver.run(
      `INSERT INTO categories (id, name, rev, updated_at, origin_device)
       VALUES ('c1', 'Coffee', 1, ?, 'device-a')`,
      [5000],
    );

    expect(await ledgerChangedSince(ctx, 4000)).toBe(true);
  });

  it('is false on a completely empty ledger', async () => {
    // Every MAX() is null here; a null must not read as "changed" and trigger a
    // backup of nothing on every single app switch.
    expect(await ledgerChangedSince(ctx, 0)).toBe(false);
  });
});

describe('runScheduledBackup', () => {
  const hooks = (over: Partial<BackupHooks> = {}): BackupHooks => ({
    isSetUp: vi.fn(() => Promise.resolve(true)),
    lastBackupAt: vi.fn(() => Promise.resolve<number | undefined>(undefined)),
    writeBackup: vi.fn(() => Promise.resolve({ bytes: 1024, pruned: 0 })),
    now: () => NOW,
    ...over,
  });

  it('does nothing before backup has been set up', async () => {
    const deps = hooks({ isSetUp: vi.fn(() => Promise.resolve(false)) });
    const report = await runScheduledBackup(ctx, deps, { minIntervalMs: SIX_HOURS });

    expect(report.outcome).toBe('not-set-up');
    expect(deps.writeBackup).not.toHaveBeenCalled();
  });

  it('writes the first backup even though nothing has changed since one', async () => {
    const deps = hooks();
    const report = await runScheduledBackup(ctx, deps, { minIntervalMs: SIX_HOURS });

    expect(report.outcome).toBe('written');
    expect(report.bytes).toBe(1024);
  });

  it('holds off while the newest archive is still recent', async () => {
    await insertTransaction(NOW - MINUTE);
    const deps = hooks({ lastBackupAt: vi.fn(() => Promise.resolve(NOW - MINUTE)) });

    const report = await runScheduledBackup(ctx, deps, { minIntervalMs: SIX_HOURS });

    expect(report.outcome).toBe('too-soon');
    expect(deps.writeBackup).not.toHaveBeenCalled();
  });

  it('skips a backup that would be identical to the last one', async () => {
    await insertTransaction(STALE - MINUTE);
    const deps = hooks({ lastBackupAt: vi.fn(() => Promise.resolve(STALE)) });

    const report = await runScheduledBackup(ctx, deps, { minIntervalMs: SIX_HOURS });

    expect(report.outcome).toBe('unchanged');
    expect(deps.writeBackup).not.toHaveBeenCalled();
  });

  it('writes once the interval has passed and something changed', async () => {
    await insertTransaction(STALE + MINUTE);
    const deps = hooks({ lastBackupAt: vi.fn(() => Promise.resolve(STALE)) });

    const report = await runScheduledBackup(ctx, deps, { minIntervalMs: SIX_HOURS });

    expect(report.outcome).toBe('written');
  });

  it('ignores both guards when the user asked for it', async () => {
    await insertTransaction(NOW - MINUTE);
    const deps = hooks({ lastBackupAt: vi.fn(() => Promise.resolve(NOW - MINUTE)) });

    const report = await runScheduledBackup(ctx, deps, {
      minIntervalMs: SIX_HOURS,
      force: true,
    });

    expect(report.outcome).toBe('written');
    expect(deps.writeBackup).toHaveBeenCalledOnce();
  });

  it('reports what retention deleted', async () => {
    const deps = hooks({
      writeBackup: vi.fn(() => Promise.resolve({ bytes: 1024, pruned: 2 })),
    });
    const report = await runScheduledBackup(ctx, deps, { minIntervalMs: SIX_HOURS });

    expect(report.pruned).toBe(2);
  });
});
