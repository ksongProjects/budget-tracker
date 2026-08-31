import { beforeAll, describe, expect, it } from 'vitest';
import type { SodiumBackend } from '@budget/crypto';
import { KDF_PARAMS, deriveKek } from '@budget/crypto';
import { createLibsodiumBackend } from '@budget/crypto/libsodium';
import { readArchive, readHeader } from './archive.js';
import { fromBase64 } from './format.js';
import {
  V1_ARCHIVE_BASE64,
  V1_CREATED_AT,
  V1_EXPECTED_DOCUMENT,
  V1_PASSWORD,
  V1_RECOVERY_KEY,
  V1_SALT,
  V1_SCHEMA_VERSION,
} from './fixtures/v1-archive.js';
import {
  V2_ARCHIVE_BASE64,
  V2_CREATED_AT,
  V2_EXPECTED_DOCUMENT,
  V2_EXPECTED_LEDGER,
  V2_PASSWORD,
  V2_RECOVERY_KEY,
  V2_SALT,
  V2_SCHEMA_VERSION,
} from './fixtures/v2-archive.js';

/**
 * Restore-from-every-prior-format-version.
 *
 * The implementation plan requires this suite and requires that it is never
 * deleted. A user's backups are the only copy of their data: if a format change
 * stops reading an old archive, the data is gone, and nothing else in the test
 * suite would notice.
 *
 * When the format changes, add a frozen fixture for the new version and leave
 * every existing case here untouched.
 */

let sodium: SodiumBackend;

beforeAll(async () => {
  sodium = await createLibsodiumBackend();
});

describe('format v1', () => {
  const bytes = (): Uint8Array => fromBase64(V1_ARCHIVE_BASE64);

  it('still opens with the password it was written with', () => {
    const kek = deriveKek(sodium, V1_PASSWORD, V1_SALT, KDF_PARAMS);
    const restored = readArchive(sodium, bytes(), kek);

    expect(restored.entries).toHaveLength(2);
    expect(new TextDecoder().decode(restored.entries[0]?.bytes)).toContain('frozen ledger');
  });

  it('still opens with its recovery key', () => {
    const restored = readArchive(sodium, bytes(), V1_RECOVERY_KEY);
    expect(new TextDecoder().decode(restored.entries[0]?.bytes)).toContain('frozen ledger');
  });

  it('returns its documents byte for byte', () => {
    const kek = deriveKek(sodium, V1_PASSWORD, V1_SALT, KDF_PARAMS);
    const restored = readArchive(sodium, bytes(), kek);

    const document = restored.entries.find((entry) => entry.kind === 'document');
    expect(document?.bytes).toEqual(V1_EXPECTED_DOCUMENT);
    expect(document?.hash).toBe('sha256:frozen');
  });

  it('reports the metadata a restore screen shows', () => {
    const { header } = readHeader(bytes());

    expect(header.createdAt).toBe(V1_CREATED_AT);
    expect(header.schemaVersion).toBe(V1_SCHEMA_VERSION);
    expect(header.appVersion).toBe('0.1.0');
  });

  it('pins the KDF parameters, since changing them orphans every archive', () => {
    const { header } = readHeader(bytes());

    // If this fails because KDF_PARAMS changed, the change is a breaking one:
    // every existing user backup becomes unopenable with their password.
    expect(header.kdf.algorithm).toBe(KDF_PARAMS.algorithm);
    expect(header.kdf.opsLimit).toBe(KDF_PARAMS.opsLimit);
    expect(header.kdf.memLimitBytes).toBe(KDF_PARAMS.memLimitBytes);
  });
});

describe('format v2', () => {
  const bytes = (): Uint8Array => fromBase64(V2_ARCHIVE_BASE64);

  it('opens with the password it was written with', () => {
    const kek = deriveKek(sodium, V2_PASSWORD, V2_SALT, KDF_PARAMS);
    const restored = readArchive(sodium, bytes(), kek);

    expect(new TextDecoder().decode(restored.entries[0]?.bytes)).toBe(V2_EXPECTED_LEDGER);
  });

  it('opens with its recovery key', () => {
    const restored = readArchive(sodium, bytes(), V2_RECOVERY_KEY);
    expect(new TextDecoder().decode(restored.entries[0]?.bytes)).toBe(V2_EXPECTED_LEDGER);
  });

  it('returns its documents byte for byte', () => {
    const restored = readArchive(sodium, bytes(), V2_RECOVERY_KEY);
    const document = restored.entries.find((entry) => entry.kind === 'document');

    expect(document?.bytes).toEqual(V2_EXPECTED_DOCUMENT);
  });

  it('reports the metadata a restore screen shows', () => {
    const { header, version } = readHeader(bytes());

    expect(version).toBe(2);
    expect(header.createdAt).toBe(V2_CREATED_AT);
    expect(header.schemaVersion).toBe(V2_SCHEMA_VERSION);
  });

  it('pins the KDF parameters, since changing them orphans every archive', () => {
    const { header } = readHeader(bytes());

    expect(header.kdf.algorithm).toBe(KDF_PARAMS.algorithm);
    expect(header.kdf.opsLimit).toBe(KDF_PARAMS.opsLimit);
    expect(header.kdf.memLimitBytes).toBe(KDF_PARAMS.memLimitBytes);
  });

  it('refuses the same archive with one header byte changed', () => {
    // What v2 exists for. The same file, one digit different in its creation
    // time, must not open — and this fixture is the frozen proof that it does
    // not, for every build from here on.
    const tampered = fromBase64(V2_ARCHIVE_BASE64);
    const text = new TextDecoder().decode(tampered);
    const at = text.indexOf('1772000000000');

    expect(at).toBeGreaterThan(0);
    tampered[at + 12] = '1'.charCodeAt(0);

    expect(() => readArchive(sodium, tampered, V2_RECOVERY_KEY)).toThrow(/integrity/i);
  });
});
