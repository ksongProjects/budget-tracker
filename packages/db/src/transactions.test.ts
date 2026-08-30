import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CurrencySchema, uuidv7 } from '@budget/schema';
import type { CategoryId, DeviceId, MerchantId, MinorUnits, Timestamp } from '@budget/schema';
import { createNodeDriver } from './drivers/node.js';
import type { SqliteDriver } from './driver.js';
import { migrate } from './migrate.js';
import type { RepositoryContext } from './context.js';
import { TransactionRepository } from './transactions.js';
import type { NewTransaction } from './transactions.js';
import { tombstonesFor } from './tombstones.js';

const USD = CurrencySchema.parse('USD');
const DAY = 86_400_000;

let driver: SqliteDriver;
let ctx: RepositoryContext;
let repo: TransactionRepository;
let clockValue = 1_700_000_000_000;

const tick = (): Timestamp => (clockValue += 1) as Timestamp;
const at = (ms: number): Timestamp => ms as Timestamp;
const money = (n: number): MinorUnits => n as MinorUnits;

beforeEach(async () => {
  clockValue = 1_700_000_000_000;
  driver = createNodeDriver();
  await migrate(driver);
  ctx = { driver, deviceId: 'device-a' as DeviceId, clock: tick };
  repo = new TransactionRepository(ctx);
});

afterEach(async () => {
  await driver.close();
});

const draft = (over: Partial<NewTransaction> = {}): NewTransaction => ({
  captureId: null,
  accountId: null,
  merchantId: null,
  categoryId: null,
  amountMinor: money(1234),
  currency: USD,
  occurredAt: at(1_700_000_000_000),
  postedAt: null,
  note: null,
  source: 'manual',
  confirmedAt: null,
  fxOriginalMinor: null,
  fxOriginalCurrency: null,
  fxRate: null,
  reconciled: false,
  ...over,
});

describe('create and get', () => {
  it('round-trips a transaction through SQLite unchanged', async () => {
    const created = await repo.create(draft({ note: 'oat latte' }));
    const loaded = await repo.get(created.id);
    expect(loaded).toEqual(created);
  });

  it('stamps the merge quartet on creation', async () => {
    const created = await repo.create(draft());
    expect(created.rev).toBe(1);
    expect(created.originDevice).toBe('device-a');
    expect(created.deletedAt).toBeNull();
    expect(created.updatedAt).toBeGreaterThan(0);
  });

  it('preserves booleans across the 0/1 column', async () => {
    const created = await repo.create(draft({ reconciled: true }));
    expect((await repo.get(created.id))?.reconciled).toBe(true);
  });

  it('preserves foreign currency detail', async () => {
    const created = await repo.create(
      draft({
        fxOriginalMinor: money(1500),
        fxOriginalCurrency: CurrencySchema.parse('EUR'),
        fxRate: 1.08,
      }),
    );
    const loaded = await repo.get(created.id);
    expect(loaded?.fxOriginalCurrency).toBe('EUR');
    expect(loaded?.fxRate).toBeCloseTo(1.08);
  });

  it('returns undefined for an unknown id', async () => {
    expect(await repo.get(uuidv7() as never)).toBeUndefined();
  });
});

