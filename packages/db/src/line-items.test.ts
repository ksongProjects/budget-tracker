import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import type { DeviceId, MinorUnits, Timestamp, TransactionId } from '@budget/schema';
import { createNodeDriver } from './drivers/node.js';
import type { SqliteDriver } from './driver.js';
import { migrate } from './migrate.js';
import type { RepositoryContext } from './context.js';
import { LineItemRepository } from './line-items.js';
import type { DraftLineItem } from './line-items.js';
import { TransactionRepository } from './transactions.js';
import { tombstonesFor } from './tombstones.js';

const USD = CurrencySchema.parse('USD');

let driver: SqliteDriver;
let ctx: RepositoryContext;
let repo: LineItemRepository;
let transactionId: TransactionId;
let clockValue = 1_700_000_000_000;

const tick = (): Timestamp => (clockValue += 1) as Timestamp;
const money = (n: number): MinorUnits => n as MinorUnits;

const item = (name: string, total: number): DraftLineItem => ({
  kind: 'item',
  name,
  quantity: null,
  unitPriceMinor: null,
  totalMinor: money(total),
});

beforeEach(async () => {
  clockValue = 1_700_000_000_000;
  driver = createNodeDriver();
  await migrate(driver);
  ctx = { driver, deviceId: 'device-a' as DeviceId, clock: tick };
  repo = new LineItemRepository(ctx);

  const transaction = await new TransactionRepository(ctx).create({
    captureId: null,
    accountId: null,
    merchantId: null,
    categoryId: null,
    amountMinor: money(1060),
    currency: USD,
    occurredAt: 1_700_000_000_000 as Timestamp,
    postedAt: null,
    note: null,
    source: 'photo',
    confirmedAt: null,
    fxOriginalMinor: null,
    fxOriginalCurrency: null,
    fxRate: null,
    reconciled: false,
  });
  transactionId = transaction.id;
});

afterEach(async () => {
  await driver.close();
});

describe('LineItemRepository', () => {
  it('returns a breakdown in the order it was printed, not the order it was written', async () => {
    await repo.replaceFor(transactionId, [
      item('Oat Latte', 550),
      item('Croissant', 425),
      { ...item('TAX', 85), kind: 'tax' },
    ]);

    const listed = await repo.listFor(transactionId);

    expect(listed.map((row) => row.name)).toEqual(['Oat Latte', 'Croissant', 'TAX']);
    expect(listed.map((row) => row.position)).toEqual([0, 1, 2]);
  });

  it('replaces a breakdown wholesale rather than merging it', async () => {
    await repo.replaceFor(transactionId, [item('Oat Latte', 550), item('Croissant', 425)]);
    await repo.replaceFor(transactionId, [item('Oat Latte', 550)]);

    const listed = await repo.listFor(transactionId);

    expect(listed.map((row) => row.name)).toEqual(['Oat Latte']);
  });

  it('keeps every superseded row recoverable', async () => {
    const [first] = await repo.replaceFor(transactionId, [item('Croissant', 425)]);
    await repo.replaceFor(transactionId, [item('Croissant', 450)]);

    const history = await tombstonesFor(ctx, 'line_items', first?.id ?? '');

    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0]?.payload ?? '{}')).toMatchObject({ totalMinor: 425 });
  });

  it('leaves a deleted row out of the breakdown but keeps it in the table', async () => {
    const [only] = await repo.replaceFor(transactionId, [item('Croissant', 425)]);
    if (!only) throw new Error('nothing written');

    await repo.softDelete(only.id);

    expect(await repo.listFor(transactionId)).toEqual([]);
    expect((await repo.get(only.id))?.deletedAt).not.toBeNull();
  });

  it('edits one row without touching its neighbours', async () => {
    const written = await repo.replaceFor(transactionId, [
      item('Oat Latte', 550),
      item('Croissant', 425),
    ]);
    const croissant = written[1];
    if (!croissant) throw new Error('nothing written');

    await repo.update(croissant.id, { totalMinor: money(450) });
    const listed = await repo.listFor(transactionId);

    expect(listed.map((row) => row.totalMinor)).toEqual([550, 450]);
    expect(listed[1]?.rev).toBe(2);
  });
});
