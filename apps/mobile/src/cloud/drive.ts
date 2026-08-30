import { DriveConnector } from '@budget/backup';
import type { CloudConnector, HttpClient } from '@budget/backup';
import { accessToken } from './auth';

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
  const response = await fetch(url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body as BodyInit }),
  });

  return {
    status: response.status,
    ok: response.ok,
    headers: { get: (name: string) => response.headers.get(name) },
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
  };
};

export function createDriveConnector(): CloudConnector {
  return new DriveConnector({ http, token: accessToken });
}
