import type { SodiumBackend } from './backend.js';
import { CryptoError, SIZES } from './backend.js';
import { hkdf } from './hkdf.js';

/**
 * The key hierarchy from docs/crypto-design.md.
 *
 * ```
 * password ─ Argon2id ─ HKDF ──→ KEK        (in memory only, never stored)
 * Recovery Key (random 32 B, shown once)
 *
 * BMK  ├─ wrapped by KEK          ─┐ both wraps travel in every archive,
 *      └─ wrapped by Recovery Key ─┘ so an archive opens with either secret
 *
 * AK   └─ wrapped by BMK, fresh per backup
 * ```
 *
 * Losing both the password and the Recovery Key means the backups are
 * unreadable. There is no escrow and no operator who can help, which is the
 * whole point and is why the enable-backup flow says so before it finishes.
 */

export interface KdfParams {
  readonly algorithm: 'argon2id';
  readonly opsLimit: number;
  readonly memLimitBytes: number;
}

/**
 * Argon2id parameters, fixed by docs/crypto-design.md. Changing these changes
 * every derived key, so an archive records the parameters it was written with
 * rather than assuming today's.
 */
export const KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id',
  /** t=3 */
  opsLimit: 3,
  /** m=64 MiB */
  memLimitBytes: 64 * 1024 * 1024,
};

/** HKDF info strings. Distinct labels keep subkeys from ever colliding. */
const INFO_KEK = new TextEncoder().encode('budget-tracker/v1/kek');

export interface WrappedKey {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/** Both wraps of the Backup Master Key, as stored in an archive header. */
export interface BmkWraps {
  readonly byPassword: WrappedKey;
  readonly byRecoveryKey: WrappedKey;
}

/**
 * Stretch a password into a key-encryption key.
 *
 * Deliberately slow — that cost is the whole defence for a password-derived
 * key, and the parameters are pinned rather than taken from a library preset
 * that could shift under us and orphan every existing archive.
 */
export function deriveKek(
  sodium: SodiumBackend,
  password: string,
  salt: Uint8Array,
  params: KdfParams = KDF_PARAMS,
): Uint8Array {
  if (salt.length !== SIZES.kdfSalt) {
    throw new CryptoError(`KDF salt must be ${String(SIZES.kdfSalt)} bytes`);
  }

  const stretched = sodium.argon2id(
    new TextEncoder().encode(password),
    salt,
    params.opsLimit,
    params.memLimitBytes,
    SIZES.masterKey,
  );

  // HKDF after Argon2id so the KEK is domain-separated from anything else ever
  // derived from the same password.
  return hkdf(stretched, salt, INFO_KEK, SIZES.aeadKey);
}

export function generateBmk(sodium: SodiumBackend): Uint8Array {
  return sodium.randomBytes(SIZES.masterKey);
}

export function generateRecoveryKey(sodium: SodiumBackend): Uint8Array {
  return sodium.randomBytes(SIZES.recoveryKey);
}

export function generateSalt(sodium: SodiumBackend): Uint8Array {
  return sodium.randomBytes(SIZES.kdfSalt);
}

/** Wrap a key under another key. The nonce is fresh every time. */
export function wrapKey(
  sodium: SodiumBackend,
  wrappingKey: Uint8Array,
  key: Uint8Array,
  associatedData = '',
): WrappedKey {
  if (wrappingKey.length !== SIZES.aeadKey) {
    throw new CryptoError(`wrapping key must be ${String(SIZES.aeadKey)} bytes`);
  }

  const nonce = sodium.randomBytes(SIZES.aeadNonce);
  return { nonce, ciphertext: sodium.aeadEncrypt(wrappingKey, nonce, key, associatedData) };
}

/** Unwrap a key, or null when the wrapping key is wrong or the wrap was tampered with. */
export function unwrapKey(
  sodium: SodiumBackend,
  wrappingKey: Uint8Array,
  wrapped: WrappedKey,
  associatedData = '',
): Uint8Array | null {
  if (wrappingKey.length !== SIZES.aeadKey) return null;
  return sodium.aeadDecrypt(wrappingKey, wrapped.nonce, wrapped.ciphertext, associatedData);
}

/**
 * Wrap the BMK under both secrets. Both wraps go in every archive, so a
 * password change does not orphan older archives and the Recovery Key always
 * works.
 */
export function wrapBmk(
  sodium: SodiumBackend,
  bmk: Uint8Array,
  kek: Uint8Array,
  recoveryKey: Uint8Array,
): BmkWraps {
  return {
    byPassword: wrapKey(sodium, kek, bmk),
    byRecoveryKey: wrapKey(sodium, recoveryKey, bmk),
  };
}

/**
 * Recover the BMK from whichever secret the user has.
 *
 * Tries both wraps rather than requiring the caller to know which secret it
 * holds: at restore time the user has one or the other, and telling them
 * "wrong password" when they typed a recovery key would be unhelpful.
 */
export function unwrapBmk(
  sodium: SodiumBackend,
  wraps: BmkWraps,
  secret: Uint8Array,
): Uint8Array | null {
  return (
    unwrapKey(sodium, secret, wraps.byPassword) ??
    unwrapKey(sodium, secret, wraps.byRecoveryKey)
  );
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';

/**
 * Render a Recovery Key for a human to write down or photograph.
 *
 * Crockford-style Base32 without I, L, O, or U: those are the characters people
 * mis-transcribe, and a key that cannot be typed back in is not a recovery
 * mechanism. Grouped in fives for the same reason.
 */
export function formatRecoveryKey(key: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += RECOVERY_ALPHABET[(value << (5 - bits)) & 31] ?? '';
  }

  return (out.match(/.{1,5}/g) ?? []).join('-');
}

/** Parse a Recovery Key back, tolerating case, spacing, and the usual confusions. */
export function parseRecoveryKey(text: string): Uint8Array | null {
  const normalized = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    // The characters the alphabet omits, mapped to what the user meant.
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of normalized) {
    const index = RECOVERY_ALPHABET.indexOf(character);
    if (index === -1) return null;

    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return bytes.length === SIZES.recoveryKey ? Uint8Array.from(bytes) : null;
}
