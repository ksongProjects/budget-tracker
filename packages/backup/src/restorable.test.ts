import { describe, expect, it } from 'vitest';
import { ArchiveSchemaError, assertRestorable, isRestorable } from './restorable.js';
import type { ArchiveHeader } from './format.js';

function header(schemaVersion: number): ArchiveHeader {
  return {
    kdf: { salt: '', opsLimit: 1, memLimitBytes: 1, algorithm: 'argon2id' },
    bmkWraps: {
      byPassword: { nonce: '', ciphertext: '' },
      byRecoveryKey: { nonce: '', ciphertext: '' },
    },
    akWrap: { nonce: '', ciphertext: '' },
    noncePrefix: '',
    createdAt: 0,
    appVersion: '1.0.0',
    schemaVersion,
  };
}

describe('restoring across app versions', () => {
  it('allows an archive from the same schema', () => {
    expect(() => {
      assertRestorable(header(7), 7);
    }).not.toThrow();
  });

  it('allows an older archive, which is what a reinstall restores', () => {
    // The normal case: an archive from two versions ago, merged into a ledger
    // whose migrations already ran.
    expect(() => {
      assertRestorable(header(3), 7);
    }).not.toThrow();
  });

  it('refuses a newer archive rather than merging rows it cannot read', () => {
    expect(() => {
      assertRestorable(header(8), 7);
    }).toThrow(ArchiveSchemaError);
  });

  it('tells the user what to do about it', () => {
    // The archive is fine and they have done nothing wrong; the fix is theirs
    // to make and the message has to say which one.
    expect(() => {
      assertRestorable(header(8), 7);
    }).toThrow(/update the app/i);
  });

  it('names both versions, so a support conversation has numbers in it', () => {
    expect(() => {
      assertRestorable(header(9), 4);
    }).toThrow(/9.*4|4.*9/);
  });

  it('answers the same question without throwing, for a screen', () => {
    expect(isRestorable(header(3), 7)).toBe(true);
    expect(isRestorable(header(7), 7)).toBe(true);
    expect(isRestorable(header(8), 7)).toBe(false);
  });
});
