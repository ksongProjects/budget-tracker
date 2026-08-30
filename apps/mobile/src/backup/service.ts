import * as FileSystem from 'expo-file-system/legacy';
import { SCHEMA_VERSION, mergeAll } from '@budget/db';
import type { MergeableRow, RepositoryContext } from '@budget/db';
import { KDF_PARAMS, deriveKek } from '@budget/crypto';
import type { SodiumBackend } from '@budget/crypto';
import { readArchive, readHeader, writeArchive } from '@budget/backup';
import type { ArchiveEntry } from '@budget/backup';
import { createNativeSodiumBackend } from '../crypto/backend';
import {
  adoptKeyMaterial,
  loadOrCreateKeyMaterial,
  loadRecoveryWrap,
  storeRecoveryWrap,
} from './keys';

/**
 * Writing and restoring a real backup: the ledger, its documents, and enough
 * metadata to open the archive on a device that has never seen this one.
 *
 * Restore never overwrites — it merges (docs/data-model.md), so restoring an
 * old backup onto a newer ledger cannot lose the newer rows.
 */

const BACKUP_DIR = `${FileSystem.documentDirectory ?? ''}backups/`;
const APP_VERSION = '0.1.0';

/** Tables a backup carries, in the order Merge expects. */
const BACKUP_TABLES = [
  'merchants',
  'merchant_aliases',
  'categories',
  'accounts',
  'captures',
  'transactions',
  'line_items',
] as const;

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly createdAt: number;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(BACKUP_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(BACKUP_DIR, { intermediates: true });
  }
}

/**
 * A consistent snapshot of the database.
 *
 * `VACUUM INTO` writes a clean copy while the app keeps running, which is the
 * whole reason to use it: copying the file underneath a live connection can
 * capture a torn write.
 */
async function snapshotDatabase(ctx: RepositoryContext): Promise<Uint8Array> {
  await ensureDir();
  const snapshotPath = `${BACKUP_DIR}snapshot.db`;

  await FileSystem.deleteAsync(snapshotPath, { idempotent: true });
  // The path is interpolated because VACUUM INTO takes no bind parameters.
  await ctx.driver.exec(`VACUUM INTO '${snapshotPath.replace('file://', '')}'`);

  const base64 = await FileSystem.readAsStringAsync(snapshotPath, {
    encoding: FileSystem.EncodingType.Base64,
  });
  await FileSystem.deleteAsync(snapshotPath, { idempotent: true });

  return decodeBase64(base64);
}

/** Every document this ledger references, as archive entries. */
async function collectDocuments(ctx: RepositoryContext): Promise<ArchiveEntry[]> {
  const rows = await ctx.driver.all<{
    capture_id: string;
    document_path: string | null;
    document_hash: string | null;
  }>(
    `SELECT capture_id, document_path, document_hash FROM captures
     WHERE document_path IS NOT NULL AND deleted_at IS NULL`,
  );

  const entries: ArchiveEntry[] = [];

  for (const row of rows) {
    if (row.document_path === null) continue;

    const info = await FileSystem.getInfoAsync(row.document_path);
    if (!info.exists) {
      // A missing file must not fail the whole backup: the ledger row is the
      // valuable part, and a lost photo is not worth losing the ledger over.
      continue;
    }

    const base64 = await FileSystem.readAsStringAsync(row.document_path, {
      encoding: FileSystem.EncodingType.Base64,
    });

    entries.push({
      id: row.capture_id,
      kind: 'document',
      bytes: decodeBase64(base64),
      ...(row.document_hash === null ? {} : { hash: row.document_hash }),
    });
  }

  return entries;
}

/**
 * Write a backup for this device.
 *
 * The archive is sealed with the stored BMK, wrapped by both the password KEK
 * and the recovery key, so it opens with either.
 */
