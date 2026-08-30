import { describe, expect, it } from 'vitest';
import { archiveName } from '@budget/backup';
import { challengeFor, isDriveConfigured, randomVerifier, redirectUri } from './auth';
import { createDriveConnector, driveEndpoints } from './drive';

/**
 * The browser's half of the connector, against the same stand-in the phone is
 * driven against.
 *
 * What is actually being checked is this platform's `fetch` adapter: whether a
 * typed-array body survives the trip, whether the resumable session's headers
 * come back readable, whether a multi-chunk upload reassembles. None of that
 * can be established by stubbing the transport, which is the code checking
 * itself.
 */

function bytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + (i >> 8)) % 251;
  return out;
}

function digest(input: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of input) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `${String(input.length)}:${hash.toString(16)}`;
}

const NAME = archiveName('web0', Date.UTC(2026, 7, 30, 18, 49, 41, 726));

describe('the Drive connector in a browser', () => {
  it('is aimed at the stand-in, not at Google', () => {
    expect(driveEndpoints().files).toContain('localhost:8788');
    expect(isDriveConfigured()).toBe(true);
  });

  it('uploads an archive and gets the same bytes back', async () => {
    const drive = createDriveConnector();
    const archive = bytes(700 * 1024);

    const uploaded = await drive.upload(NAME, archive);
    const returned = await drive.download(uploaded.id);

    expect(uploaded.size).toBe(archive.length);
    expect(digest(returned)).toBe(digest(archive));
  });

  it('reports progress that reaches the whole file', async () => {
    const drive = createDriveConnector();
    const archive = bytes(600 * 1024);

    const seen: number[] = [];
    await drive.upload(NAME, archive, (progress) => seen.push(progress.sent));

    expect(seen.at(-1)).toBe(archive.length);
  });

  it('lists what it stored and deletes it again', async () => {
    const drive = createDriveConnector();
    const uploaded = await drive.upload(NAME, bytes(4096));

    expect((await drive.list()).some((archive) => archive.id === uploaded.id)).toBe(true);

    await drive.remove(uploaded.id);
    expect((await drive.list()).some((archive) => archive.id === uploaded.id)).toBe(false);
  });
});

describe('the sign-in flow', () => {
  it('builds a verifier of a legal length and alphabet', () => {
    const verifier = randomVerifier();

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('produces a different verifier each time', () => {
    expect(randomVerifier()).not.toBe(randomVerifier());
  });

  it('challenges with unpadded base64url of the SHA-256, per RFC 7636', async () => {
    // The published example from the RFC, so this checks the spec rather than
    // checking the implementation against itself.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    expect(await challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('redirects back to a path, not to a route inside the app', () => {
    // Google matches the redirect exactly, and a hash route would make it
    // depend on which screen the user happened to be on.
    expect(redirectUri()).not.toContain('#');
    expect(redirectUri().startsWith(location.origin)).toBe(true);
  });
});
