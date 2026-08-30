import type { SodiumBackend } from '@budget/crypto';
import { SIZES, generateBmk, generateSalt, unwrapBmk, unwrapKey, wrapKey } from '@budget/crypto';
import type { BmkWraps, KdfParams, WrappedKey } from '@budget/crypto';
import {
  ArchiveError,
  ArchiveVersionError,
  FORMAT_VERSION,
  MAGIC,
  MAX_FRAME_BYTES,
  NONCE_PREFIX_BYTES,
  deserializeBmkWraps,
  deserializeWrappedKey,
  fromBase64,
  openFrame,
  sealFrame,
  serializeBmkWraps,
  serializeWrappedKey,
  toBase64,
} from './format.js';
import type { ArchiveHeader } from './format.js';

/**
 * Writing and reading a backup archive.
 *
 * An archive is self-contained: its header carries the KDF parameters and both
 * BMK wraps, so a fresh device with only the file and one secret can restore.
 * Nothing here touches a filesystem — callers stream the bytes wherever they
 * belong, which is what lets the same code run on a phone and in a browser.
 */

export interface ArchiveEntry {
  /** `db` for the database snapshot, or a capture id for a document. */
  readonly id: string;
  readonly kind: 'db' | 'document';
  readonly bytes: Uint8Array;
  /** Present on documents; the file's content hash. */
  readonly hash?: string;
}

export interface ManifestEntry {
  readonly id: string;
  readonly kind: 'db' | 'document';
  readonly byteLength: number;
  readonly hash?: string;
  /** How many frames this entry occupies. */
  readonly frames: number;
}

export interface Manifest {
  readonly entries: readonly ManifestEntry[];
}

export interface WriteOptions {
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly kdfParams: KdfParams;
  /** Supply an existing BMK to keep archives interchangeable across backups. */
  readonly bmk?: Uint8Array;
  /** Override the frame size. Tests use a small value to exercise chunking cheaply. */
  readonly maxFrameBytes?: number;
}

export interface WriteResult {
  readonly bytes: Uint8Array;
  readonly bmk: Uint8Array;
  readonly salt: Uint8Array;
  /** The recovery wrap used, so it can be stored and reused by later backups. */
  readonly recoveryWrap: WrappedKey;
  /** The password wrap used, for the same reason: a backup with nobody present. */
  readonly passwordWrap: WrappedKey;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function chunk(bytes: Uint8Array, limit: number): Uint8Array[] {
  if (bytes.length === 0) return [new Uint8Array(0)];

  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += limit) {
    chunks.push(bytes.subarray(offset, Math.min(offset + limit, bytes.length)));
  }
  return chunks;
}

/**
 * Write an archive.
 *
 * The password KEK and the recovery key both wrap the BMK, so the result opens
 * with either. The archive key is fresh per archive: reusing one across backups
 * would mean a single compromised key opens every backup ever taken.
 *
 * Either side may be given as the secret itself or as a wrap kept from the
 * moment it was known. A wrap is ciphertext — useless without the secret that
 * made it — which is what lets a backup run with nobody present to type a
 * password or read a recovery key off paper.
 */
export function writeArchive(
  sodium: SodiumBackend,
  entries: readonly ArchiveEntry[],
  kek: Uint8Array | WrappedKey,
  recovery: Uint8Array | WrappedKey,
  salt: Uint8Array,
  options: WriteOptions,
): WriteResult {
  const frameLimit = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const bmk = options.bmk ?? generateBmk(sodium);
  const archiveKey = sodium.randomBytes(SIZES.aeadKey);
  const noncePrefix = sodium.randomBytes(NONCE_PREFIX_BYTES);

  // Neither secret is ever stored; the wraps are, and they are ciphertext. That
  // is what lets a later backup still carry both paths without the recovery key
  // living on the device or the password being retyped.
  const wraps: BmkWraps = {
    byPassword: kek instanceof Uint8Array ? wrapKey(sodium, kek, bmk) : kek,
    byRecoveryKey:
      recovery instanceof Uint8Array ? wrapKey(sodium, recovery, bmk) : recovery,
  };
  const akWrap = wrapKey(sodium, bmk, archiveKey);

  const manifest: Manifest = {
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      byteLength: entry.bytes.length,
      ...(entry.hash === undefined ? {} : { hash: entry.hash }),
      frames: chunk(entry.bytes, frameLimit).length,
    })),
  };

  const bodies: Uint8Array[] = [encoder.encode(JSON.stringify(manifest))];
  for (const entry of entries) {
    bodies.push(...chunk(entry.bytes, frameLimit));
  }

  const header: ArchiveHeader = {
    kdf: { ...options.kdfParams, salt: toBase64(salt) },
    bmkWraps: serializeBmkWraps(wraps),
    akWrap: serializeWrappedKey(akWrap),
    noncePrefix: toBase64(noncePrefix),
    createdAt: options.createdAt,
    appVersion: options.appVersion,
    schemaVersion: options.schemaVersion,
  };

  const headerBytes = encoder.encode(JSON.stringify(header));
  const frames = bodies.map((body, index) =>
    sealFrame(sodium, archiveKey, noncePrefix, index, body, index === bodies.length - 1, frameLimit),
  );

  // Truncation is caught by the final flag in each frame's associated data:
  // every frame but the last is sealed as non-final, so a reader that runs out
  // of bytes early treats some frame as final and it fails to authenticate.
  const totalLength =
    MAGIC.length +
    1 +
    4 +
    headerBytes.length +
    frames.reduce((sum, frame) => sum + 4 + frame.ciphertext.length, 0);

  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(MAGIC, offset);
  offset += MAGIC.length;
  out[offset] = FORMAT_VERSION;
  offset += 1;
  view.setUint32(offset, headerBytes.length, false);
  offset += 4;
  out.set(headerBytes, offset);
  offset += headerBytes.length;

  for (const frame of frames) {
    view.setUint32(offset, frame.ciphertext.length, false);
    offset += 4;
    out.set(frame.ciphertext, offset);
    offset += frame.ciphertext.length;
  }

  return {
    bytes: out,
    bmk,
    salt,
    recoveryWrap: wraps.byRecoveryKey,
    passwordWrap: wraps.byPassword,
  };
}

