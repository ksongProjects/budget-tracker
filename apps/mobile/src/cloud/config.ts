import { GOOGLE_DRIVE } from '@budget/backup';
import type { DriveEndpoints } from '@budget/backup';

/**
 * Where the connector points, and whether it needs a Google account to do it.
 *
 * A development build can be aimed at `tools/fake-drive.mjs`, which speaks the
 * same protocol into memory. That is what makes the upload path testable on a
 * real device — a three-megabyte archive through React Native's fetch, chunked,
 * interrupted, resumed — with no client id and nothing leaving the machine.
 *
 * Guarded by `__DEV__` as well as the variable, so a release build cannot be
 * talked into sending backups somewhere else by an environment it inherited.
 */

export function fakeDriveOrigin(): string | undefined {
  if (!__DEV__) return undefined;

  const configured: unknown = process.env.EXPO_PUBLIC_FAKE_DRIVE_URL;
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined;
}

export function driveEndpoints(): DriveEndpoints {
  const origin = fakeDriveOrigin();
  if (origin === undefined) return GOOGLE_DRIVE;

  return {
    files: `${origin}/drive/v3/files`,
    upload: `${origin}/upload/drive/v3/files`,
  };
}

/** True when the connector can run without a signed-in Google account. */
export function usingFakeDrive(): boolean {
  return fakeDriveOrigin() !== undefined;
}
