import { beforeAll, describe, expect, it } from 'vitest';
import type { SodiumBackend } from './backend.js';
import { SIZES } from './backend.js';
import { createLibsodiumBackend } from './backends/libsodium.js';
import { CRYPTO_VECTORS } from './vectors.js';
import {
  deriveKek,
  formatRecoveryKey,
  generateBmk,
  generateRecoveryKey,
  generateSalt,
  parseRecoveryKey,
  unwrapBmk,
  unwrapKey,
  wrapBmk,
  wrapKey,
} from './keys.js';

let sodium: SodiumBackend;

beforeAll(async () => {
  sodium = await createLibsodiumBackend();
});

/** Cheap Argon2id parameters. Key handling is under test here, not KDF cost. */
const FAST_KDF = { algorithm: 'argon2id', opsLimit: 2, memLimitBytes: 16 * 1024 * 1024 } as const;

describe('the published vectors', () => {
  it('all pass against libsodium-wrappers', () => {
    for (const vector of CRYPTO_VECTORS) {
      expect(() => {
        vector.run(sodium);
      }, vector.name).not.toThrow();
    }
  });

  it('are not accidentally empty', () => {
    expect(CRYPTO_VECTORS.length).toBeGreaterThan(8);
  });
});

describe('deriveKek', () => {
  it('is deterministic for the same password and salt', () => {
    const salt = generateSalt(sodium);
    const a = deriveKek(sodium, 'hunter2', salt, FAST_KDF);
    const b = deriveKek(sodium, 'hunter2', salt, FAST_KDF);

    expect(a).toEqual(b);
    expect(a).toHaveLength(SIZES.aeadKey);
  });

  it('separates different passwords', () => {
    const salt = generateSalt(sodium);
    expect(deriveKek(sodium, 'hunter2', salt, FAST_KDF)).not.toEqual(
      deriveKek(sodium, 'hunter3', salt, FAST_KDF),
    );
  });

  it('separates different salts, so two users with one password differ', () => {
    expect(deriveKek(sodium, 'hunter2', generateSalt(sodium), FAST_KDF)).not.toEqual(
      deriveKek(sodium, 'hunter2', generateSalt(sodium), FAST_KDF),
    );
  });

  it('refuses a salt of the wrong size rather than deriving a weak key', () => {
    expect(() => deriveKek(sodium, 'hunter2', new Uint8Array(8), FAST_KDF)).toThrow();
  });

  it('handles a unicode password', () => {
    const salt = generateSalt(sodium);
    expect(deriveKek(sodium, '🔑 café', salt, FAST_KDF)).toEqual(
      deriveKek(sodium, '🔑 café', salt, FAST_KDF),
    );
  });
});

