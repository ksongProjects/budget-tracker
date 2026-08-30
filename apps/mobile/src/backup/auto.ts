import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { migrate, systemClock } from '@budget/db';
import type { RepositoryContext } from '@budget/db';
import { createExpoDriver } from '../db/driver';
import { loadDeviceId } from '../db/device-id';
import { hasKeyMaterial } from './keys';
import { createBackup, lastBackupAt, pruneBackups } from './service';

/**
 * Backups that happen without being asked for.
 *
 * A backup the user has to remember is a backup that does not exist on the day
 * it is needed, so the app writes one whenever it is sent to the background and
 * again on a best-effort OS schedule. Neither secret is present at that moment:
 * both wraps are kept for exactly this (see `keys.ts`).
 *
 * Two guards keep it from being wasteful — the phone is not asked to encrypt
 * megabytes every time the user switches apps:
 *
 * - a minimum interval since the last archive, and
 * - a check that the ledger actually changed since then.
 */

export const AUTO_BACKUP_TASK = 'budget.auto-backup';

/** How stale the newest backup must be before backgrounding writes another. */
export const MIN_INTERVAL_HOURS = 6;
export const MIN_INTERVAL_MS = MIN_INTERVAL_HOURS * 60 * 60 * 1000;

/** What the OS is asked for. It is a floor, not a promise; 15 minutes is its own floor. */
const SCHEDULE_MINUTES = 12 * 60;

/** Tables whose `updated_at` decides whether anything is worth backing up. */
const CHANGE_TABLES = [
  'merchants',
  'merchant_aliases',
  'categories',
  'accounts',
  'captures',
  'transactions',
  'line_items',
] as const;

export type AutoBackupOutcome =
  | 'not-set-up'
  | 'too-soon'
  | 'unchanged'
  | 'written';

export interface AutoBackupReport {
  readonly outcome: AutoBackupOutcome;
  /** Present when an archive was written. */
  readonly bytes?: number;
  /** How many old archives were deleted by retention. */
  readonly pruned?: number;
}

export interface AutoBackupOptions {
  readonly minIntervalMs?: number;
  /** Ignore both guards. The user pressing "back up now" is not a schedule. */
  readonly force?: boolean;
}

/**
 * Write a backup if one is due.
 *
 * Never throws for the ordinary reasons — backup not set up, nothing changed —
 * because those are answers, not failures. A real failure (no space, keystore
 * unavailable) still throws, so a caller that can show it does.
 */
export async function maybeBackup(
  ctx: RepositoryContext,
  options: AutoBackupOptions = {},
): Promise<AutoBackupReport> {
  if (!(await hasKeyMaterial())) return { outcome: 'not-set-up' };

  const force = options.force ?? false;
  const minInterval = options.minIntervalMs ?? MIN_INTERVAL_MS;
  const last = await lastBackupAt();

  if (last !== undefined && !force) {
    if (Date.now() - last < minInterval) return { outcome: 'too-soon' };
    if (!(await ledgerChangedSince(ctx, last))) return { outcome: 'unchanged' };
  }

  const result = await createBackup(ctx);
  const pruned = await pruneBackups();

  return { outcome: 'written', bytes: result.bytes, pruned };
}

/**
 * Whether any row has been written since `since`.
 *
 * Cheaper than the alternative by orders of magnitude: the question is whether
 * to spend seconds encrypting the whole ledger, and this answers it in a scan.
 */
async function ledgerChangedSince(ctx: RepositoryContext, since: number): Promise<boolean> {
  const query = CHANGE_TABLES.map(
    (table) => `SELECT MAX(updated_at) AS changed FROM ${table}`,
  ).join(' UNION ALL ');

  const rows = await ctx.driver.all<{ changed: number | null }>(query);
  return rows.some((row) => (row.changed ?? 0) > since);
}

/**
 * Back up when the app goes to the background.
 *
 * Android may freeze the JS thread shortly after this fires, so the write has
 * to survive being cut off mid-way. It does: the archive is written under a
 * `.partial` name and renamed only once complete, so an interrupted backup
 * leaves nothing that looks like a finished one.
 */
export function useAutoBackup(ctx: RepositoryContext | undefined): void {
  useEffect(() => {
    if (ctx === undefined) return;

    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'background') return;

      void maybeBackup(ctx).catch((cause: unknown) => {
        // A failed automatic backup must not take the app down with it. The
        // backup screen reports the real state when the user next looks.
        console.warn('automatic backup failed', cause);
      });
    });

    return () => {
      subscription.remove();
    };
  }, [ctx]);
}

/**
 * Ask the OS to run backups on a schedule.
 *
 * Best-effort by construction: Android decides when, and a device that is never
 * idle-and-charging may never run it. It is a second chance, not the mechanism —
 * backgrounding is the one that reliably fires.
 */
export async function registerAutoBackupTask(): Promise<BackgroundTask.BackgroundTaskStatus> {
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return status;

  if (!(await TaskManager.isTaskRegisteredAsync(AUTO_BACKUP_TASK))) {
    await BackgroundTask.registerTaskAsync(AUTO_BACKUP_TASK, {
      minimumInterval: SCHEDULE_MINUTES,
    });
  }

  return status;
}

/**
 * The scheduled run. It opens its own ledger: no React tree exists here, and
 * the app process may have been started by the OS purely to run this.
 */
TaskManager.defineTask(AUTO_BACKUP_TASK, async () => {
  let close: (() => Promise<void>) | undefined;

  try {
    const opened = await openLedgerContext();
    close = opened.close;
    await maybeBackup(opened.ctx);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (cause) {
    console.warn('scheduled backup failed', cause);
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    if (close) await close();
  }
});

async function openLedgerContext(): Promise<{
  ctx: RepositoryContext;
  close: () => Promise<void>;
}> {
  const driver = await createExpoDriver();
  await migrate(driver);
  const deviceId = await loadDeviceId(driver);

  return {
    ctx: { driver, deviceId, clock: systemClock },
    close: () => driver.close(),
  };
}
