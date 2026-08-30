import { deriveKek, parseRecoveryKey } from '@budget/crypto';
import type { SodiumBackend } from '@budget/crypto';
import { fromBase64, readArchive, readHeader } from '@budget/backup';
import { SCHEMA_VERSION, mergeAll } from '@budget/db';
import type { MergeableRow, RepositoryContext } from '@budget/db';
import type { WebDriver } from '../db/driver';

/**
 * Opening a Backup in the browser.
 *
 * The same archive the phone writes, read by the same code — this file only
 * supplies the parts that differ: where the snapshot is put down (OPFS) and
 * where the secret comes from (a form, not a keystore).
 *
 * Restore merges, exactly as on mobile. A browser that overwrote the local
 * ledger with an older archive would lose whatever was captured here since,
 * and "I opened my backup and it deleted my week" is not a recoverable
 * reputation.
 */

/** Where the archive's snapshot is staged before it is read. */
const SNAPSHOT_NAME = 'restore.db';

const BACKUP_TABLES = [
  'merchants',
  'merchant_aliases',
  'categories',
  'accounts',
  'captures',
  'transactions',
  'line_items',
] as const;

export interface ImportResult {
  readonly createdAt: number;
  readonly schemaVersion: number;
  readonly merged: Record<string, { inserted: number; updated: number; kept: number }>;
  /** Documents the archive carried. The browser keeps them out of the ledger for now. */
  readonly documents: number;
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/**
 * The key that opens an archive, from whatever the user typed.
 *
 * A recovery key is recognisable by its shape; anything else is a password,
 * stretched with the salt and parameters the archive carries. Never with this
 * device's own — a browser that has never seen this user has no salt, which is
 * the whole case this function exists for.
 */
export function secretFor(
  sodium: SodiumBackend,
  archive: Uint8Array,
  typed: string,
): Uint8Array {
  const parsed = parseRecoveryKey(typed);
  if (parsed !== null) return parsed;

  const { header } = readHeader(archive);
  return deriveKek(sodium, typed, fromBase64(header.kdf.salt), header.kdf);
}

/**
 * Read an archive into the local ledger.
 *
 * The driver is reopened onto a staged snapshot to read its rows, then back
 * onto the live ledger to merge them. One connection does both because the
 * OPFS pool will not hand a second worker its access handles.
 */
export async function importArchive(
  ctx: RepositoryContext & { readonly driver: WebDriver },
  archive: Uint8Array,
  secret: Uint8Array,
  sodium: SodiumBackend,
  ledgerName: string,
): Promise<ImportResult> {
  const { header, entries } = readArchive(sodium, archive, secret);

  if (header.schemaVersion > SCHEMA_VERSION) {
    // Refusing beats a partial import: a newer schema may carry columns this
    // build would silently drop on the way in.
    throw new ImportError(
      `This backup was written by a newer version (schema ${String(header.schemaVersion)}).`,
    );
  }

  const snapshot = entries.find((entry) => entry.kind === 'db');
  if (snapshot === undefined) throw new ImportError('This backup contains no ledger.');

  const rows: Record<string, MergeableRow[]> = {};

  await ctx.driver.stage(SNAPSHOT_NAME, snapshot.bytes);
  await ctx.driver.reopen(SNAPSHOT_NAME);
  try {
    for (const table of BACKUP_TABLES) {
      rows[table] = await ctx.driver.all<MergeableRow>(`SELECT * FROM ${table}`);
    }
  } finally {
    await ctx.driver.reopen(ledgerName);
    // The staged copy is the whole ledger in the clear. Leaving it in OPFS
    // would undo the point of the archive being encrypted at all.
    await ctx.driver.unstage(SNAPSHOT_NAME);
  }

  const merged = await mergeAll(ctx, rows);

  return {
    createdAt: header.createdAt,
    schemaVersion: header.schemaVersion,
    merged,
    documents: entries.filter((entry) => entry.kind === 'document').length,
  };
}
