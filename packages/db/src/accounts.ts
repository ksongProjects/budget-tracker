import { AccountSchema, CurrencySchema, uuidv7 } from '@budget/schema';
import type { Account, AccountId, Currency } from '@budget/schema';
import type { RepositoryContext } from './context.js';
import { DatabaseError } from './driver.js';
import { recordTombstone } from './tombstones.js';

interface AccountRow {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly rev: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
  readonly origin_device: string;
}

const SELECT = `SELECT id, name, currency, rev, updated_at, deleted_at, origin_device FROM accounts`;

function toAccount(row: AccountRow): Account {
  return AccountSchema.parse({
    id: row.id,
    name: row.name,
    currency: row.currency,
    rev: row.rev,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    originDevice: row.origin_device,
  });
}

/**
 * The cards and accounts a transaction can be attributed to. An account's
 * currency is its default for new transactions; individual transactions carry
 * their own, since a card can be charged in a foreign currency.
 */
export class AccountRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async create(name: string, currency: Currency): Promise<Account> {
    const trimmed = name.trim();
    if (trimmed === '') {
      throw new DatabaseError('account name cannot be empty');
    }

    const account = AccountSchema.parse({
      id: uuidv7(),
      name: trimmed,
      currency: CurrencySchema.parse(currency),
      rev: 1,
      updatedAt: this.ctx.clock(),
      deletedAt: null,
      originDevice: this.ctx.deviceId,
    });

    await this.ctx.driver.run(
      `INSERT INTO accounts (id, name, currency, rev, updated_at, origin_device)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        account.id,
        account.name,
        account.currency,
        account.rev,
        account.updatedAt,
        account.originDevice,
      ],
    );

    return account;
  }

  async get(id: AccountId): Promise<Account | undefined> {
    const row = await this.ctx.driver.get<AccountRow>(`${SELECT} WHERE id = ?`, [id]);
    return row ? toAccount(row) : undefined;
  }

  async list(): Promise<Account[]> {
    const rows = await this.ctx.driver.all<AccountRow>(
      `${SELECT} WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
    );
    return rows.map(toAccount);
  }

  async rename(id: AccountId, name: string): Promise<Account> {
    return this.ctx.driver.transaction(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new DatabaseError(`no account ${id}`);
      }

      await recordTombstone(this.ctx, 'accounts', id, existing.rev, existing);

      const next = AccountSchema.parse({
        ...existing,
        name: name.trim(),
        rev: existing.rev + 1,
        updatedAt: this.ctx.clock(),
        originDevice: this.ctx.deviceId,
      });

      await this.ctx.driver.run(
        `UPDATE accounts SET name = ?, rev = ?, updated_at = ?, origin_device = ? WHERE id = ?`,
        [next.name, next.rev, next.updatedAt, next.originDevice, id],
      );

      return next;
    });
  }

  /** Soft delete. Transactions attributed to this account keep the attribution. */
  async softDelete(id: AccountId): Promise<void> {
    await this.ctx.driver.transaction(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new DatabaseError(`no account ${id}`);
      }

      await recordTombstone(this.ctx, 'accounts', id, existing.rev, existing);

      const at = this.ctx.clock();
      await this.ctx.driver.run(
        `UPDATE accounts SET rev = ?, updated_at = ?, deleted_at = ?, origin_device = ? WHERE id = ?`,
        [existing.rev + 1, at, at, this.ctx.deviceId, id],
      );
    });
  }
}
