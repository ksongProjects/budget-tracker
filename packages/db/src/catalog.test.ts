import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CurrencySchema, uuidv7 } from '@budget/schema';
import type { AccountId, CategoryId, DeviceId, Timestamp } from '@budget/schema';
import { createNodeDriver } from './drivers/node.js';
import type { SqliteDriver } from './driver.js';
import { migrate } from './migrate.js';
import type { RepositoryContext } from './context.js';
import { CategoryRepository } from './categories.js';
import { AccountRepository } from './accounts.js';
import { tombstonesFor } from './tombstones.js';

const USD = CurrencySchema.parse('USD');

let driver: SqliteDriver;
let ctx: RepositoryContext;
let categories: CategoryRepository;
let accounts: AccountRepository;
let clockValue = 1_700_000_000_000;

beforeEach(async () => {
  clockValue = 1_700_000_000_000;
  driver = createNodeDriver();
  await migrate(driver);
  ctx = {
    driver,
    deviceId: 'device-a' as DeviceId,
    clock: (): Timestamp => (clockValue += 1) as Timestamp,
  };
  categories = new CategoryRepository(ctx);
  accounts = new AccountRepository(ctx);
});

afterEach(async () => {
  await driver.close();
});

describe('CategoryRepository', () => {
  it('creates and reads back', async () => {
    const created = await categories.create('Coffee');
    expect(await categories.get(created.id)).toEqual(created);
    expect(created.rev).toBe(1);
  });

  it('trims whitespace and refuses an empty name', async () => {
    expect((await categories.create('  Coffee  ')).name).toBe('Coffee');
    await expect(categories.create('   ')).rejects.toThrow();
  });

  it('lists alphabetically, ignoring case', async () => {
    await categories.create('transit');
    await categories.create('Coffee');
    await categories.create('Groceries');

    expect((await categories.list()).map((c) => c.name)).toEqual([
      'Coffee',
      'Groceries',
      'transit',
    ]);
  });

  it('finds by name case-insensitively, so a picker does not create duplicates', async () => {
    const created = await categories.create('Coffee');
    expect((await categories.findByName('coffee'))?.id).toBe(created.id);
    expect((await categories.findByName('  COFFEE  '))?.id).toBe(created.id);
  });

  it('resolve reuses an existing category rather than duplicating it', async () => {
    const first = await categories.resolve('Coffee');
    const second = await categories.resolve('coffee');

    expect(second.id).toBe(first.id);
    expect(await categories.list()).toHaveLength(1);
  });

  it('supports a parent category', async () => {
    const parent = await categories.create('Food');
    const child = await categories.create('Coffee', parent.id);
    expect(child.parentId).toBe(parent.id);
  });

  it('rejects a parent that does not exist', async () => {
    await expect(categories.create('Coffee', uuidv7() as CategoryId)).rejects.toThrow();
  });

  it('renames, bumping rev and keeping the old name recoverable', async () => {
    const created = await categories.create('Coffe');
    const renamed = await categories.rename(created.id, 'Coffee');

    expect(renamed.name).toBe('Coffee');
    expect(renamed.rev).toBe(2);

    const history = await tombstonesFor(ctx, 'categories', created.id);
    const payload = JSON.parse(history[0]?.payload ?? '{}') as { name: string };
    expect(payload.name).toBe('Coffe');
  });

  it('soft deletes without rewriting the transactions filed under it', async () => {
    const category = await categories.create('Coffee');
    await driver.run(
      `INSERT INTO transactions (id, category_id, amount_minor, currency, occurred_at, source, updated_at, origin_device)
       VALUES ('t1', ?, 500, 'USD', 1, 'manual', 1, 'dev')`,
      [category.id],
    );

    await categories.softDelete(category.id);

    expect(await categories.list()).toHaveLength(0);

    // The transaction keeps its attribution: history is not rewritten to tidy a list.
    const row = await driver.get<{ category_id: string | null }>(
      'SELECT category_id FROM transactions WHERE id = ?',
      ['t1'],
    );
    expect(row?.category_id).toBe(category.id);
  });

  it('rejects renaming or deleting something that does not exist', async () => {
    const ghost = uuidv7() as CategoryId;
    await expect(categories.rename(ghost, 'x')).rejects.toThrow();
    await expect(categories.softDelete(ghost)).rejects.toThrow();
  });
});

describe('AccountRepository', () => {
  it('creates with a currency', async () => {
    const created = await accounts.create('Visa', USD);
    expect(created.currency).toBe('USD');
    expect(await accounts.get(created.id)).toEqual(created);
  });

  it('refuses an empty name', async () => {
    await expect(accounts.create('  ', USD)).rejects.toThrow();
  });

  it('lists alphabetically', async () => {
    await accounts.create('Visa', USD);
    await accounts.create('Amex', USD);
    expect((await accounts.list()).map((a) => a.name)).toEqual(['Amex', 'Visa']);
  });

  it('renames and keeps the previous name recoverable', async () => {
    const created = await accounts.create('Visa', USD);
    await accounts.rename(created.id, 'Visa ...4242');

    const history = await tombstonesFor(ctx, 'accounts', created.id);
    const payload = JSON.parse(history[0]?.payload ?? '{}') as { name: string };
    expect(payload.name).toBe('Visa');
  });

  it('soft deletes', async () => {
    const created = await accounts.create('Visa', USD);
    await accounts.softDelete(created.id);

    expect(await accounts.list()).toHaveLength(0);
    expect((await accounts.get(created.id))?.deletedAt).not.toBeNull();
  });

  it('rejects operations on an unknown account', async () => {
    const ghost = uuidv7() as AccountId;
    await expect(accounts.rename(ghost, 'x')).rejects.toThrow();
    await expect(accounts.softDelete(ghost)).rejects.toThrow();
  });
});
