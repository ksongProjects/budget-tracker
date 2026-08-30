import { TransactionSchema } from '@budget/schema';
import type { Transaction } from '@budget/schema';
import type { SqlValue } from './driver.js';

/**
 * Columns are snake_case, the domain is camelCase. This module owns that
 * translation so no query builder or screen has to know both spellings, and
 * round-trip tests keep the two halves honest.
 *
 * Rows are validated on the way out rather than trusted. The database is a file
 * the user can restore from a backup written by an older build, so "it came
 * from SQLite" is not proof it matches today's schema.
 */

export interface TransactionRow {
  readonly id: string;
  readonly capture_id: string | null;
  readonly account_id: string | null;
  readonly merchant_id: string | null;
  readonly category_id: string | null;
  readonly amount_minor: number;
  readonly currency: string;
  readonly occurred_at: number;
  readonly posted_at: number | null;
  readonly note: string | null;
  readonly source: string;
  readonly confirmed_at: number | null;
  readonly fx_original_minor: number | null;
  readonly fx_original_currency: string | null;
  readonly fx_rate: number | null;
  readonly reconciled: number;
  readonly rev: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
  readonly origin_device: string;
}

export const TRANSACTION_COLUMNS = [
  'id',
  'capture_id',
  'account_id',
  'merchant_id',
  'category_id',
  'amount_minor',
  'currency',
  'occurred_at',
  'posted_at',
  'note',
  'source',
  'confirmed_at',
  'fx_original_minor',
  'fx_original_currency',
  'fx_rate',
  'reconciled',
  'rev',
  'updated_at',
  'deleted_at',
  'origin_device',
] as const;

export function toTransaction(row: TransactionRow): Transaction {
  return TransactionSchema.parse({
    id: row.id,
    captureId: row.capture_id,
    accountId: row.account_id,
    merchantId: row.merchant_id,
    categoryId: row.category_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    occurredAt: row.occurred_at,
    postedAt: row.posted_at,
    note: row.note,
    source: row.source,
    confirmedAt: row.confirmed_at,
    fxOriginalMinor: row.fx_original_minor,
    fxOriginalCurrency: row.fx_original_currency,
    fxRate: row.fx_rate,
    reconciled: row.reconciled !== 0,
    rev: row.rev,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    originDevice: row.origin_device,
  });
}

export function fromTransaction(transaction: Transaction): SqlValue[] {
  return [
    transaction.id,
    transaction.captureId,
    transaction.accountId,
    transaction.merchantId,
    transaction.categoryId,
    transaction.amountMinor,
    transaction.currency,
    transaction.occurredAt,
    transaction.postedAt,
    transaction.note,
    transaction.source,
    transaction.confirmedAt,
    transaction.fxOriginalMinor,
    transaction.fxOriginalCurrency,
    transaction.fxRate,
    transaction.reconciled ? 1 : 0,
    transaction.rev,
    transaction.updatedAt,
    transaction.deletedAt,
    transaction.originDevice,
  ];
}
