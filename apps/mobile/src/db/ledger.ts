import {
  AccountRepository,
  CategoryRepository,
  LineItemRepository,
  MerchantRepository,
  ProfileRepository,
  TransactionRepository,
  systemClock,
} from '@budget/db';
import type { RepositoryContext, SqliteDriver } from '@budget/db';
import type { DeviceId } from '@budget/schema';

/**
 * A database with its repositories attached.
 *
 * Kept apart from the provider so something other than the app's own ledger —
 * the benchmark's scratch database — can be built the same way, and so this can
 * be tested without React or a native SQLite.
 */

export interface Ledger extends RepositoryContext {
  readonly transactions: TransactionRepository;
  readonly lineItems: LineItemRepository;
  readonly categories: CategoryRepository;
  readonly accounts: AccountRepository;
  readonly merchants: MerchantRepository;
  readonly profile: ProfileRepository;
  readonly driver: SqliteDriver;
  readonly deviceId: DeviceId;
}

export function buildLedger(driver: SqliteDriver, deviceId: DeviceId): Ledger {
  const ctx: RepositoryContext = { driver, deviceId, clock: systemClock };
  return {
    ...ctx,
    transactions: new TransactionRepository(ctx),
    lineItems: new LineItemRepository(ctx),
    categories: new CategoryRepository(ctx),
    accounts: new AccountRepository(ctx),
    merchants: new MerchantRepository(ctx),
    profile: new ProfileRepository(ctx),
  };
}
