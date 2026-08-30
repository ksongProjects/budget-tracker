/**
 * The primitives this package needs from libsodium.
 *
 * An interface rather than a direct import, for the reason the SQLite driver is
 * one: CI runs `libsodium-wrappers` under Node, while React Native needs
 * `react-native-libsodium` because WASM does not run under Hermes. Both must
 * behave identically, and the way to know is to run the same vectors through
 * both (see `vectors.ts`) rather than to assume.
 */

export interface SodiumBackend {
  readonly name: string;

  randomBytes(length: number): Uint8Array;

  /**
   * Plain SHA-256. HMAC is built on this rather than taken from the backend,
   * because libsodium's `crypto_auth_hmacsha256` fixes the key at 32 bytes and
   * HKDF needs keys of any length.
   */
  sha256(message: Uint8Array): Uint8Array;

  /**
   * Argon2id with the parameters from docs/crypto-design.md. `opsLimit` and
   * `memLimit` are passed explicitly rather than taken from a named preset,
   * because a preset that changes between library versions changes every
   * derived key.
   */
  argon2id(
    password: Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimitBytes: number,
    outputLength: number,
  ): Uint8Array;

  /** XChaCha20-Poly1305 AEAD. Returns ciphertext with the tag appended. */
  aeadEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    associatedData: Uint8Array,
  ): Uint8Array;

  /** Returns null when authentication fails. Never throws for a bad tag. */
  aeadDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    associatedData: Uint8Array,
  ): Uint8Array | null;
}

export class CryptoError extends Error {
  override readonly name = 'CryptoError';
}

/** Sizes fixed by the algorithms, named so no call site guesses them. */
export const SIZES = {
  aeadKey: 32,
  aeadNonce: 24,
  aeadTag: 16,
  kdfSalt: 16,
  masterKey: 32,
  recoveryKey: 32,
} as const;