describe('update', () => {
  it('bumps rev and updatedAt', async () => {
    const created = await repo.create(draft());
    const updated = await repo.update(created.id, { note: 'corrected' });

    expect(updated.rev).toBe(2);
    expect(updated.note).toBe('corrected');
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
  });

  it('keeps the superseded revision as a tombstone', async () => {
    const created = await repo.create(draft({ amountMinor: money(1234) }));
    await repo.update(created.id, { amountMinor: money(9999) });

    const history = await tombstonesFor(ctx, 'transactions', created.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.rev).toBe(1);

    const payload = JSON.parse(history[0]?.payload ?? '{}') as { amountMinor: number };
    expect(payload.amountMinor).toBe(1234);
  });

  it('accumulates a tombstone per overwrite', async () => {
    const created = await repo.create(draft());
    await repo.update(created.id, { note: 'first' });
    await repo.update(created.id, { note: 'second' });

    expect(await tombstonesFor(ctx, 'transactions', created.id)).toHaveLength(2);
  });

  it('rejects an unknown id', async () => {
    await expect(repo.update(uuidv7() as never, { note: 'x' })).rejects.toThrow();
  });

  it('leaves the row untouched when the patch is invalid', async () => {
    const created = await repo.create(draft());
    await expect(repo.update(created.id, { amountMinor: 12.5 as MinorUnits })).rejects.toThrow();

    const after = await repo.get(created.id);
    expect(after?.rev).toBe(1);
    expect(await tombstonesFor(ctx, 'transactions', created.id)).toHaveLength(0);
  });
});

describe('soft delete', () => {
  it('hides the row from queries but keeps it on disk for Merge', async () => {
    const created = await repo.create(draft({ confirmedAt: at(1) }));
    await repo.softDelete(created.id);

    expect(await repo.list()).toHaveLength(0);
    expect(await repo.total()).toBe(0);

    const raw = await driver.get<{ deleted_at: number | null; rev: number }>(
      'SELECT deleted_at, rev FROM transactions WHERE id = ?',
      [created.id],
    );
    expect(raw?.deleted_at).not.toBeNull();
    expect(raw?.rev).toBe(2);
  });

  it('records the pre-delete revision', async () => {
    const created = await repo.create(draft());
    await repo.softDelete(created.id);
    expect(await tombstonesFor(ctx, 'transactions', created.id)).toHaveLength(1);
  });
});

describe('confirm', () => {
  it('is what admits a row to the totals', async () => {
    const created = await repo.create(draft({ amountMinor: money(500) }));
    expect(await repo.total()).toBe(0);

    await repo.confirm(created.id);
    expect(await repo.total()).toBe(500);
  });
});

describe('list filters', () => {
  beforeEach(async () => {
    const base = 1_700_000_000_000;
    await repo.create(draft({ occurredAt: at(base), amountMinor: money(100), confirmedAt: at(1) }));
    await repo.create(draft({ occurredAt: at(base + DAY), amountMinor: money(200), confirmedAt: at(1) }));
    await repo.create(draft({ occurredAt: at(base + 2 * DAY), amountMinor: money(300) }));
  });

  it('returns newest first', async () => {
    const rows = await repo.list();
    expect(rows.map((r) => r.amountMinor)).toEqual([300, 200, 100]);
  });

  it('filters by date range', async () => {
    const base = 1_700_000_000_000;
    const rows = await repo.list({ from: at(base + DAY), to: at(base + DAY) });
    expect(rows.map((r) => r.amountMinor)).toEqual([200]);
  });

  it('filters by amount range', async () => {
    const rows = await repo.list({ minAmount: money(150), maxAmount: money(250) });
    expect(rows.map((r) => r.amountMinor)).toEqual([200]);
  });

  it('filters by confirmation state', async () => {
    expect(await repo.list({ confirmed: false })).toHaveLength(1);
    expect(await repo.list({ confirmed: true })).toHaveLength(2);
  });

  it('pages by cursor', async () => {
    const first = await repo.list({ limit: 2 });
    expect(first).toHaveLength(2);

    const cursor = first[1]!.occurredAt;
    const next = await repo.list({ limit: 2, cursor });
    expect(next.map((r) => r.amountMinor)).toEqual([100]);
  });

  it('filters by merchant and category', async () => {
    const merchantId = uuidv7() as MerchantId;
    const categoryId = uuidv7() as CategoryId;
    await driver.run(
      `INSERT INTO merchants (id, canonical_name, updated_at, origin_device) VALUES (?, 'Blue Bottle', 1, 'dev')`,
      [merchantId],
    );
    await driver.run(
      `INSERT INTO categories (id, name, updated_at, origin_device) VALUES (?, 'Coffee', 1, 'dev')`,
      [categoryId],
    );
    await repo.create(draft({ merchantId, categoryId, amountMinor: money(777), confirmedAt: at(1) }));

    expect(await repo.list({ merchantId })).toHaveLength(1);
    expect(await repo.list({ categoryId })).toHaveLength(1);
  });
});

