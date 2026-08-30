import sodium from 'libsodium-wrappers-sumo';
import type { SodiumBackend } from '../backend.js';
import { CryptoError } from '../backend.js';

/**
 * libsodium-wrappers backend, for Node and the browser.
 *
 * React Native uses `react-native-libsodium` instead, since WASM does not run
 * under Hermes. Both are held to `CRYPTO_VECTORS`.
 */
export async function createLibsodiumBackend(): Promise<SodiumBackend> {
  await sodium.ready;

  return {
    name: 'libsodium-wrappers',

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
        // A failed tag is an expected outcome — wrong password, tampered
        // archive — not an exceptional one. Callers branch on null.
        return null;
      }
    },
  };
}

export async function requireLibsodium(): Promise<SodiumBackend> {
  try {
    return await createLibsodiumBackend();
  } catch (error) {
    throw new CryptoError(
      `libsodium failed to initialise: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
