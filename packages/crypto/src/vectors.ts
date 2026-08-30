import type { SodiumBackend } from './backend.js';
import { SIZES } from './backend.js';
import { hkdf, hmacSha256 } from './hkdf.js';

/**
 * Behaviour every SodiumBackend must exhibit, as data rather than as a test
 * file — the same shape as `DRIVER_CONTRACT` in @budget/db, and for the same
 * reason: CI runs libsodium-wrappers under Node, React Native runs
 * react-native-libsodium, and a difference between them produces archives one
 * platform cannot open rather than an error anybody notices.
 *
 * Where a published standard exists, the expected values come from the standard
 * (RFC 5869) rather than from our own output. A test that checks an
 * implementation against itself proves only that it is consistent.
 *
 * Free of any test framework and any Node API, so it can run on a device.
 */

export interface CryptoVector {
  readonly name: string;
  run(sodium: SodiumBackend): void;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`crypto vector: ${message}`);
}

function assertBytes(actual: Uint8Array, expectedHex: string, message: string): void {
  const expected = expectedHex.replace(/\s/g, '');
  assert(toHex(actual) === expected, `${message}\n  expected ${expected}\n  actual   ${toHex(actual)}`);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export const CRYPTO_VECTORS: readonly CryptoVector[] = [
  {
    // RFC 5869 appendix A.1.
    name: 'HKDF-SHA256 matches RFC 5869 test case 1',
    run(_sodium) {
      const okm = hkdf(
        fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
        fromHex('000102030405060708090a0b0c'),
        fromHex('f0f1f2f3f4f5f6f7f8f9'),
        42,
      );
      assertBytes(
        okm,
        '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
        'RFC 5869 A.1 output keying material',
      );
    },
  },
  {
    // RFC 5869 appendix A.2: longer inputs, 82 bytes of output.
    name: 'HKDF-SHA256 matches RFC 5869 test case 2',
    run(_sodium) {
      const ikm = fromHex(
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
          '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f' +
          '404142434445464748494a4b4c4d4e4f',
      );
      const salt = fromHex(
        '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f' +
          '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f' +
          'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf',
      );
      const info = fromHex(
        'b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecf' +
          'd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef' +
          'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
      );

      assertBytes(
        hkdf(ikm, salt, info, 82),
        'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c' +
          '59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71' +
          'cc30c58179ec3e87c14c01d5c1f3434f1d87',
        'RFC 5869 A.2 output keying material',
      );
    },
  },
  {
    // RFC 5869 appendix A.3: empty salt and info.
    name: 'HKDF-SHA256 matches RFC 5869 test case 3 (empty salt and info)',
    run(_sodium) {
      assertBytes(
        hkdf(
          fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
          new Uint8Array(0),
          new Uint8Array(0),
          42,
        ),
        '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
        'RFC 5869 A.3 output keying material',
      );
    },
  },
  {
    name: 'HMAC-SHA256 matches RFC 4231 test case 1',
    run(_sodium) {
      assertBytes(
        hmacSha256(
          fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
          new TextEncoder().encode('Hi There'),
        ),
        'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
        'RFC 4231 case 1',
      );
    },
  },
  {
    name: 'AEAD round-trips',
    run(sodium) {
      const key = sodium.randomBytes(SIZES.aeadKey);
      const nonce = sodium.randomBytes(SIZES.aeadNonce);
      const plaintext = new TextEncoder().encode('the ledger');
      const ad = 'header';

      const sealed = sodium.aeadEncrypt(key, nonce, plaintext, ad);
      assert(!equal(sealed, plaintext), 'ciphertext must not equal plaintext');
      assert(
        sealed.length === plaintext.length + SIZES.aeadTag,
        'ciphertext should carry a 16-byte tag',
      );

      const opened = sodium.aeadDecrypt(key, nonce, sealed, ad);
      assert(opened !== null && equal(opened, plaintext), 'round-trip must return the plaintext');
    },
  },
  {
    name: 'AEAD rejects a wrong key',
    run(sodium) {
      const nonce = sodium.randomBytes(SIZES.aeadNonce);
      const sealed = sodium.aeadEncrypt(
        sodium.randomBytes(SIZES.aeadKey),
        nonce,
        new TextEncoder().encode('the ledger'),
        '',
      );

      const opened = sodium.aeadDecrypt(
        sodium.randomBytes(SIZES.aeadKey),
        nonce,
        sealed,
        '',
      );
      assert(opened === null, 'a wrong key must return null, not throw and not succeed');
    },
  },
  {
    name: 'AEAD rejects tampered ciphertext',
    run(sodium) {
      const key = sodium.randomBytes(SIZES.aeadKey);
      const nonce = sodium.randomBytes(SIZES.aeadNonce);
      const sealed = sodium.aeadEncrypt(
        key,
        nonce,
        new TextEncoder().encode('10.60'),
        '',
      );

      // Flip one bit. An archive that opens after this is not tamper-evident.
      const tampered = Uint8Array.from(sealed);
      tampered[0] = (tampered[0] ?? 0) ^ 0x01;

      assert(
        sodium.aeadDecrypt(key, nonce, tampered, '') === null,
        'a flipped bit must fail authentication',
      );
    },
  },
  {
    name: 'AEAD binds its associated data',
    run(sodium) {
      const key = sodium.randomBytes(SIZES.aeadKey);
      const nonce = sodium.randomBytes(SIZES.aeadNonce);
      const sealed = sodium.aeadEncrypt(
        key,
        nonce,
        new TextEncoder().encode('frame 1'),
        'position 1',
      );

      // The archive format binds each frame to its position through the AD, so
      // reordering frames must fail.
      assert(
        sodium.aeadDecrypt(key, nonce, sealed, 'position 2') === null,
        'different associated data must fail authentication',
      );
    },
  },
  {
    name: 'Argon2id is deterministic for the same inputs',
    run(sodium) {
      const salt = new Uint8Array(SIZES.kdfSalt).fill(7);
      const password = new TextEncoder().encode('correct horse battery staple');

      // Cheap parameters: this checks determinism, not cost.
      const first = sodium.argon2id(password, salt, 2, 16 * 1024 * 1024, 32);
      const second = sodium.argon2id(password, salt, 2, 16 * 1024 * 1024, 32);

      assert(equal(first, second), 'same password and salt must give the same key');
    },
  },
  {
    name: 'Argon2id separates different salts',
    run(sodium) {
      const password = new TextEncoder().encode('correct horse battery staple');
      const a = sodium.argon2id(password, new Uint8Array(SIZES.kdfSalt).fill(1), 2, 16 * 1024 * 1024, 32);
      const b = sodium.argon2id(password, new Uint8Array(SIZES.kdfSalt).fill(2), 2, 16 * 1024 * 1024, 32);

      assert(!equal(a, b), 'different salts must give different keys');
    },
  },
  {
    name: 'random bytes are the requested length and not constant',
    run(sodium) {
      const a = sodium.randomBytes(32);
      const b = sodium.randomBytes(32);

      assert(a.length === 32 && b.length === 32, 'wrong length');
      assert(!equal(a, b), 'two random draws must differ');
      assert(!a.every((byte) => byte === 0), 'random bytes must not be all zero');
    },
  },
];
