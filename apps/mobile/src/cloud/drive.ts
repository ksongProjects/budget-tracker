import { DriveConnector } from '@budget/backup';
import type { CloudConnector, HttpClient } from '@budget/backup';
import { accessToken } from './auth';
import { driveEndpoints, usingFakeDrive } from './config';

/**
 * The Drive connector, wired to this platform.
 *
 * `@budget/backup` deliberately knows nothing about `fetch` or about where
 * tokens live, so the platform-specific half is this file and it is small.
 */

/**
 * React Native's `fetch` behind the package's narrow HTTP shape.
 *
 * Binary bodies go through as a typed array: React Native's XMLHttpRequest
 * accepts one directly, which matters because the alternative — base64 through
 * a string — would double a three-megabyte archive in memory on a phone.
 */
const http: HttpClient = async (url, request) => {
  // A dead socket that never answers is the case this guards: without it an
  // upload waits forever and the retry logic never gets a chance to run.
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

export function createDriveConnector(): CloudConnector {
  return new DriveConnector({
    http,
    // The stand-in checks that a token was sent, not which one, so a
    // development build can exercise every other part of the path without an
    // account behind it.
    token: usingFakeDrive() ? () => Promise.resolve('development') : accessToken,
    endpoints: driveEndpoints(),
  });
}
