import { beforeEach, describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import type { DeviceId, Timestamp } from '@budget/schema';
import { createNodeDriver } from './drivers/node.js';
import type { SqliteDriver } from './driver.js';
import { migrate } from './migrate.js';
import type { RepositoryContext } from './context.js';
import { ProfileRepository, looksLikeEmail } from './profile.js';

let driver: SqliteDriver;
let profiles: ProfileRepository;
let clockValue = 1_700_000_000_000;

const USD = CurrencySchema.parse('USD');
const EUR = CurrencySchema.parse('EUR');

beforeEach(async () => {
  clockValue = 1_700_000_000_000;
  driver = createNodeDriver();
  await migrate(driver);

  const ctx: RepositoryContext = {
    driver,
    deviceId: 'device-a' as DeviceId,
    clock: (): Timestamp => (clockValue += 1) as Timestamp,
  };
  profiles = new ProfileRepository(ctx);
});

describe('the profile', () => {
  it('does not exist before it is written', async () => {
    expect(await profiles.exists()).toBe(false);
    expect(await profiles.read()).toBeUndefined();
  });

  it('is what the app checks before letting anyone in', async () => {
    await profiles.save({ displayName: 'Sam', email: 'sam@example.com', defaultCurrency: USD });
    expect(await profiles.exists()).toBe(true);
  });

  it('reads back what was written', async () => {
    await profiles.save({ displayName: 'Sam', email: 'sam@example.com', defaultCurrency: EUR });

    expect(await profiles.read()).toMatchObject({
      displayName: 'Sam',
      email: 'sam@example.com',
      defaultCurrency: EUR,
    });
  });

  it('stays one row however many times it is saved', async () => {
    await profiles.save({ displayName: 'Sam', defaultCurrency: USD });
    await profiles.save({ displayName: 'Sam Later', defaultCurrency: EUR });

    const rows = await driver.all('SELECT id FROM profile');
    expect(rows).toHaveLength(1);
    expect((await profiles.read())?.displayName).toBe('Sam Later');
  });

  it('climbs its revision on every save, so two devices can be compared', async () => {
    await profiles.save({ displayName: 'Sam', defaultCurrency: USD });
    await profiles.save({ displayName: 'Sam', defaultCurrency: EUR });

    const row = await driver.get<{ rev: number }>('SELECT rev FROM profile');
    expect(row?.rev).toBe(2);
  });

  it('treats a blank email as no email', async () => {
    await profiles.save({ displayName: 'Sam', email: '   ', defaultCurrency: USD });
    expect((await profiles.read())?.email).toBeNull();
  });

  it('works with no email at all, since only export uses one', async () => {
    await profiles.save({ displayName: 'Sam', defaultCurrency: USD });
    expect((await profiles.read())?.email).toBeNull();
  });

  it('refuses an empty name, which would leave exports unsigned', async () => {
    await expect(profiles.save({ displayName: '  ', defaultCurrency: USD })).rejects.toThrow(
      /name/i,
    );
  });

  it('survives a stored currency that is not a currency code', async () => {
    // A row written by an older build, or edited by hand. Falling over here
    // would lock the user out of the one screen that could fix it.
    await profiles.save({ displayName: 'Sam', defaultCurrency: USD });
    await driver.run("UPDATE profile SET default_currency = 'dollars'");

    expect((await profiles.read())?.defaultCurrency).toBe(USD);
  });
});

describe('looksLikeEmail', () => {
  it.each(['sam@example.com', 'a.b+tag@sub.example.co.uk'])('accepts %s', (value) => {
    expect(looksLikeEmail(value)).toBe(true);
  });

  it.each(['sam', 'sam@', '@example.com', 'sam@example', 'two words@example.com'])(
    'rejects %j',
    (value) => {
      expect(looksLikeEmail(value)).toBe(false);
    },
  );
});
