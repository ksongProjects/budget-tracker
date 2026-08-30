import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { migrate, systemClock } from '@budget/db';
import type { RepositoryContext } from '@budget/db';
import { DATABASE_NAME, createExpoDriver } from '../db/driver';
import { loadDeviceId } from '../db/device-id';
import { hasKeyMaterial } from './keys';
import { createBackup, lastBackupAt, recordScheduledRun } from './service';
import { runScheduledBackup } from './schedule';
import type { AutoBackupOptions, AutoBackupReport } from './schedule';

/**
 * Backups that happen without being asked for.
 *
 * A backup the user has to remember is a backup that does not exist on the day
 * it is needed, so the app writes one whenever it is sent to the background and
 * again on a best-effort OS schedule. Neither secret is present at that moment:
 * both wraps are kept for exactly this (see `keys.ts`).
 *
 * This module is the platform half — AppState, the OS scheduler, the keystore.
 * When to actually write lives in `schedule.ts`, where it can be tested.
 */

export type { AutoBackupOutcome, AutoBackupReport } from './schedule';

export const AUTO_BACKUP_TASK = 'budget.auto-backup';

/** How stale the newest backup must be before backgrounding writes another. */
export const MIN_INTERVAL_HOURS = 6;
export const MIN_INTERVAL_MS = MIN_INTERVAL_HOURS * 60 * 60 * 1000;

/** What the OS is asked for. It is a floor, not a promise; 15 minutes is its own floor. */
const SCHEDULE_MINUTES = 12 * 60;

/** Write a backup if one is due. See `runScheduledBackup` for the rules. */
export async function maybeBackup(
  ctx: RepositoryContext,
  options: AutoBackupOptions = {},
): Promise<AutoBackupReport> {
  return runScheduledBackup(
    ctx,
    {
      isSetUp: hasKeyMaterial,
      lastBackupAt,
      writeBackup: () => createBackup(ctx),
      now: Date.now,
    },
    { ...options, minIntervalMs: options.minIntervalMs ?? MIN_INTERVAL_MS },
  );
}

/**
 * Back up when the app goes to the background.
 *
 * Android may freeze the JS thread shortly after this fires, so the write has
 * to survive being cut off. It does: the archive is written under a `.partial`
 * name and renamed only once complete, so an interrupted backup leaves nothing
 * that looks like a finished one.
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

/** Whether the OS is currently holding a registration for the scheduled backup. */
export async function isAutoBackupRegistered(): Promise<boolean> {
  return TaskManager.isTaskRegisteredAsync(AUTO_BACKUP_TASK);
}

/**
 * Run the scheduled task now. Debug builds only — this is how the headless path
 * gets exercised without waiting on the OS to feel like waking the app up.
 */
export async function triggerAutoBackupForTesting(): Promise<boolean> {
  return BackgroundTask.triggerTaskWorkerForTestingAsync();
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
    const report = await maybeBackup(opened.ctx);
    await recordScheduledRun({
      at: Date.now(),
      outcome: report.outcome,
      ...(report.bytes === undefined ? {} : { bytes: report.bytes }),
    });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    console.warn('scheduled backup failed', cause);
    await recordScheduledRun({ at: Date.now(), outcome: 'failed', error });
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    if (close) await close();
  }
});

async function openLedgerContext(): Promise<{
  ctx: RepositoryContext;
  close: () => Promise<void>;
}> {
  // A private connection: the app may still be alive with the ledger open, and
  // closing a shared one at the end of this task would kill its database.
  const driver = await createExpoDriver(DATABASE_NAME, { ownConnection: true });
  await migrate(driver);
  const deviceId = await loadDeviceId(driver);

  return {
    ctx: { driver, deviceId, clock: systemClock },
    close: () => driver.close(),
  };
}
