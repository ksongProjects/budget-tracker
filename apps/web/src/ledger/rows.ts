import { formatAmount } from '@budget/schema';
import type { Currency, MinorUnits } from '@budget/schema';
import { localDayKey, localMonthKey, monthLabel } from '@budget/report';
import type { ExportRow } from '@budget/report';
import type { RepositoryContext } from '@budget/db';

/**
 * Reading the ledger for the screens.
 *
 * The queries live here rather than in the view so the shapes the page renders
 * can be checked without a page: a total that is wrong is wrong whether or not
 * it was ever painted.
 */

export interface LedgerRow {
  readonly id: string;
  readonly occurredAt: number;
  readonly merchant: string | null;
  readonly category: string | null;
  readonly amountMinor: MinorUnits;
  readonly currency: Currency;
  readonly note: string | null;
  readonly confirmed: boolean;
}

export interface DaySection {
  readonly dayKey: string;
  readonly rows: readonly LedgerRow[];
}

export interface MonthTotal {
  readonly key: string;
  readonly label: string;
  readonly currency: Currency;
  readonly totalMinor: MinorUnits;
}

interface SqlRow {
  id: string;
  occurred_at: number;
  merchant: string | null;
  category: string | null;
  amount_minor: number;
  currency: string;
  note: string | null;
  confirmed_at: number | null;
}

const SELECT = `
  SELECT t.id, t.occurred_at, t.amount_minor, t.currency, t.note, t.confirmed_at,
         m.canonical_name AS merchant, c.name AS category
  FROM transactions t
  LEFT JOIN merchants  m ON m.id = t.merchant_id
  LEFT JOIN categories c ON c.id = t.category_id
  WHERE t.deleted_at IS NULL
`;

export async function recentRows(
  ctx: RepositoryContext,
  limit = 100,
): Promise<LedgerRow[]> {
  const rows = await ctx.driver.all<SqlRow>(
    `${SELECT} ORDER BY t.occurred_at DESC LIMIT ?`,
    [limit],
  );

  return rows.map(toRow);
}

/** Every row, for an export. Deliberately unpaged: an export that stops early is a wrong export. */
export async function allRows(ctx: RepositoryContext): Promise<ExportRow[]> {
  const rows = await ctx.driver.all<SqlRow & { source: string; account: string | null }>(
    `SELECT t.id, t.occurred_at, t.amount_minor, t.currency, t.note, t.confirmed_at, t.source,
            m.canonical_name AS merchant, c.name AS category, a.name AS account
     FROM transactions t
     LEFT JOIN merchants  m ON m.id = t.merchant_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts   a ON a.id = t.account_id
     WHERE t.deleted_at IS NULL
     ORDER BY t.occurred_at DESC`,
  );

  return rows.map((row) => ({
    occurredAt: row.occurred_at,
    merchant: row.merchant,
    category: row.category,
    account: row.account,
    amountMinor: row.amount_minor as MinorUnits,
    currency: row.currency as Currency,
    note: row.note,
    source: row.source,
    confirmedAt: row.confirmed_at,
  }));
}

/** Rows grouped into local days, newest first, in the order the query returned them. */
export function groupByDay(rows: readonly LedgerRow[]): DaySection[] {
  const sections: DaySection[] = [];

  for (const row of rows) {
    const dayKey = localDayKey(row.occurredAt);
    const last = sections.at(-1);

    if (last?.dayKey === dayKey) (last.rows as LedgerRow[]).push(row);
    else sections.push({ dayKey, rows: [row] });
  }

  return sections;
}

/**
 * Month totals, per currency, from confirmed rows only.
 *
 * Unconfirmed rows are candidate data the user has not agreed with. Counting
 * them would make the summary a guess presented as a fact (CONTEXT.md).
 */
export function monthTotals(rows: readonly LedgerRow[]): MonthTotal[] {
  const totals = new Map<string, MonthTotal>();

  for (const row of rows) {
    if (!row.confirmed) continue;

    const month = localMonthKey(row.occurredAt);
    const key = `${month}:${row.currency}`;
    const existing = totals.get(key);

    totals.set(key, {
      key,
      label: monthLabel(month),
      currency: row.currency,
      totalMinor: ((existing?.totalMinor ?? 0) + row.amountMinor) as MinorUnits,
    });
  }

  return [...totals.values()].sort((a, b) => b.key.localeCompare(a.key));
}

/** What a row shows in the list. Amounts are plain decimals; the UI adds no symbols it cannot justify. */
export function displayAmount(row: LedgerRow): string {
  return `${formatAmount(row.amountMinor, row.currency)} ${row.currency}`;
}

function toRow(row: SqlRow): LedgerRow {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    merchant: row.merchant,
    category: row.category,
    amountMinor: row.amount_minor as MinorUnits,
    currency: row.currency as Currency,
    note: row.note,
    confirmed: row.confirmed_at !== null,
  };
}
