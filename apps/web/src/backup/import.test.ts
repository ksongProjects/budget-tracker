import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KDF_PARAMS, deriveKek, generateRecoveryKey, generateSalt } from '@budget/crypto';
import type { SodiumBackend } from '@budget/crypto';
import { createLibsodiumBackend } from '@budget/crypto/libsodium';
import { writeArchive } from '@budget/backup';
import { SCHEMA_VERSION, migrate, systemClock } from '@budget/db';
import type { RepositoryContext } from '@budget/db';
import type { DeviceId } from '@budget/schema';
import { createWebDriver } from '../db/driver';
import type { WebDriver } from '../db/driver';
import { createDatabaseWorker } from '../db/worker-url';
import { ImportError, importArchive, secretFor } from './import';

/**
 * A real archive, written and read in a browser.
 *
 * The database bytes come out of OPFS and go back into it, through the same
 * format code the phone uses. That is the claim Phase 6 rests on: an archive is
 * an archive, whoever wrote it — and the only honest way to check it is to move
 * actual SQLite files rather than a fixture that stands in for one.
 */

const PASSWORD = 'a real backup password';
const LEDGER = 'import-ledger.db';

let sodium: SodiumBackend;
let driver: WebDriver;
let ctx: RepositoryContext & { readonly driver: WebDriver };

beforeAll(async () => {
  sodium = await createLibsodiumBackend();
  driver = await createWebDriver({ worker: createDatabaseWorker(), name: LEDGER });
  ctx = { driver, deviceId: 'web-device' as DeviceId, clock: systemClock };
});

afterAll(async () => {
  await driver.wipe();
  await driver.close();
});

/** A ledger with one transaction in it, and the archive that captures it. */
async function archiveOfOneTransaction(): Promise<{ bytes: Uint8Array; salt: Uint8Array }> {
  // From scratch every time: the pool is per origin, so the previous case's
  // ledger is still sitting there unless it is cleared.
  await driver.wipe();
  await driver.reopen(LEDGER);
  await migrate(driver);
  await driver.run(
    `INSERT INTO transactions
       (id, amount_minor, currency, occurred_at, source, confirmed_at,
        reconciled, rev, updated_at, origin_device)
     VALUES ('t-1', 1234, 'USD', 1772000000000, 'manual', 1772000000000, 0, 1, 1772000000000, 'web-device')`,
  );

  const snapshot = await driver.export(LEDGER);
  const salt = generateSalt(sodium);
  const kek = deriveKek(sodium, PASSWORD, salt, KDF_PARAMS);

  const { bytes } = writeArchive(
    sodium,
    [{ id: 'db', kind: 'db', bytes: snapshot }],
    kek,
    generateRecoveryKey(sodium),
    salt,
    {
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      createdAt: 1_772_000_000_000,
      kdfParams: KDF_PARAMS,
    },
  );

  return { bytes, salt };
}

/** An empty ledger, as a browser that has never seen this user would have. */
async function emptyLedger(): Promise<void> {
  await driver.wipe();
  await driver.reopen(LEDGER);
  await migrate(driver);
}

