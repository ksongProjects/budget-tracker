import * as Crypto from 'expo-crypto';
// The legacy entry point: SDK 54 introduced a File/Directory API, and the
// package still ships this one. Worth migrating when there is a reason to
// touch this file again; not worth churn today.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { now, uuidv7 } from '@budget/schema';
import type { CaptureId, DeviceId } from '@budget/schema';
import type { SqliteDriver } from '@budget/db';

/**
 * Documents — the photos behind a Capture — are files in app-private storage,
 * not blobs in SQLite. Keeping multi-megabyte images out of the database keeps
 * the snapshot small and the backup archive streamable
 * (docs/backup-format.md).
 *
 * At rest they are protected by OS file encryption and the device lock, which
 * is the guarantee ADR 0011 makes. Our own crypto applies to what leaves.
 */

const DOCUMENTS_DIR = `${FileSystem.documentDirectory ?? ''}documents/`;

/** Long enough for OCR to read a receipt, small enough not to fill the device. */
const MAX_DIMENSION = 2000;
const JPEG_QUALITY = 0.8;

export interface StoredDocument {
  readonly captureId: CaptureId;
  readonly path: string;
  readonly hash: string;
  readonly bytes: number;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DOCUMENTS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DOCUMENTS_DIR, { intermediates: true });
  }
}

/**
 * Downscale, store, hash, and record a photo as a Capture.
 *
 * The capture row is written last and in one statement: a file with no row is
 * recoverable garbage, but a row pointing at a file that was never written is a
 * broken reference the rest of the app has to defend against.
 */
export async function storePhoto(
  driver: SqliteDriver,
  deviceId: DeviceId,
  sourceUri: string,
): Promise<StoredDocument> {
  await ensureDir();

  const captureId = uuidv7() as CaptureId;
  const path = `${DOCUMENTS_DIR}${captureId}.jpg`;

  // Downscaling before storage is the single biggest lever on how much space a
  // year of receipts takes, and OCR gains nothing from a 12-megapixel receipt.
  const context = ImageManipulator.ImageManipulator.manipulate(sourceUri);
  context.resize({ width: MAX_DIMENSION });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({
    compress: JPEG_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });

  await FileSystem.moveAsync({ from: saved.uri, to: path });

  const info = await FileSystem.getInfoAsync(path);
  const bytes = info.exists ? info.size : 0;

  const base64 = await FileSystem.readAsStringAsync(path, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base64);

  const at = now();
  await driver.run(
    `INSERT INTO captures
       (capture_id, kind, captured_at, document_path, document_hash, document_bytes,
        rev, updated_at, origin_device)
     VALUES (?, 'photo', ?, ?, ?, ?, 1, ?, ?)`,
    [captureId, at, path, hash, bytes, at, deviceId],
  );

  return { captureId, path, hash, bytes };
}

export async function documentPath(
  driver: SqliteDriver,
  captureId: CaptureId,
): Promise<string | undefined> {
  const row = await driver.get<{ document_path: string | null }>(
    'SELECT document_path FROM captures WHERE capture_id = ?',
    [captureId],
  );
  return row?.document_path ?? undefined;
}

/**
 * Delete the file behind a capture. The capture row is soft-deleted separately:
 * rows survive for Merge, bytes do not need to.
 */
export async function deleteDocument(path: string): Promise<void> {
  await FileSystem.deleteAsync(path, { idempotent: true });
}
