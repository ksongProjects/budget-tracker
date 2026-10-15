import type { AccountId, Currency, ExtractionTier, MinorUnits, Timestamp } from '@budget/schema';
import { TransactionRepository } from './transactions.js';
import type { RepositoryContext } from './context.js';
import { ExtractionRepository } from './extractions.js';
import { RecordRepository, createCapture } from './records.js';
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
 * Shared by both apps. It began in the web app, which is where statements were
 * first imported; the phone needs the identical behaviour, and two copies of
 * "what counts as a duplicate" would drift into two answers to the same
 * question about the same file.
 *
 * Two steps on purpose. A preview is computed and shown — what would be added,
 * what looks like something already here, what could not be read — and nothing
 * is written until the user agrees to it. An import that acted immediately
 * would make "I picked the wrong date format" an undo problem rather than a
 * question.
 *
 * Imported rows arrive **unconfirmed**. They are candidate data however
 * structured the file was: the merchant is read from the bank's description,
 * which is a guess, and nothing counts toward a total before the user accepts
 * it (CONTEXT.md).
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
    // An imported row's note is the bank's own wording, which is what the next
    // import of the same file will say; its merchant is a cleaned-up guess.
    `SELECT t.id, t.occurred_at, t.amount_minor,
            CASE WHEN t.source = 'statement' AND t.note IS NOT NULL THEN t.note
                 ELSE COALESCE(m.canonical_name, t.note) END AS description
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

/** Where the rows came from, for the record every capture carries. */
export interface ImportSource {
  /** The account the statement belongs to, when the user said. */
  readonly accountId?: AccountId | null;
  /** `csv` for a file read directly (Tier 0), the PDF engine's name for Tier 1. */
  readonly engine?: string;
  readonly tier?: ExtractionTier;
  /** How long reading the file took, for the extraction record. */
  readonly durationMs?: number;
}

/**
 * Write the rows the user accepted.
 *
 * One Capture stands for the statement itself, and every row points at it, so
 * "where did this come from?" has an answer months later — and so a mistaken
 * import is one identifiable set of rows rather than a scattering.
 *
 * Each row is its own record, dated the day the bank says it was spent. The
 * bank's description is resolved to a merchant — "SQ *BLUE BOTTLE 0412" is
 * exactly what merchant normalization exists for — and kept verbatim as the
 * note, so nothing the file said is lost to the cleaning.
 *
 * The whole thing is one transaction: a half-imported statement is worse than a
 * failed one, because the second half looks like rows the bank never sent.
 */
export async function commitImport(
  ctx: RepositoryContext,
  rows: readonly StatementRow[],
  source: ImportSource = {},
): Promise<ImportResult> {
  const records = new RecordRepository(ctx);
  const extractions = new ExtractionRepository(ctx);

  const captureId = await ctx.driver.transaction(async () => {
    const id = await createCapture(ctx, 'statement');

    await extractions.record({
      captureId: id,
      tier: source.tier ?? 0,
      engine: source.engine ?? 'csv',
      candidate: { rows: rows.length },
      durationMs: source.durationMs ?? 0,
    });

    for (const row of rows) {
      await records.writeWithin({
        captureId: id,
        source: 'statement',
        date: row.occurredAt as Timestamp,
        merchant: row.description,
        amountMinor: row.amountMinor,
        currency: row.currency,
        accountId: source.accountId ?? null,
        note: row.description,
        postedAt: (row.postedAt ?? null) as Timestamp | null,
        // Unconfirmed: structured input is still candidate data.
        confirmed: false,
      });
    }

    return id;
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
