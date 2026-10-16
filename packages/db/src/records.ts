import { sumAmounts, uuidv7 } from '@budget/schema';
import type {
  AccountId,
  CaptureId,
  CaptureKind,
  CategoryId,
  Currency,
  LineItem,
  LineItemKind,
  MerchantId,
  MinorUnits,
  Timestamp,
  Transaction,
  TransactionId,
} from '@budget/schema';
import type { RepositoryContext } from './context.js';
import { LineItemRepository } from './line-items.js';
import type { DraftLineItem } from './line-items.js';
import { MerchantRepository } from './merchants.js';
import { TransactionRepository } from './transactions.js';

/**
 * A record in the ledger, the way a person thinks of one: when, where, what
 * was bought, and what it came to.
 *
 * Storage keeps these apart — a `transactions` row, its `line_items`, a
 * `merchants` row — because each is merged, searched and corrected on its own.
 * Everything that *shows* or *makes* a record goes through this shape instead,
 * so a photo, a recording, a statement row and a typed spend all come out the
 * same: a date, a merchant, at least one item, and a total.
 */
export interface LedgerRecord {
  readonly id: TransactionId;
  readonly captureId: CaptureId | null;
  /** When the money was spent. */
  readonly date: Timestamp;
  /** Display name; null when nobody has said who was paid. */
  readonly merchant: string | null;
  readonly merchantId: MerchantId | null;
  /** Never empty — see `itemsOf`. */
  readonly items: readonly RecordItem[];
  readonly total: { readonly amountMinor: MinorUnits; readonly currency: Currency };
  readonly source: CaptureKind;
  readonly categoryId: CategoryId | null;
  readonly accountId: AccountId | null;
  readonly note: string | null;
  readonly confirmedAt: Timestamp | null;
  /** Whether the stored items add up to the total. */
  readonly reconciled: boolean;
}

export interface RecordItem {
  readonly kind: LineItemKind;
  readonly name: string;
  readonly quantity: number | null;
  readonly unitPriceMinor: MinorUnits | null;
  readonly totalMinor: MinorUnits;
  /**
   * True when nothing was itemised and this stands for the whole record.
   *
   * Worked out when read rather than written: two devices each backfilling the
   * same old record would mint two different line-item ids for one purchase,
   * and a merge would keep both. An implied item has no id, so it cannot
   * collide with anything.
   */
  readonly implied: boolean;
}

/**
 * A record's items: what was stored, or one item standing for the whole of it.
 *
 * A typed "12.50, lunch" has no breakdown, but it still bought something, and
 * a screen that lists items should not have to special-case the records that
 * never had any.
 */
export function itemsOf(
  transaction: Pick<Transaction, 'amountMinor' | 'note'>,
  merchant: string | null,
  stored: readonly LineItem[],
): RecordItem[] {
  if (stored.length > 0) {
    return stored.map((item) => ({
      kind: item.kind,
      name: item.name,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      totalMinor: item.totalMinor,
      implied: false,
    }));
  }

  return [
    {
      kind: 'item',
      name: transaction.note ?? merchant ?? 'Spend',
      quantity: null,
      unitPriceMinor: null,
      totalMinor: transaction.amountMinor,
      implied: true,
    },
  ];
}

/** What a capture path hands over to become a record. */
export interface NewRecord {
  readonly captureId: CaptureId;
  readonly source: CaptureKind;
  readonly date: Timestamp;
  /** Raw, as read or typed; resolved to a merchant here. Blank means none. */
  readonly merchant?: string | null;
  /** The breakdown, if the source had one. Empty is fine — see `itemsOf`. */
  readonly items?: readonly DraftLineItem[];
  readonly amountMinor: MinorUnits;
  readonly currency: Currency;
  readonly categoryId?: CategoryId | null;
  readonly accountId?: AccountId | null;
  readonly note?: string | null;
  readonly postedAt?: Timestamp | null;
  /**
   * Whether the user has looked at this and agreed to it. A statement row has
   * not: it arrives as candidate data and counts toward nothing until it is.
   */
  readonly confirmed: boolean;
}

/**
 * Mint the capture a record points at.
 *
 * Every record has one — provenance is per CONTEXT.md, and a transaction with
 * no capture would be invisible to Merge's identity matching later. Captures
 * with a document (photos) are written by the code that stores the document.
 */
