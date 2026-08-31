import type { BmkWraps, KdfParams, SodiumBackend, WrappedKey } from '@budget/crypto';
import { SIZES } from '@budget/crypto';

/**
 * The archive format from docs/backup-format.md.
 *
 * ```
 * [ magic "BTBK" | version u8 | header_len u32 ]
 * [ header (plaintext CBOR-ish JSON): kdf, bmk_wraps, ak_wrap, nonce_prefix, … ]
 * [ frame 0 | frame 1 | … | final frame ]
 * ```
 *
 * Each frame is sealed with the archive key and bound to its own position
 * through both the nonce and the associated data, so truncation, reordering,
 * and splicing are all detected rather than silently producing a shorter
 * ledger.
 */

export const MAGIC = new Uint8Array([0x42, 0x54, 0x42, 0x4b]); // "BTBK"
export const FORMAT_VERSION = 2;

/**
 * The last version whose frames were sealed without the header bound in.
 *
 * Archives written before header authentication still open — a backup a user
 * made a year ago is the one they need most — so the reader keeps producing
 * v1's associated data for v1 files, and only v1 files.
 */
export const UNAUTHENTICATED_HEADER_VERSION = 1;

/** Frames are capped so a reader never has to hold a whole archive in memory. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class ArchiveError extends Error {
  override readonly name = 'ArchiveError';
}

/** Thrown when the archive is newer than this build understands. */
export class ArchiveVersionError extends ArchiveError {
  constructor(readonly version: number) {
    super(
      `This backup was written by a newer version of the app (format ${String(version)}). Update the app to open it.`,
    );
  }
}

export interface ArchiveHeader {
  readonly kdf: KdfParams & { readonly salt: string };
  readonly bmkWraps: SerializedBmkWraps;
  readonly akWrap: SerializedWrappedKey;
  /** Base64. Combined with the frame counter to form each frame's nonce. */
  readonly noncePrefix: string;
  readonly createdAt: number;
  readonly appVersion: string;
  readonly schemaVersion: number;
}

export interface SerializedWrappedKey {
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface SerializedBmkWraps {
  readonly byPassword: SerializedWrappedKey;
  readonly byRecoveryKey: SerializedWrappedKey;
}

/** The nonce prefix leaves 8 bytes of the 24-byte nonce for the frame counter. */
export const NONCE_PREFIX_BYTES = SIZES.aeadNonce - 8;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function serializeWrappedKey(key: WrappedKey): SerializedWrappedKey {
  return { nonce: toBase64(key.nonce), ciphertext: toBase64(key.ciphertext) };
}

export function deserializeWrappedKey(key: SerializedWrappedKey): WrappedKey {
  return { nonce: fromBase64(key.nonce), ciphertext: fromBase64(key.ciphertext) };
}

export function serializeBmkWraps(wraps: BmkWraps): SerializedBmkWraps {
  return {
    byPassword: serializeWrappedKey(wraps.byPassword),
    byRecoveryKey: serializeWrappedKey(wraps.byRecoveryKey),
  };
}

export function deserializeBmkWraps(wraps: SerializedBmkWraps): BmkWraps {
  return {
    byPassword: deserializeWrappedKey(wraps.byPassword),
    byRecoveryKey: deserializeWrappedKey(wraps.byRecoveryKey),
  };
}

/**
 * The nonce for one frame: the archive's random prefix followed by the frame
 * counter.
 *
 * The counter appears here *and* in the associated data. In the nonce it
 * guarantees no two frames in an archive share a nonce; in the AD it binds the
 * frame to its position, so a reader that is handed frame 7 where frame 3
 * belongs fails to authenticate rather than accepting it.
 */
export function frameNonce(prefix: Uint8Array, counter: number): Uint8Array {
  if (prefix.length !== NONCE_PREFIX_BYTES) {
    throw new ArchiveError(`nonce prefix must be ${String(NONCE_PREFIX_BYTES)} bytes`);
  }

  const nonce = new Uint8Array(SIZES.aeadNonce);
  nonce.set(prefix, 0);

  const view = new DataView(nonce.buffer, nonce.byteOffset + NONCE_PREFIX_BYTES, 8);
  view.setBigUint64(0, BigInt(counter), false);

  return nonce;
}

/**
 * The associated data binding a frame to its archive and position.
 *
 * Includes the format version so an archive cannot be downgraded by rewriting
 * its version byte, and the final flag so the last frame cannot be passed off
 * as a middle one — which is how truncation would otherwise go unnoticed.
 *
 * Since v2 it also carries the header, verbatim. Without that the header was
 * the one part of an archive nobody had signed: its salt, its creation time and
 * its schema version could all be edited in place and every frame would still
 * authenticate. A device found this — a flipped header byte produced not a
 * clear refusal but a raw SQLite error from deep inside a restore, because the
 * archive had "opened" fine. The bytes are passed exactly as they were read
 * rather than re-serialised, because JSON key order is not guaranteed and a
 * reordered header would fail to authenticate an archive that is perfectly
 * good.
 *
 * A plain ASCII string rather than packed bytes: react-native-libsodium accepts
 * only a string as associated data, and both libraries encode it as UTF-8, so
 * this is the one representation that means the same thing on every platform.
 * Packed bytes appeared to work until they were run on a device.
 */
export function frameAssociatedData(
  counter: number,
  isFinal: boolean,
  header?: string,
  version: number = FORMAT_VERSION,
): string {
  const base = `BTBK/${String(version)}/${String(counter)}/${isFinal ? 'final' : 'mid'}`;
  return header === undefined ? base : `${base}/${header}`;
}

export interface SealedFrame {
  readonly counter: number;
  readonly isFinal: boolean;
  readonly ciphertext: Uint8Array;
}

export function sealFrame(
  sodium: SodiumBackend,
  archiveKey: Uint8Array,
  noncePrefix: Uint8Array,
  counter: number,
  body: Uint8Array,
  isFinal: boolean,
  maxFrameBytes: number = MAX_FRAME_BYTES,
  header?: string,
): SealedFrame {
  if (body.length > maxFrameBytes) {
    throw new ArchiveError(`frame body exceeds ${String(maxFrameBytes)} bytes`);
  }

  return {
    counter,
    isFinal,
    ciphertext: sodium.aeadEncrypt(
      archiveKey,
      frameNonce(noncePrefix, counter),
      body,
      frameAssociatedData(counter, isFinal, header),
    ),
  };
}

/** Open a frame, or null if it does not authenticate at this position. */
export function openFrame(
  sodium: SodiumBackend,
  archiveKey: Uint8Array,
  noncePrefix: Uint8Array,
  counter: number,
  ciphertext: Uint8Array,
  isFinal: boolean,
  header?: string,
  version: number = FORMAT_VERSION,
): Uint8Array | null {
  return sodium.aeadDecrypt(
    archiveKey,
    frameNonce(noncePrefix, counter),
    ciphertext,
    frameAssociatedData(counter, isFinal, header, version),
  );
}
