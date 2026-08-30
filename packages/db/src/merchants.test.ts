import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceId, Timestamp } from '@budget/schema';
import { createNodeDriver } from './drivers/node.js';
import type { SqliteDriver } from './driver.js';
import { migrate } from './migrate.js';
import type { RepositoryContext } from './context.js';
import {
  MerchantRepository,
  displayMerchantName,
  normalizeMerchantName,
} from './merchants.js';

describe('normalizeMerchantName', () => {
  it('folds the spellings of one real merchant together', () => {
    // The example from CONTEXT.md and docs/data-model.md.
    const key = normalizeMerchantName('BLUE BOTTLE COFFEE');
    expect(normalizeMerchantName('SQ *BLUE BOTTLE COFFEE')).toBe(key);
    expect(normalizeMerchantName('blue bottle coffee')).toBe(key);
    expect(normalizeMerchantName('BLUE-BOTTLE-COFFEE')).toBe(key);
    expect(normalizeMerchantName('  BLUE BOTTLE COFFEE  ')).toBe(key);
    expect(normalizeMerchantName('BLUE BOTTLE COFFEE #4')).toBe(key);
  });

  it('strips payment-processor prefixes', () => {
    for (const raw of ['SQ *TARTINE', 'SQ*TARTINE', 'TST* TARTINE', 'PAYPAL *TARTINE', 'SUMUP *TARTINE']) {
      expect(normalizeMerchantName(raw), raw).toBe('tartine');
    }
  });

  it('strips a top-level domain so the web store matches the shop', () => {
    expect(normalizeMerchantName('BLUEBOTTLE.COM')).toBe('bluebottle');
    expect(normalizeMerchantName('bluebottle.co')).toBe('bluebottle');
  });

  it('strips store numbers and terminal ids', () => {
    expect(normalizeMerchantName('SAFEWAY #1234')).toBe('safeway');
    expect(normalizeMerchantName('SAFEWAY 1234')).toBe('safeway');
    expect(normalizeMerchantName('SAFEWAY STORE 12')).toBe('safeway');
    expect(normalizeMerchantName('SAFEWAY 03/14')).toBe('safeway');
  });

  it('keeps distinct merchants distinct', () => {
    expect(normalizeMerchantName('BLUE BOTTLE')).not.toBe(normalizeMerchantName('BLUE RIDGE'));
    expect(normalizeMerchantName('TARGET')).not.toBe(normalizeMerchantName('TARGET OPTICAL'));
    expect(normalizeMerchantName('SHELL')).not.toBe(normalizeMerchantName('SHELL GAS'));
  });

  it('keeps digits that are part of the name', () => {
    expect(normalizeMerchantName('7-ELEVEN')).toBe('7 eleven');
    expect(normalizeMerchantName('99 RANCH MARKET')).toBe('99 ranch market');
  });

  it('survives strings that normalize to nothing', () => {
    expect(normalizeMerchantName('###')).toBe('');
    expect(normalizeMerchantName('   ')).toBe('');
  });
});

describe('displayMerchantName', () => {
  it('turns shouted receipt text into something readable', () => {
    expect(displayMerchantName('SQ *BLUE BOTTLE COFFEE')).toBe('Blue Bottle Coffee');
    expect(displayMerchantName('SAFEWAY #1234')).toBe('Safeway');
  });

  it('falls back to the raw string when nothing survives normalization', () => {
    expect(displayMerchantName('###')).toBe('###');
  });
});

describe('MerchantRepository', () => {
  let driver: SqliteDriver;
  let ctx: RepositoryContext;
  let repo: MerchantRepository;
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
    repo = new MerchantRepository(ctx);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('resolves the spellings of one merchant to one id', async () => {
    const first = await repo.resolve('SQ *BLUE BOTTLE COFFEE');
    const second = await repo.resolve('BLUE BOTTLE COFFEE');
    const third = await repo.resolve('blue bottle coffee #7');

    expect(second).toBe(first);
    expect(third).toBe(first);

    const count = await driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM merchants');
    expect(count?.n).toBe(1);
  });

  it('gives distinct merchants distinct ids', async () => {
    const bottle = await repo.resolve('BLUE BOTTLE');
    const ridge = await repo.resolve('BLUE RIDGE');
    expect(ridge).not.toBe(bottle);
  });

  it('stores a readable canonical name', async () => {
    const id = await repo.resolve('SQ *BLUE BOTTLE COFFEE');
    expect(await repo.name(id)).toBe('Blue Bottle Coffee');
  });

  it('lets a user attach an alias the normalizer would not have folded', async () => {
    const id = await repo.resolve('BLUE BOTTLE COFFEE');
    await repo.addAlias('BB CAFE', id);

    expect(await repo.resolve('bb cafe')).toBe(id);
  });

  it('repoints an existing alias without failing on the primary key', async () => {
    const first = await repo.resolve('CORNER STORE');
    const second = await repo.resolve('BODEGA');

    await repo.addAlias('CORNER STORE', second);
    expect(await repo.resolve('CORNER STORE')).toBe(second);
    expect(await repo.resolve('CORNER STORE')).not.toBe(first);
  });

  it('renames for display without breaking alias matching', async () => {
    const id = await repo.resolve('SQ *BLUE BOTTLE COFFEE');
    await repo.rename(id, 'Blue Bottle');

    expect(await repo.name(id)).toBe('Blue Bottle');
    expect(await repo.resolve('SQ *BLUE BOTTLE COFFEE')).toBe(id);
  });

  it('refuses a name that normalizes to nothing rather than creating a blank merchant', async () => {
    await expect(repo.resolve('###')).rejects.toThrow();
  });
});
