import { TransactionSchema, uuidv7 } from '@budget/schema';
import type {
  AccountId,
  CategoryId,
  MerchantId,
  MinorUnits,
  Timestamp,
  Transaction,
  TransactionId,
} from '@budget/schema';
import type { RepositoryContext } from './context.js';
import { DatabaseError } from './driver.js';
import type { SqlValue } from './driver.js';
import { TRANSACTION_COLUMNS, fromTransaction, toTransaction } from './mapping.js';
import type { TransactionRow } from './mapping.js';
import { recordTombstone } from './tombstones.js';

/** Fields a caller supplies; the repository owns id and the merge quartet. */
export type NewTransaction = Omit<
  Transaction,
  'id' | 'rev' | 'updatedAt' | 'deletedAt' | 'originDevice'
> & { readonly id?: TransactionId };

export type TransactionPatch = Partial<
  Omit<Transaction, 'id' | 'rev' | 'updatedAt' | 'deletedAt' | 'originDevice'>
>;

export interface TransactionFilter {
  readonly from?: Timestamp;
  readonly to?: Timestamp;
  readonly merchantId?: MerchantId;
  readonly categoryId?: CategoryId;
  readonly accountId?: AccountId;
  readonly minAmount?: MinorUnits;
  readonly maxAmount?: MinorUnits;
  /** Omit to get both; `true` for confirmed rows only, `false` for pending ones. */
  readonly confirmed?: boolean;
  readonly limit?: number;
  readonly cursor?: Timestamp;
}

export interface SummaryRow {
  readonly key: string | null;
  readonly totalMinor: number;
  readonly count: number;
}

const SELECT = `SELECT ${TRANSACTION_COLUMNS.join(', ')} FROM transactions`;
const SELECT_ALIASED = `SELECT ${TRANSACTION_COLUMNS.map((c) => `t.${c}`).join(', ')} FROM transactions t`;
const DEFAULT_LIMIT = 50;

export class TransactionRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async create(input: NewTransaction): Promise<Transaction> {
    const transaction = TransactionSchema.parse({
      ...input,
      id: input.id ?? uuidv7(),
      rev: 1,
      updatedAt: this.ctx.clock(),
      deletedAt: null,
      originDevice: this.ctx.deviceId,
    });

    const placeholders = TRANSACTION_COLUMNS.map(() => '?').join(', ');
    await this.ctx.driver.run(
      `INSERT INTO transactions (${TRANSACTION_COLUMNS.join(', ')}) VALUES (${placeholders})`,
      fromTransaction(transaction),
    );

