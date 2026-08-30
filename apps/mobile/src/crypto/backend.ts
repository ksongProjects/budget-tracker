import sodium from 'react-native-libsodium';
import type { SodiumBackend } from '@budget/crypto';

/**
 * The sodium backend for React Native.
 *
 * `react-native-libsodium` binds native libsodium, which is what Hermes needs —
 * the WASM build CI uses cannot run here.
 *
 * Two differences from libsodium-wrappers, both found by running
 * `CRYPTO_VECTORS` on a device rather than by reading the types:
 *
 * - AEAD associated data must be a **string**. Passing bytes throws "input type
 *   not yet implemented" at runtime. This is why the archive format's
 *   associated data is an ASCII string.
 * - `crypto_hash_sha256` is not exposed at all, only BLAKE2b. This is why HKDF
 *   uses the TypeScript SHA-256 in @budget/crypto.
 *
 * The five-argument call below is correct: the JS wrapper accepts and ignores
 * the secret-nonce parameter before calling the four-argument native function.
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