export interface ReadResult {
  readonly header: ArchiveHeader;
  readonly entries: readonly ArchiveEntry[];
  readonly bmk: Uint8Array;
}

/** Parse and validate the header without needing a secret. */
export function readHeader(bytes: Uint8Array): { header: ArchiveHeader; bodyOffset: number } {
  if (bytes.length < MAGIC.length + 5) {
    throw new ArchiveError('not a backup archive: too short');
  }

  for (const [i, byte] of MAGIC.entries()) {
    if (bytes[i] !== byte) throw new ArchiveError('not a backup archive: wrong magic');
  }

  const version = bytes[MAGIC.length] ?? 0;
  if (version > FORMAT_VERSION) throw new ArchiveVersionError(version);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(MAGIC.length + 1, false);
  const headerStart = MAGIC.length + 5;

  if (headerStart + headerLength > bytes.length) {
    throw new ArchiveError('archive is truncated in its header');
  }

  const header = JSON.parse(
    decoder.decode(bytes.subarray(headerStart, headerStart + headerLength)),
  ) as ArchiveHeader;

  return { header, bodyOffset: headerStart + headerLength };
}

/**
 * Read an archive with either secret.
 *
 * Every failure mode returns a distinguishable error rather than a generic one:
 * at restore time the difference between "wrong password" and "this file is
 * damaged" is the difference between trying again and giving up.
 */
export function readArchive(
  sodium: SodiumBackend,
  bytes: Uint8Array,
  secret: Uint8Array,
): ReadResult {
  const { header, bodyOffset } = readHeader(bytes);

  const bmk = unwrapBmk(sodium, deserializeBmkWraps(header.bmkWraps), secret);
  if (!bmk) {
    throw new ArchiveError('That password or recovery key does not open this backup.');
  }

  const archiveKey = unwrapKey(sodium, bmk, deserializeWrappedKey(header.akWrap));
  if (!archiveKey) {
    throw new ArchiveError('The backup header is damaged: its archive key did not unwrap.');
  }

  const noncePrefix = fromBase64(header.noncePrefix);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const bodies: Uint8Array[] = [];
  let offset = bodyOffset;
  let counter = 0;
  let sawFinal = false;

  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new ArchiveError('archive is truncated mid-frame');

    const length = view.getUint32(offset, false);
    offset += 4;
    if (offset + length > bytes.length) throw new ArchiveError('archive is truncated mid-frame');

    const ciphertext = bytes.subarray(offset, offset + length);
    offset += length;

    const isFinal = offset >= bytes.length;
    const body = openFrame(sodium, archiveKey, noncePrefix, counter, ciphertext, isFinal);
    if (!body) {
      throw new ArchiveError(
        `The backup is damaged: frame ${String(counter)} failed its integrity check.`,
      );
    }

    bodies.push(body);
    sawFinal = isFinal;
    counter += 1;
  }

  if (!sawFinal || bodies.length === 0) {
    throw new ArchiveError('The backup is incomplete: it has no final frame.');
  }

  const manifestBody = bodies[0];
  if (!manifestBody) throw new ArchiveError('The backup has no manifest.');

  const manifest = JSON.parse(decoder.decode(manifestBody)) as Manifest;

  const entries: ArchiveEntry[] = [];
  let frameIndex = 1;

  for (const entry of manifest.entries) {
    const parts = bodies.slice(frameIndex, frameIndex + entry.frames);
    if (parts.length !== entry.frames) {
      throw new ArchiveError(`The backup is missing data for ${entry.id}.`);
    }
    frameIndex += entry.frames;

    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }

    if (joined.length !== entry.byteLength) {
      throw new ArchiveError(
        `The backup entry ${entry.id} is the wrong size; it may be damaged.`,
      );
    }

    entries.push({
      id: entry.id,
      kind: entry.kind,
      bytes: joined,
      ...(entry.hash === undefined ? {} : { hash: entry.hash }),
    });
  }

  return { header, entries, bmk };
}

export { ArchiveError, ArchiveVersionError, generateSalt };