describe('importing a backup', () => {
  it('brings the rows into an empty ledger', async () => {
    const { bytes } = await archiveOfOneTransaction();
    await emptyLedger();

    const result = await importArchive(ctx, bytes, secretFor(sodium, bytes, PASSWORD), sodium, LEDGER);

    expect(result.createdAt).toBe(1_772_000_000_000);
    expect(result.merged['transactions']?.inserted).toBe(1);

    const rows = await driver.all<{ id: string; amount_minor: number }>(
      'SELECT id, amount_minor FROM transactions',
    );
    expect(rows).toEqual([{ id: 't-1', amount_minor: 1234 }]);
  });

  it('merges rather than overwrites', async () => {
    // Someone captured something in this browser after the backup was taken.
    // Opening the backup must not be how they lose it.
    const { bytes } = await archiveOfOneTransaction();
    await emptyLedger();
    await driver.run(
      `INSERT INTO transactions
         (id, amount_minor, currency, occurred_at, source, confirmed_at,
          reconciled, rev, updated_at, origin_device)
       VALUES ('t-2', 999, 'USD', 1772000001000, 'manual', 1772000001000, 0, 1, 1772000001000, 'web-device')`,
    );

    await importArchive(ctx, bytes, secretFor(sodium, bytes, PASSWORD), sodium, LEDGER);

    const rows = await driver.all<{ id: string }>('SELECT id FROM transactions ORDER BY id');
    expect(rows.map((row) => row.id)).toEqual(['t-1', 't-2']);
  });

  it('leaves nothing decrypted behind', async () => {
    // The staged snapshot is the entire ledger in the clear. Its whole reason
    // for being encrypted is that it does not sit in storage afterwards.
    const { bytes } = await archiveOfOneTransaction();
    await emptyLedger();

    await importArchive(ctx, bytes, secretFor(sodium, bytes, PASSWORD), sodium, LEDGER);

    await expect(driver.export('restore.db')).rejects.toThrow();
  });

  it('refuses a password that does not open it', async () => {
    const { bytes } = await archiveOfOneTransaction();
    await emptyLedger();

    await expect(
      importArchive(ctx, bytes, secretFor(sodium, bytes, 'not the password'), sodium, LEDGER),
    ).rejects.toThrow();
  });

  it('derives the key from the archive, not from this browser', async () => {
    // A browser restoring after a lost phone has no salt of its own. Deriving
    // from a locally minted one produces a key that opens nothing.
    const { bytes, salt } = await archiveOfOneTransaction();

    expect(secretFor(sodium, bytes, PASSWORD)).toEqual(
      deriveKek(sodium, PASSWORD, salt, KDF_PARAMS),
    );
  });

  it('handles an archive far larger than a real ledger', async () => {
    // The plan budgets for 50 MB. This checks the shape of the cost rather than
    // an exact number: an implementation that copied the archive a few times on
    // the way in would fall over here long before it reached a user.
    const { bytes } = await archiveOfOneTransaction();
    await emptyLedger();

    const padded = await archiveWithPadding(24 * 1024 * 1024);
    const started = performance.now();

    await importArchive(ctx, padded, secretFor(sodium, padded, PASSWORD), sodium, LEDGER);

    expect(performance.now() - started).toBeLessThan(20_000);
    expect(bytes.length).toBeLessThan(padded.length);
  });

  it('refuses an archive from a newer schema instead of importing part of it', async () => {
    const { bytes } = await archiveOfOneTransaction();
    await emptyLedger();

    const future = await archiveWithSchema(SCHEMA_VERSION + 1);

    await expect(
      importArchive(ctx, future, secretFor(sodium, future, PASSWORD), sodium, LEDGER),
    ).rejects.toBeInstanceOf(ImportError);

    // And the good one still works, so the guard is about the version rather
    // than something incidental to how the archive was built.
    await expect(
      importArchive(ctx, bytes, secretFor(sodium, bytes, PASSWORD), sodium, LEDGER),
    ).resolves.toBeDefined();
  });
});

/** The same ledger, carrying a document big enough to be worth measuring. */
async function archiveWithPadding(padBytes: number): Promise<Uint8Array> {
  await driver.reopen(LEDGER);
  const snapshot = await driver.export(LEDGER);
  const salt = generateSalt(sodium);

  const document = new Uint8Array(padBytes);
  crypto.getRandomValues(document.subarray(0, 65_536));

  return writeArchive(
    sodium,
    [
      { id: 'db', kind: 'db', bytes: snapshot },
      { id: 'cap-1', kind: 'document', bytes: document },
    ],
    deriveKek(sodium, PASSWORD, salt, KDF_PARAMS),
    generateRecoveryKey(sodium),
    salt,
    {
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      createdAt: 1_772_000_000_000,
      kdfParams: KDF_PARAMS,
    },
  ).bytes;
}

async function archiveWithSchema(schemaVersion: number): Promise<Uint8Array> {
  const snapshot = await driver.export(LEDGER);
  const salt = generateSalt(sodium);

  return writeArchive(
    sodium,
    [{ id: 'db', kind: 'db', bytes: snapshot }],
    deriveKek(sodium, PASSWORD, salt, KDF_PARAMS),
    generateRecoveryKey(sodium),
    salt,
    {
      appVersion: '0.1.0',
      schemaVersion,
      createdAt: 1_772_000_000_000,
      kdfParams: KDF_PARAMS,
    },
  ).bytes;
}
