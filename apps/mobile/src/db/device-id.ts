import { uuidv7 } from '@budget/schema';
import type { SqliteDriver } from '@budget/db';
import type { DeviceId } from '@budget/schema';

/**
 * A stable id for this installation, minted once and kept in `settings`.
 *
 * Merge uses it as the final tie-break, so that two devices resolving the same
 * conflict independently reach the same answer. It must therefore survive app
 * restarts and never be regenerated — but it is per-installation, not a device
 * fingerprint: reinstalling mints a new one, and it never leaves the device
 * except inside an encrypted backup.
 *
 * Runs after migrations, since `settings` is created by one.
 */

const SETTINGS_KEY = 'device_id';

export async function loadDeviceId(driver: SqliteDriver): Promise<DeviceId> {
  const existing = await driver.get<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [SETTINGS_KEY],
  );
  if (existing) {
    return existing.value as DeviceId;
  }

  const created = uuidv7();
  await driver.run('INSERT INTO settings (key, value) VALUES (?, ?)', [SETTINGS_KEY, created]);
  return created as DeviceId;
}