export async function createBackup(
  ctx: RepositoryContext,
  password: string,
  /**
   * The recovery key, at setup when the user has just been shown it. Omitted
   * afterwards, when the stored wrap carries the recovery path forward.
   */
  recoveryKey?: Uint8Array,
  sodium?: SodiumBackend,
): Promise<BackupResult> {
  const backend = sodium ?? (await createNativeSodiumBackend());
  const { bmk, salt } = await loadOrCreateKeyMaterial(backend);

  const kek = deriveKek(backend, password, salt, KDF_PARAMS);
  const createdAt = Date.now();

  const storedWrap = await loadRecoveryWrap();
  const recovery = recoveryKey ?? storedWrap;
  if (!recovery) {
    throw new Error('Backup has not been set up on this device yet.');
  }

  const entries: ArchiveEntry[] = [
    { id: 'db', kind: 'db', bytes: await snapshotDatabase(ctx) },
    ...(await collectDocuments(ctx)),
  ];

  const { bytes, recoveryWrap } = writeArchive(backend, entries, kek, recovery, salt, {
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    kdfParams: KDF_PARAMS,
    bmk,
  });

  // Keep the wrap so the next backup has a recovery path without the key.
  await storeRecoveryWrap(recoveryWrap);

  await ensureDir();
  const path = `${BACKUP_DIR}btbk-v1-${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}.btbk`;

  // Written to a temporary name and renamed, so a backup interrupted midway
  // never leaves a half-file under a name that looks complete.
  const temporary = `${path}.partial`;
  await FileSystem.writeAsStringAsync(temporary, encodeBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });
  await FileSystem.moveAsync({ from: temporary, to: path });

  return { path, bytes: bytes.length, createdAt };
}

export interface RestoreResult {
  readonly createdAt: number;
  readonly merged: Record<string, { inserted: number; updated: number; kept: number }>;
  readonly documents: number;
}

/**
 * Restore an archive into this ledger.
 *
 * The snapshot's rows are merged rather than swapped in, so restoring an older
 * backup onto a newer ledger keeps the newer rows. Documents are written back
 * only where they are missing.
 */
export async function restoreBackup(
  ctx: RepositoryContext,
  archiveBytes: Uint8Array,
  secret: Uint8Array,
  sodium?: SodiumBackend,
): Promise<RestoreResult> {
  const backend = sodium ?? (await createNativeSodiumBackend());
  const { header, entries, bmk } = readArchive(backend, archiveBytes, secret);

  const snapshot = entries.find((entry) => entry.kind === 'db');
  if (!snapshot) {
    throw new Error('This backup contains no ledger.');
  }

  // Open the snapshot as a second database and read its rows out.
  await ensureDir();
  const snapshotPath = `${BACKUP_DIR}restore.db`;
  await FileSystem.writeAsStringAsync(snapshotPath, encodeBase64(snapshot.bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });

  const rows: Record<string, MergeableRow[]> = {};
  const { createExpoDriver } = await import('../db/driver');
  const source = await createExpoDriver('restore.db');

  try {
    for (const table of BACKUP_TABLES) {
      rows[table] = await source.all<MergeableRow>(`SELECT * FROM ${table}`);
    }
  } finally {
    await source.close();
  }

  const merged = await mergeAll(ctx, rows);

  // Documents last: a document without its row is orphaned, a row without its
  // document degrades to a transaction with no photo.
  let documents = 0;
  for (const entry of entries) {
    if (entry.kind !== 'document') continue;

    const path = await documentPathFor(ctx, entry.id);
    if (path === undefined) continue;

    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) continue;

    await FileSystem.writeAsStringAsync(path, encodeBase64(entry.bytes), {
      encoding: FileSystem.EncodingType.Base64,
    });
    documents += 1;
  }

  // Adopt the archive's key material so later backups stay openable with the
  // same secrets as the restored one.
  await adoptKeyMaterial(bmk, base64ToBytes(header.kdf.salt));

  return {
    createdAt: header.createdAt,
    merged,
    documents,
  };
}

async function documentPathFor(
  ctx: RepositoryContext,
  captureId: string,
): Promise<string | undefined> {
  const row = await ctx.driver.get<{ document_path: string | null }>(
    'SELECT document_path FROM captures WHERE capture_id = ?',
    [captureId],
  );
  return row?.document_path ?? undefined;
}

/** Backups on this device, newest first. */
export async function listBackups(): Promise<{ path: string; createdAt: number }[]> {
  await ensureDir();
  const names = await FileSystem.readDirectoryAsync(BACKUP_DIR);

  const found: { path: string; createdAt: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.btbk')) continue;

    const path = `${BACKUP_DIR}${name}`;
    try {
      const base64 = await FileSystem.readAsStringAsync(path, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // The header is readable without any secret, which is the point of
      // keeping it outside the encryption.
      const { header } = readHeader(decodeBase64(base64));
      found.push({ path, createdAt: header.createdAt });
    } catch {
      // A damaged file is skipped rather than breaking the list.
    }
  }

  return found.sort((a, b) => b.createdAt - a.createdAt);
}

export async function readBackupFile(path: string): Promise<Uint8Array> {
  return decodeBase64(
    await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.Base64 }),
  );
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64ToBytes(text: string): Uint8Array {
  return decodeBase64(text);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
