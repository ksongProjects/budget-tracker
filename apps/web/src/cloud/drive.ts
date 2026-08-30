import { DriveConnector, GOOGLE_DRIVE } from '@budget/backup';
import type { CloudConnector, DriveEndpoints, HttpClient } from '@budget/backup';
import { accessToken, usingFakeDrive } from './auth';

/**
 * The Drive connector, wired to the browser.
 *
 * `@budget/backup` knows nothing about `fetch` or about where tokens live, so
 * the platform half is this file and the phone's equivalent — which is the
 * point. The resumable upload, the retry rules and the size check are the same
 * code on both, tested once.
 */

const http: HttpClient = async (url, request) => {
  const controller = new AbortController();
  const timer =
    request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort();
        }, request.timeoutMs);

  try {
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      signal: controller.signal,
      ...(request.body === undefined ? {} : { body: request.body as BodyInit }),
    });

    return {
      status: response.status,
      ok: response.ok,
      headers: { get: (name: string) => response.headers.get(name) },
      text: () => response.text(),
      arrayBuffer: () => response.arrayBuffer(),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Where Drive lives for this build.
 *
 * A development build can be pointed at `tools/fake-drive.mjs`, which speaks
 * the same protocol into memory — that is how the upload path gets exercised in
 * a browser with no Google account attached. Guarded by `import.meta.env.DEV`
 * as well as the variable, so a production build cannot be talked into sending
 * backups elsewhere by an environment it inherited.
 */
export function driveEndpoints(): DriveEndpoints {
  const origin = fakeDriveOrigin();
  if (origin === undefined) return GOOGLE_DRIVE;

  return {
    files: `${origin}/drive/v3/files`,
    upload: `${origin}/upload/drive/v3/files`,
  };
}

export function fakeDriveOrigin(): string | undefined {
  if (!import.meta.env.DEV) return undefined;

  const configured: unknown = import.meta.env['VITE_FAKE_DRIVE_URL'];
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined;
}

export function createDriveConnector(): CloudConnector {
  return new DriveConnector({
    http,
    // The stand-in checks that a token was sent, not which one, so a
    // development build exercises everything else without an account behind it.
    token: usingFakeDrive() ? () => Promise.resolve('development') : accessToken,
    endpoints: driveEndpoints(),
  });
}