export async function createCapture(
  ctx: RepositoryContext,
  kind: CaptureKind,
  capturedAt: Timestamp = ctx.clock(),
): Promise<CaptureId> {
  const captureId = uuidv7() as CaptureId;
  const at = ctx.clock();

  await ctx.driver.run(
    `INSERT INTO captures (capture_id, kind, captured_at, rev, updated_at, origin_device)
     VALUES (?, ?, ?, 1, ?, ?)`,
    [captureId, kind, capturedAt, at, ctx.deviceId],
  );

  return captureId;
}

export class RecordRepository {
  private readonly transactions: TransactionRepository;
  private readonly lineItems: LineItemRepository;
  private readonly merchants: MerchantRepository;

  constructor(private readonly ctx: RepositoryContext) {
    this.transactions = new TransactionRepository(ctx);
    this.lineItems = new LineItemRepository(ctx);
    this.merchants = new MerchantRepository(ctx);
  }

  /** Write one record — the transaction, its merchant and its items — or none of it. */
  async write(record: NewRecord): Promise<TransactionId> {
    return this.ctx.driver.transaction(() => this.writeWithin(record));
  }

  /** Several records from one capture, all or nothing. */
  async writeAll(records: readonly NewRecord[]): Promise<TransactionId[]> {
    return this.ctx.driver.transaction(async () => {
      const ids: TransactionId[] = [];
      for (const record of records) ids.push(await this.writeWithin(record));
      return ids;
    });
  }

  /** `write` for a caller already inside a transaction. */
  async writeWithin(record: NewRecord): Promise<TransactionId> {
    const merchantName = record.merchant?.trim() ?? '';
    const merchantId = await this.merchantFor(merchantName);
    const items = record.items ?? [];
    const at = this.ctx.clock();

    const transaction = await this.transactions.create({
      captureId: record.captureId,
      accountId: record.accountId ?? null,
      merchantId,
      categoryId: record.categoryId ?? null,
      amountMinor: record.amountMinor,
      currency: record.currency,
      occurredAt: record.date,
      postedAt: record.postedAt ?? null,
      note: blankToNull(record.note) ?? (merchantName === '' ? null : merchantName),
      source: record.source,
      confirmedAt: record.confirmed ? at : null,
      fxOriginalMinor: null,
      fxOriginalCurrency: null,
      fxRate: null,
      // Claimed only when a breakdown exists and adds up to what was charged.
      reconciled:
        items.length > 0 && sumAmounts(items.map((item) => item.totalMinor)) === record.amountMinor,
    });

    for (const [position, item] of items.entries()) {
      await this.lineItems.create({ ...item, transactionId: transaction.id, position });
    }

    return transaction.id;
  }

  async get(id: TransactionId): Promise<LedgerRecord | undefined> {
    const transaction = await this.transactions.get(id);
    if (!transaction || transaction.deletedAt !== null) return undefined;

    const merchant =
      transaction.merchantId === null
        ? null
        : ((await this.merchants.name(transaction.merchantId)) ?? null);

    return toRecord(transaction, merchant, await this.lineItems.listFor(id));
  }

  /**
   * Resolve a raw name, or nothing for a blank one. A name that normalizes to
   * nothing — "#1234" — is not a merchant either, and is left in the note.
   */
  private async merchantFor(name: string): Promise<MerchantId | null> {
    if (name === '') return null;
    try {
      return await this.merchants.resolveWithin(name);
    } catch {
      return null;
    }
  }
}

export function toRecord(
  transaction: Transaction,
  merchant: string | null,
  stored: readonly LineItem[],
): LedgerRecord {
  return {
    id: transaction.id,
    captureId: transaction.captureId,
    date: transaction.occurredAt,
    merchant,
    merchantId: transaction.merchantId,
    items: itemsOf(transaction, merchant, stored),
    total: { amountMinor: transaction.amountMinor, currency: transaction.currency },
    source: transaction.source,
    categoryId: transaction.categoryId,
    accountId: transaction.accountId,
    note: transaction.note,
    confirmedAt: transaction.confirmedAt,
    reconciled: transaction.reconciled,
  };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
