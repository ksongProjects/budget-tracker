import type { DeviceId, Timestamp } from '@budget/schema';
import type { SqliteDriver } from './driver.js';

/**
 * What every repository needs: a driver, the identity of this device, and a
 * clock. The clock is injected so tests can pin time — merge ordering depends
 * on `updated_at`, and a test that cannot control it cannot pin the behaviour
 * that matters most.
 */
export interface RepositoryContext {
  readonly driver: SqliteDriver;
  readonly deviceId: DeviceId;
  readonly clock: () => Timestamp;
}

export const systemClock = (): Timestamp => Date.now() as Timestamp;
