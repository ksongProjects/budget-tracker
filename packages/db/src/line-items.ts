import { LineItemSchema, uuidv7 } from '@budget/schema';
import type { LineItem, LineItemId, TransactionId } from '@budget/schema';
import type { RepositoryContext } from './context.js';
import { DatabaseError } from './driver.js';
import type { SqlValue } from './driver.js';
import { recordTombstone } from './tombstones.js';

/**
 * The breakdown behind one transaction: what was actually bought, in the order
 * the receipt printed it.
 *
 * Line items are never authoritative about the amount — `transactions.amount_minor`
 * is what the user confirmed, and these rows may not add up to it (a discount
 * line, a row OCR lost). The gap is shown rather than reconciled away, which is
 * why `reconciled` lives on the transaction and not here.
 */

export type NewLineItem = Omit<
  LineItem,
  'id' | 'rev' | 'updatedAt' | 'deletedAt' | 'originDevice'
> & { readonly id?: LineItemId };

/** One row of a breakdown as a screen holds it, before it belongs to anything. */
export type DraftLineItem = Omit<NewLineItem, 'transactionId' | 'position'>;

const COLUMNS = [
  'id',
  'transaction_id',
  'kind',
  'name',
  'quantity',
  'unit_price_minor',
  'total_minor',
  'position',
  'rev',
  'updated_at',
  'deleted_at',
  'origin_device',
] as const;

interface LineItemRow {
  readonly id: string;
  readonly transaction_id: string;
  readonly kind: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit_price_minor: number | null;
  readonly total_minor: number;
  readonly position: number;
  readonly rev: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
  readonly origin_device: string;
}

export function toLineItem(row: LineItemRow): LineItem {
  return LineItemSchema.parse({
    id: row.id,
    transactionId: row.transaction_id,
    kind: row.kind,
    name: row.name,
    quantity: row.quantity,
    unitPriceMinor: row.unit_price_minor,
    totalMinor: row.total_minor,
    position: row.position,
    rev: row.rev,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    originDevice: row.origin_device,
  });
}

export function fromLineItem(item: LineItem): SqlValue[] {
  return [
    item.id,
    item.transactionId,
    item.kind,
    item.name,
    item.quantity,
    item.unitPriceMinor,
    item.totalMinor,
    item.position,
    item.rev,
    item.updatedAt,
    item.deletedAt,
    item.originDevice,
  ];
}

const SELECT = `SELECT ${COLUMNS.join(', ')} FROM line_items`;

export class LineItemRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async create(input: NewLineItem): Promise<LineItem> {
    const item = LineItemSchema.parse({
      ...input,
      id: input.id ?? uuidv7(),
      rev: 1,
      updatedAt: this.ctx.clock(),
      deletedAt: null,
      originDevice: this.ctx.deviceId,
    });

    await this.write(item, 'INSERT');
    return item;
  }

  async get(id: LineItemId): Promise<LineItem | undefined> {
    const row = await this.ctx.driver.get<LineItemRow>(`${SELECT} WHERE id = ?`, [id]);
    return row ? toLineItem(row) : undefined;
  }

  /** A transaction's breakdown, in printed order. Deleted rows stay out. */
  async listFor(transactionId: TransactionId): Promise<LineItem[]> {
    const rows = await this.ctx.driver.all<LineItemRow>(
      `${SELECT} WHERE transaction_id = ? AND deleted_at IS NULL ORDER BY position, id`,
      [transactionId],
    );
    return rows.map(toLineItem);
  }

  async update(
    id: LineItemId,
    patch: Partial<Omit<LineItem, 'id' | 'rev' | 'updatedAt' | 'deletedAt' | 'originDevice'>>,
  ): Promise<LineItem> {
    return this.ctx.driver.transaction(async () => {
      const existing = await this.get(id);
      if (!existing) throw new DatabaseError(`no line item ${id}`);

      await recordTombstone(this.ctx, 'line_items', id, existing.rev, existing);

      const next = LineItemSchema.parse({
        ...existing,
        ...patch,
        rev: existing.rev + 1,
        updatedAt: this.ctx.clock(),
        originDevice: this.ctx.deviceId,
      });

      await this.write(next, 'REPLACE');
      return next;
    });
  }

  async softDelete(id: LineItemId): Promise<void> {
    await this.ctx.driver.transaction(async () => {
      const existing = await this.get(id);
      if (!existing) return;

      await recordTombstone(this.ctx, 'line_items', id, existing.rev, existing);
      const at = this.ctx.clock();

      await this.write(
        {
          ...existing,
          rev: existing.rev + 1,
          updatedAt: at,
          deletedAt: at,
          originDevice: this.ctx.deviceId,
        },
        'REPLACE',
      );
    });
  }

  /**
   * Set a transaction's whole breakdown at once.
   *
   * An edited table is a new list, not a diff: rows move, merge and disappear
   * as the user retypes them, and matching old rows to new ones by name would
   * guess wrong exactly when a name was the thing being corrected. The old rows
   * are soft-deleted, so every superseded revision is still recoverable, and the
   * new ones carry their position from the order on screen.
   *
   * All of it in one database transaction: a breakdown half-replaced is worse
   * than one not replaced at all.
   */
  async replaceFor(
    transactionId: TransactionId,
    items: readonly DraftLineItem[],
  ): Promise<LineItem[]> {
    return this.ctx.driver.transaction(async () => {
      for (const existing of await this.listFor(transactionId)) {
        await recordTombstone(this.ctx, 'line_items', existing.id, existing.rev, existing);
        const at = this.ctx.clock();
        await this.write(
          {
            ...existing,
            rev: existing.rev + 1,
            updatedAt: at,
            deletedAt: at,
            originDevice: this.ctx.deviceId,
          },
          'REPLACE',
        );
      }

      const written: LineItem[] = [];

      for (const [position, draft] of items.entries()) {
        const item = LineItemSchema.parse({
          ...draft,
          id: uuidv7(),
          transactionId,
          position,
          rev: 1,
          updatedAt: this.ctx.clock(),
          deletedAt: null,
          originDevice: this.ctx.deviceId,
        });

        await this.write(item, 'INSERT');
        written.push(item);
      }

      return written;
    });
  }

  private async write(item: LineItem, verb: 'INSERT' | 'REPLACE'): Promise<void> {
    const placeholders = COLUMNS.map(() => '?').join(', ');
    await this.ctx.driver.run(
      `${verb === 'INSERT' ? 'INSERT INTO' : 'INSERT OR REPLACE INTO'} line_items (${COLUMNS.join(', ')}) VALUES (${placeholders})`,
      fromLineItem(item),
    );
  }
}