describe('key wrapping', () => {
  it('round-trips', () => {
    const wrappingKey = sodium.randomBytes(SIZES.aeadKey);
    const key = generateBmk(sodium);

    expect(unwrapKey(sodium, wrappingKey, wrapKey(sodium, wrappingKey, key))).toEqual(key);
  });

  it('returns null for the wrong key rather than throwing', () => {
    const key = generateBmk(sodium);
    const wrapped = wrapKey(sodium, sodium.randomBytes(SIZES.aeadKey), key);

    expect(unwrapKey(sodium, sodium.randomBytes(SIZES.aeadKey), wrapped)).toBeNull();
  });

  it('uses a fresh nonce every time', () => {
    const wrappingKey = sodium.randomBytes(SIZES.aeadKey);
    const key = generateBmk(sodium);

    const first = wrapKey(sodium, wrappingKey, key);
    const second = wrapKey(sodium, wrappingKey, key);

    expect(first.nonce).not.toEqual(second.nonce);
    // Same key, same wrapping key, different ciphertext: nonce reuse here would
    // leak the relationship between wraps.
    expect(first.ciphertext).not.toEqual(second.ciphertext);
  });

  it('detects a tampered wrap', () => {
    const wrappingKey = sodium.randomBytes(SIZES.aeadKey);
    const wrapped = wrapKey(sodium, wrappingKey, generateBmk(sodium));

    const tampered = { ...wrapped, ciphertext: Uint8Array.from(wrapped.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0x01;

    expect(unwrapKey(sodium, wrappingKey, tampered)).toBeNull();
  });
});

describe('the BMK opens with either secret', () => {
  it('unwraps with the password KEK', () => {
    const salt = generateSalt(sodium);
    const kek = deriveKek(sodium, 'hunter2', salt, FAST_KDF);
    const recoveryKey = generateRecoveryKey(sodium);
    const bmk = generateBmk(sodium);

    expect(unwrapBmk(sodium, wrapBmk(sodium, bmk, kek, recoveryKey), kek)).toEqual(bmk);
  });

  it('unwraps with the recovery key', () => {
    const salt = generateSalt(sodium);
    const kek = deriveKek(sodium, 'hunter2', salt, FAST_KDF);
    const recoveryKey = generateRecoveryKey(sodium);
    const bmk = generateBmk(sodium);

    expect(unwrapBmk(sodium, wrapBmk(sodium, bmk, kek, recoveryKey), recoveryKey)).toEqual(bmk);
  });

  it('returns null when the user has neither secret', () => {
    const salt = generateSalt(sodium);
    const wraps = wrapBmk(
      sodium,
      generateBmk(sodium),
      deriveKek(sodium, 'hunter2', salt, FAST_KDF),
      generateRecoveryKey(sodium),
    );

    expect(unwrapBmk(sodium, wraps, sodium.randomBytes(SIZES.aeadKey))).toBeNull();
  });

  it('still opens an old archive after a password change', () => {
    const bmk = generateBmk(sodium);
    const recoveryKey = generateRecoveryKey(sodium);

    const oldSalt = generateSalt(sodium);
    const oldWraps = wrapBmk(sodium, bmk, deriveKek(sodium, 'old', oldSalt, FAST_KDF), recoveryKey);

    // The password changes; the recovery key does not.
    const newSalt = generateSalt(sodium);
    const newWraps = wrapBmk(sodium, bmk, deriveKek(sodium, 'new', newSalt, FAST_KDF), recoveryKey);

    expect(unwrapBmk(sodium, oldWraps, deriveKek(sodium, 'old', oldSalt, FAST_KDF))).toEqual(bmk);
    expect(unwrapBmk(sodium, newWraps, deriveKek(sodium, 'new', newSalt, FAST_KDF))).toEqual(bmk);
    // And the recovery key opens both, which is what makes it a recovery key.
    expect(unwrapBmk(sodium, oldWraps, recoveryKey)).toEqual(bmk);
    expect(unwrapBmk(sodium, newWraps, recoveryKey)).toEqual(bmk);
  });
});

describe('recovery key rendering', () => {
  it('round-trips through the printed form', () => {
    for (let i = 0; i < 50; i += 1) {
      const key = generateRecoveryKey(sodium);
      expect(parseRecoveryKey(formatRecoveryKey(key))).toEqual(key);
    }
  });

  it('is grouped for transcription', () => {
    const printed = formatRecoveryKey(generateRecoveryKey(sodium));
    expect(printed).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{1,5})+$/);
  });

  it('omits the characters people mis-transcribe', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(formatRecoveryKey(generateRecoveryKey(sodium))).not.toMatch(/[ILOU]/);
    }
  });

  it('forgives the confusions anyway', () => {
    const key = generateRecoveryKey(sodium);
    const printed = formatRecoveryKey(key);

    // Someone reading it off paper writes O for 0 and l for 1.
    const mistyped = printed.replace(/0/g, 'O').replace(/1/g, 'l').toLowerCase();
    expect(parseRecoveryKey(mistyped)).toEqual(key);
  });

  it('forgives spacing and case', () => {
    const key = generateRecoveryKey(sodium);
    const printed = formatRecoveryKey(key);

    expect(parseRecoveryKey(printed.toLowerCase())).toEqual(key);
    expect(parseRecoveryKey(printed.replace(/-/g, ' '))).toEqual(key);
    expect(parseRecoveryKey(printed.replace(/-/g, ''))).toEqual(key);
  });

  it('rejects a key of the wrong length rather than padding it', () => {
    expect(parseRecoveryKey('ABCDE')).toBeNull();
    expect(parseRecoveryKey('')).toBeNull();
  });

  it('rejects characters that are not in the alphabet', () => {
    const printed = formatRecoveryKey(generateRecoveryKey(sodium));
    expect(parseRecoveryKey(`${printed}!`)).toBeNull();
  });
});

describe('generated material', () => {
  it('is the right size and not constant', () => {
    expect(generateBmk(sodium)).toHaveLength(SIZES.masterKey);
    expect(generateRecoveryKey(sodium)).toHaveLength(SIZES.recoveryKey);
    expect(generateSalt(sodium)).toHaveLength(SIZES.kdfSalt);
    expect(generateBmk(sodium)).not.toEqual(generateBmk(sodium));
  });
});
