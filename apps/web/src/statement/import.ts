import { uuidv7 } from '@budget/schema';
import type { Currency, MinorUnits, Timestamp } from '@budget/schema';
import { TransactionRepository } from '@budget/db';
import type { RepositoryContext } from '@budget/db';
import { findDuplicates, readRows } from '@budget/extract';
import type {
  ColumnMapping,
  CsvTable,
  DateOrder,
  ExistingRow,
  RowProblem,
  StatementRow,
} from '@budget/extract';

/**
 * Bringing a bank statement into the ledger.
 *
 * Two steps on purpose. A preview is computed and shown — what would be added,
 * what looks like something already here, what could not be read — and nothing
 * is written until the user agrees to it. An import that acted immediately
 * would make "I picked the wrong date format" an undo problem rather than a
 * question.
 *
 * Imported rows arrive **unconfirmed**. They are candidate data however
 * structured the file was: the bank's description is not a merchant, and
 * nothing counts toward a total before the user accepts it (CONTEXT.md).
 */

export interface ImportSettings {
  readonly mapping: ColumnMapping;
  readonly dateOrder: DateOrder;
  readonly currency: Currency;
  readonly debitsArePositive?: boolean;
}

export interface ImportPreview {
  readonly fresh: readonly StatementRow[];
  readonly duplicates: readonly { row: StatementRow; existingId: string }[];
  readonly problems: readonly RowProblem[];
}

const DAY = 86_400_000;

/** How far either side of the file's own range to look for rows it might duplicate. */
const DEDUPE_MARGIN_DAYS = 7;

export async function previewImport(
  ctx: RepositoryContext,
  table: CsvTable,
  settings: ImportSettings,
): Promise<ImportPreview> {
  const { rows, problems } = readRows(table, {
    mapping: settings.mapping,
    dateOrder: settings.dateOrder,
    currency: settings.currency,
    ...(settings.debitsArePositive === undefined
      ? {}
      : { debitsArePositive: settings.debitsArePositive }),
  });

  const { fresh, duplicates } = findDuplicates(rows, await neighbours(ctx, rows));

  return { fresh, duplicates, problems };
}

/**
 * The ledger rows a statement could plausibly duplicate.
 *
 * Bounded by the file's own date range rather than fetching the ledger: an
 * import of last month has nothing to say about a purchase two years ago, and
 * a statement is often opened on a device holding years of history.
 */
async function neighbours(
  ctx: RepositoryContext,
  rows: readonly StatementRow[],
): Promise<ExistingRow[]> {
  if (rows.length === 0) return [];

  const times = rows.map((row) => row.occurredAt);
  const from = Math.min(...times) - DEDUPE_MARGIN_DAYS * DAY;
  const to = Math.max(...times) + DEDUPE_MARGIN_DAYS * DAY;

  const found = await ctx.driver.all<{
    id: string;
    occurred_at: number;
    amount_minor: number;
    description: string | null;
  }>(
    `SELECT t.id, t.occurred_at, t.amount_minor,
            COALESCE(m.canonical_name, t.note) AS description
     FROM transactions t
     LEFT JOIN merchants m ON m.id = t.merchant_id
     WHERE t.deleted_at IS NULL AND t.occurred_at BETWEEN ? AND ?`,
    [from, to],
  );

  return found.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    amountMinor: row.amount_minor as MinorUnits,
    description: row.description,
  }));
}

export interface ImportResult {
  readonly captureId: string;
  readonly imported: number;
}

/**
 * Write the rows the user accepted.
 *
 * One Capture stands for the statement itself, and every row points at it, so
 * "where did this come from?" has an answer months later — and so a mistaken
 * import is one identifiable set of rows rather than a scattering.
 *
 * The whole thing is one transaction: a half-imported statement is worse than a
 * failed one, because the second half looks like rows the bank never sent.
 */
export async function commitImport(
  ctx: RepositoryContext,
  rows: readonly StatementRow[],
): Promise<ImportResult> {
  const transactions = new TransactionRepository(ctx);
  const captureId = uuidv7();

  await ctx.driver.transaction(async () => {
    const now = ctx.clock();

    await ctx.driver.run(
      `INSERT INTO captures (capture_id, kind, captured_at, rev, updated_at, origin_device)
       VALUES (?, 'statement', ?, 1, ?, ?)`,
      [captureId, now, now, ctx.deviceId],
    );

    for (const row of rows) {
      await transactions.create({
        captureId: captureId as never,
        accountId: null,
        merchantId: null,
        categoryId: null,
        amountMinor: row.amountMinor,
        currency: row.currency,
        occurredAt: row.occurredAt as Timestamp,
        postedAt: null,
        // The bank's description is the only thing known about the counterparty
        // until someone confirms it. It is a note, not a merchant.
        note: row.description,
        source: 'statement',
        // Unconfirmed: structured input is still candidate data.
        confirmedAt: null,
        fxOriginalMinor: null,
        fxOriginalCurrency: null,
        fxRate: null,
        reconciled: false,
      });
    }
  });

  return { captureId, imported: rows.length };
}

/**
 * Accept several rows at once. Phase 7.4's bulk confirm, without a screen.
 *
 * Not wrapped in one transaction, deliberately: confirming goes through the
 * repository, which opens its own transaction per row so the previous revision
 * lands in the tombstone log. Wrapping these would nest, and the driver refuses
 * that rather than silently flattening it. A batch interrupted halfway leaves
 * some rows confirmed, which is visible on the screen and safe — unlike a
 * confirm that skipped its tombstone.
 */
export async function confirmAll(
  ctx: RepositoryContext,
  ids: readonly string[],
): Promise<number> {
  const transactions = new TransactionRepository(ctx);

  for (const id of ids) {
    await transactions.confirm(id as never);
  }

  return ids.length;
}

/** Imported rows still waiting to be accepted, oldest first. */
export async function pendingRows(ctx: RepositoryContext): Promise<
  { id: string; occurredAt: number; amountMinor: MinorUnits; currency: Currency; note: string }[]
> {
  const rows = await ctx.driver.all<{
    id: string;
    occurred_at: number;
    amount_minor: number;
    currency: string;
    note: string | null;
  }>(
    `SELECT id, occurred_at, amount_minor, currency, note
     FROM transactions
     WHERE deleted_at IS NULL AND confirmed_at IS NULL
     ORDER BY occurred_at`,
  );

  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    amountMinor: row.amount_minor as MinorUnits,
    currency: row.currency as Currency,
    note: row.note ?? '',
  }));
}
