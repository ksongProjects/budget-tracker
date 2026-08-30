import { sha256 } from './sha256.js';

/**
 * HKDF-SHA256 (RFC 5869), the subkey derivation in docs/crypto-design.md.
 *
 * libsodium's own KDF is BLAKE2b-based, not HKDF, so this is written out. The
 * design names HKDF-SHA256 specifically, and RFC 5869 publishes test vectors —
 * an implementation nobody can check against a standard is one nobody can
 * check.
 *
 * Uses the TypeScript SHA-256 rather than a backend primitive, because
 * react-native-libsodium does not expose crypto_hash_sha256 and deriving keys
 * differently per platform would make archives written on a phone unopenable
 * on the web.
 */

const HASH_LENGTH = 32;
const BLOCK_LENGTH = 64;

/**
 * HMAC-SHA256 (RFC 2104), built on plain SHA-256 so the key may be any length.
 * libsodium's own HMAC fixes the key at 32 bytes, which HKDF cannot use: the
 * salt is the key during extract, and a salt is whatever length it is.
 */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(BLOCK_LENGTH);
  block.set(key.length > BLOCK_LENGTH ? sha256(key) : key);

  const inner = new Uint8Array(BLOCK_LENGTH + message.length);
  const outer = new Uint8Array(BLOCK_LENGTH + HASH_LENGTH);

  for (let i = 0; i < BLOCK_LENGTH; i += 1) {
    const byte = block[i] ?? 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }

  inner.set(message, BLOCK_LENGTH);
  outer.set(sha256(inner), BLOCK_LENGTH);

  return sha256(outer);
}

/**
 * Extract a pseudorandom key from input keying material.
 *
 * The salt is the HMAC key here, not the message: that is the RFC's
 * construction and reversing it silently weakens the result.
 */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  const key = salt.length === 0 ? new Uint8Array(HASH_LENGTH) : salt;
  return hmacSha256(key, ikm);
}

/** Expand a pseudorandom key into `length` bytes bound to `info`. */
export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  if (length < 0 || length > 255 * HASH_LENGTH) {
    throw new RangeError(`HKDF cannot produce ${String(length)} bytes`);
  }

  const output = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array(0);
  let offset = 0;

  for (let counter = 1; offset < length; counter += 1) {
    const input = new Uint8Array(previous.length + info.length + 1);
    input.set(previous, 0);
    input.set(info, previous.length);
    input[previous.length + info.length] = counter;

    previous = hmacSha256(prk, input);
    const take = Math.min(previous.length, length - offset);
    output.set(previous.subarray(0, take), offset);
    offset += take;
  }

  return output;
}

/** Extract-then-expand, the whole of RFC 5869. */
export function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return hkdfExpand(hkdfExtract(salt, ikm), info, length);
}
