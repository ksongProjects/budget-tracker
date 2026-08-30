import sodium from 'react-native-libsodium';
import type { SodiumBackend } from '@budget/crypto';

/**
 * The sodium backend for React Native.
 *
 * `react-native-libsodium` mirrors the libsodium-wrappers API against native
 * libsodium, which is what Hermes needs — the WASM build CI uses cannot run
 * here.
 *
 * It notably does **not** expose `crypto_hash_sha256`, which is why HKDF uses
 * the TypeScript SHA-256 in @budget/crypto rather than a backend primitive.
 * Deriving keys differently per platform would make a backup written on a phone
 * unopenable on the web, and nothing would notice until a user tried to
 * restore.
 *
 * Held to `CRYPTO_VECTORS`, run from the diagnostics screen.
 */
export async function createNativeSodiumBackend(): Promise<SodiumBackend> {
  await sodium.ready;

  return {
    name: 'react-native-libsodium',

    randomBytes(length) {
      return sodium.randombytes_buf(length);
    },

    argon2id(password, salt, opsLimit, memLimitBytes, outputLength) {
      return sodium.crypto_pwhash(
        outputLength,
        password,
        salt,
        opsLimit,
        memLimitBytes,
        sodium.crypto_pwhash_ALG_ARGON2ID13,
      );
    },

    aeadEncrypt(key, nonce, plaintext, associatedData) {
      return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        associatedData,
        null,
        nonce,
        key,
      );
    },

    aeadDecrypt(key, nonce, ciphertext, associatedData) {
      try {
        return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          ciphertext,
          associatedData,
          nonce,
          key,
        );
      } catch {
        // A failed tag is an expected outcome — wrong password, damaged
        // archive — not an exceptional one. Callers branch on null.
        return null;
      }
    },
  };
}
