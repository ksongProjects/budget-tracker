import { CurrencySchema } from '@budget/schema';
import type { Currency } from '@budget/schema';
import type { RepositoryContext } from './context.js';

/**
 * Who is using this copy of the app.
 *
 * Not an account. There is no server to hold one, nothing is verified and
 * nothing is sent anywhere — the name goes on an export, the address is where
 * the user wants that export mailed, and the currency decides which one the
 * keypad opens in.
 *
 * Kept in the ledger rather than in device storage so it travels inside a
 * backup: someone restoring onto a new phone should not have to introduce
 * themselves again on the worst day of their week.
 */

/** The single row. A fixed id, because there is exactly one person per device. */
export const PROFILE_ID = 'profile';

export interface Profile {
  readonly displayName: string;
  /** Optional: the app works without one, and only export uses it. */
  readonly email: string | null;
  readonly defaultCurrency: Currency;
  readonly updatedAt: number;
}

export interface ProfileInput {
  readonly displayName: string;
  readonly email?: string | null;
  readonly defaultCurrency: Currency;
}

interface ProfileRow {
  readonly display_name: string;
  readonly email: string | null;
  readonly default_currency: string;
  readonly updated_at: number;
}

export class ProfileRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async read(): Promise<Profile | undefined> {
    const row = await this.ctx.driver.get<ProfileRow>(
      `SELECT display_name, email, default_currency, updated_at
         FROM profile
        WHERE id = ? AND deleted_at IS NULL`,
      [PROFILE_ID],
    );

    if (row === undefined) return undefined;

    const currency = CurrencySchema.safeParse(row.default_currency);

    return {
      displayName: row.display_name,
      email: row.email,
      // A stored value that is not a currency code — an older build, a hand
      // edit — must not make the profile unreadable: the user would be locked
      // out of the one screen that could fix it.
      defaultCurrency: currency.success ? currency.data : CurrencySchema.parse('USD'),
      updatedAt: row.updated_at,
    };
  }

  /**
   * Write the profile, creating it the first time.
   *
   * `rev` climbs on every save for the same reason it does elsewhere: two
   * devices restoring each other's backups have to agree on which answer is
   * newer, and a timestamp alone ties too often.
   */
  async save(input: ProfileInput): Promise<Profile> {
    const now = this.ctx.clock();
    const email = normaliseEmail(input.email);
    const name = input.displayName.trim();

    if (name === '') throw new Error('A name is needed — it goes on your exports.');

    await this.ctx.driver.run(
      `INSERT INTO profile
         (id, display_name, email, default_currency, rev, updated_at, deleted_at, origin_device)
       VALUES (?, ?, ?, ?, 1, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         email = excluded.email,
         default_currency = excluded.default_currency,
         rev = profile.rev + 1,
         updated_at = excluded.updated_at,
         deleted_at = NULL,
         origin_device = excluded.origin_device`,
      [PROFILE_ID, name, email, input.defaultCurrency, now, this.ctx.deviceId],
    );

    return {
      displayName: name,
      email,
      defaultCurrency: input.defaultCurrency,
      updatedAt: now,
    };
  }

  /** Whether the app has been set up on this device. */
  async exists(): Promise<boolean> {
    return (await this.read()) !== undefined;
  }
}

/**
 * Enough of an email check to catch a typo, and no more.
 *
 * Nothing here sends mail — the address is handed to the phone's own mail app,
 * which will have its own opinion. Rejecting an unusual but valid address would
 * be this app's mistake, not the user's.
 */
export function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function normaliseEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