    return transaction;
  }

  async get(id: TransactionId): Promise<Transaction | undefined> {
    const row = await this.ctx.driver.get<TransactionRow>(`${SELECT} WHERE id = ?`, [id]);
    return row ? toTransaction(row) : undefined;
  }

  /**
   * Apply a patch, bumping `rev` and `updated_at`. The previous revision goes to
   * the tombstone log first: it is the user's money data, and an edit they did
   * not expect must be recoverable.
   */
  async update(id: TransactionId, patch: TransactionPatch): Promise<Transaction> {
    return this.ctx.driver.transaction(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new DatabaseError(`no transaction ${id}`);
      }

      await recordTombstone(this.ctx, 'transactions', id, existing.rev, existing);

      const next = TransactionSchema.parse({
        ...existing,
        ...patch,
        rev: existing.rev + 1,
        updatedAt: this.ctx.clock(),
        originDevice: this.ctx.deviceId,
      });

      await this.write(next);
      return next;
    });
  }

  /** Soft delete: the row stays, carrying `deleted_at`, so a Merge can still reason about it. */
  async softDelete(id: TransactionId): Promise<void> {
    await this.ctx.driver.transaction(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new DatabaseError(`no transaction ${id}`);
      }

      await recordTombstone(this.ctx, 'transactions', id, existing.rev, existing);

      await this.write({
        ...existing,
        rev: existing.rev + 1,
        updatedAt: this.ctx.clock(),
        deletedAt: this.ctx.clock(),
        originDevice: this.ctx.deviceId,
      });
    });
  }

  /** Nothing counts toward a total before this. */
  async confirm(id: TransactionId): Promise<Transaction> {
    return this.update(id, { confirmedAt: this.ctx.clock() });
  }

  async list(filter: TransactionFilter = {}): Promise<Transaction[]> {
    const { where, params } = buildWhere(filter);
    const limit = filter.limit ?? DEFAULT_LIMIT;

    const rows = await this.ctx.driver.all<TransactionRow>(
      `${SELECT} ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      [...params, limit],
    );

    return rows.map(toTransaction);
  }

  /**
   * Aggregate confirmed spending. Unconfirmed rows are excluded here and
   * everywhere else a total is produced — a proposed number the user has not
   * accepted is not spending yet.
   */
  async summary(
    groupBy: 'category' | 'merchant' | 'month',
    filter: TransactionFilter = {},
  ): Promise<SummaryRow[]> {
    const column = {
      category: 'category_id',
      merchant: 'merchant_id',
      // Month buckets are computed in SQLite so the caller never has to hold the
      // whole ledger to add it up.
      month: "strftime('%Y-%m', occurred_at / 1000, 'unixepoch')",
    }[groupBy];

    const { where, params } = buildWhere({ ...filter, confirmed: true });

    return this.ctx.driver.all<SummaryRow>(
      `SELECT ${column} AS key, SUM(amount_minor) AS totalMinor, COUNT(*) AS count
       FROM transactions ${where}
       GROUP BY ${column}
       ORDER BY totalMinor DESC`,
      params,
    );
  }

  /** Total of confirmed spending only. */
  async total(filter: TransactionFilter = {}): Promise<number> {
    const { where, params } = buildWhere({ ...filter, confirmed: true });
    const row = await this.ctx.driver.get<{ total: number | null }>(
      `SELECT SUM(amount_minor) AS total FROM transactions ${where}`,
      params,
    );
    return row?.total ?? 0;
  }

  /** Full-text search over note and merchant name. */
  async search(query: string, limit = DEFAULT_LIMIT): Promise<Transaction[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];

    const rows = await this.ctx.driver.all<TransactionRow>(
      `${SELECT_ALIASED}
       JOIN transactions_fts f ON f.rowid = t.rowid
       WHERE transactions_fts MATCH ? AND t.deleted_at IS NULL
       ORDER BY t.occurred_at DESC LIMIT ?`,
      [toMatchQuery(trimmed), limit],
    );

    return rows.map(toTransaction);
  }

  private async write(transaction: Transaction): Promise<void> {
    const assignments = TRANSACTION_COLUMNS.filter((c) => c !== 'id')
      .map((column) => `${column} = ?`)
      .join(', ');
    const values = fromTransaction(transaction);

    await this.ctx.driver.run(`UPDATE transactions SET ${assignments} WHERE id = ?`, [
      ...values.slice(1),
      transaction.id,
    ]);
  }
}

function buildWhere(filter: TransactionFilter): { where: string; params: SqlValue[] } {
  const clauses = ['deleted_at IS NULL'];
  const params: SqlValue[] = [];

  if (filter.from !== undefined) {
    clauses.push('occurred_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('occurred_at <= ?');
    params.push(filter.to);
  }
  if (filter.merchantId !== undefined) {
    clauses.push('merchant_id = ?');
    params.push(filter.merchantId);
  }
  if (filter.categoryId !== undefined) {
    clauses.push('category_id = ?');
    params.push(filter.categoryId);
  }
  if (filter.accountId !== undefined) {
    clauses.push('account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.minAmount !== undefined) {
    clauses.push('amount_minor >= ?');
    params.push(filter.minAmount);
  }
  if (filter.maxAmount !== undefined) {
    clauses.push('amount_minor <= ?');
    params.push(filter.maxAmount);
  }
  if (filter.confirmed === true) {
    clauses.push('confirmed_at IS NOT NULL');
  }
  if (filter.confirmed === false) {
    clauses.push('confirmed_at IS NULL');
  }
  if (filter.cursor !== undefined) {
    clauses.push('occurred_at < ?');
    params.push(filter.cursor);
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

/**
 * Turn user input into an FTS5 prefix query, quoting each term so that
 * punctuation a user types (`SQ *BLUE`, `-`, `"`) is searched for rather than
 * parsed as FTS syntax or rejected as a syntax error.
 */
function toMatchQuery(input: string): string {
  return input
    .split(/\s+/)
    .filter((term) => term !== '')
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(' ');
}