describe('summary', () => {
  it('excludes unconfirmed rows from every total', async () => {
    const categoryId = uuidv7() as CategoryId;
    await driver.run(
      `INSERT INTO categories (id, name, updated_at, origin_device) VALUES (?, 'Coffee', 1, 'dev')`,
      [categoryId],
    );

    await repo.create(draft({ categoryId, amountMinor: money(500), confirmedAt: at(1) }));
    await repo.create(draft({ categoryId, amountMinor: money(300), confirmedAt: at(1) }));
    // Proposed but not accepted: must not appear anywhere in a total.
    await repo.create(draft({ categoryId, amountMinor: money(9999) }));

    const byCategory = await repo.summary('category');
    expect(byCategory).toEqual([{ key: categoryId, totalMinor: 800, count: 2 }]);
    expect(await repo.total()).toBe(800);
  });

  it('groups by month', async () => {
    // 2024-01-15 and 2024-02-15 UTC.
    await repo.create(draft({ occurredAt: at(1_705_276_800_000), amountMinor: money(100), confirmedAt: at(1) }));
    await repo.create(draft({ occurredAt: at(1_707_955_200_000), amountMinor: money(250), confirmedAt: at(1) }));

    const byMonth = await repo.summary('month');
    expect(byMonth).toEqual(
      expect.arrayContaining([
        { key: '2024-02', totalMinor: 250, count: 1 },
        { key: '2024-01', totalMinor: 100, count: 1 },
      ]),
    );
  });

  it('ignores soft-deleted rows', async () => {
    const kept = await repo.create(draft({ amountMinor: money(100), confirmedAt: at(1) }));
    const gone = await repo.create(draft({ amountMinor: money(500), confirmedAt: at(1) }));
    await repo.softDelete(gone.id);

    expect(await repo.total()).toBe(100);
    expect((await repo.list()).map((r) => r.id)).toEqual([kept.id]);
  });
});

describe('search', () => {
  it('finds by note and by merchant name', async () => {
    const merchantId = uuidv7() as MerchantId;
    await driver.run(
      `INSERT INTO merchants (id, canonical_name, updated_at, origin_device) VALUES (?, 'Blue Bottle Coffee', 1, 'dev')`,
      [merchantId],
    );
    await repo.create(draft({ merchantId, note: 'oat latte before the flight' }));

    expect(await repo.search('latte')).toHaveLength(1);
    expect(await repo.search('bottle')).toHaveLength(1);
    expect(await repo.search('parking')).toHaveLength(0);
  });

  it('matches on prefixes, so search works while typing', async () => {
    await repo.create(draft({ note: 'groceries' }));
    expect(await repo.search('groc')).toHaveLength(1);
  });

  it('treats punctuation as text rather than FTS syntax', async () => {
    await repo.create(draft({ note: 'SQ *BLUE BOTTLE' }));

    // These would be syntax errors or operators if passed through raw.
    for (const query of ['SQ *BLUE', '"BLUE', 'BOTTLE -', 'NOT']) {
      await expect(repo.search(query)).resolves.toBeInstanceOf(Array);
    }
  });

  it('returns nothing for an empty query', async () => {
    await repo.create(draft({ note: 'anything' }));
    expect(await repo.search('   ')).toEqual([]);
  });

  it('excludes soft-deleted rows', async () => {
    const created = await repo.create(draft({ note: 'parking meter' }));
    await repo.softDelete(created.id);
    expect(await repo.search('parking')).toHaveLength(0);
  });
});
