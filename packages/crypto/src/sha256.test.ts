import { describe, expect, it } from 'vitest';
import { sha256 } from './sha256.js';
import { toHex } from './vectors.js';

const hash = (text: string): string => toHex(sha256(new TextEncoder().encode(text)));

/**
 * FIPS 180-4 examples and other published values. This hash feeds HKDF, which
 * derives the key that opens every backup — if it is subtly wrong, keys derived
 * on one build never match another, and archives become unopenable.
 */
describe('sha256', () => {
  it('matches the FIPS 180-4 one-block example', () => {
    expect(hash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches the FIPS 180-4 two-block example', () => {
    expect(hash('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes the empty message', () => {
    expect(hash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('handles a message that is exactly one block', () => {
    // 64 bytes: the padding must spill into a second block.
    expect(hash('a'.repeat(64))).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    );
  });

  it('handles a message one byte short of a block', () => {
    // 55 bytes is the largest message whose padding still fits in one block.
    expect(hash('a'.repeat(55))).toBe(
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    );
  });

  it('handles a message that forces an extra padding block', () => {
    // 56 bytes: the length no longer fits, so a whole extra block is added.
    expect(hash('a'.repeat(56))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    );
  });

  it('hashes bytes outside the ASCII range', () => {
    expect(toHex(sha256(Uint8Array.from([0x00, 0xff, 0x80, 0x7f])))).toHaveLength(64);
    // A different message must give a different digest.
    expect(toHex(sha256(Uint8Array.from([0])))).not.toBe(toHex(sha256(Uint8Array.from([1]))));
  });

  it('always returns 32 bytes', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      expect(sha256(new Uint8Array(length))).toHaveLength(32);
    }
  });

  it('is deterministic', () => {
    const message = new TextEncoder().encode('the ledger');
    expect(sha256(message)).toEqual(sha256(message));
  });
});
