import { describe, expect, it } from 'vitest';
import { DriveConnector } from './drive.js';
import { FakeDrive } from './fake-drive.js';
import type { HttpClient } from './cloud.js';
import { archiveName } from './naming.js';

/**
 * The connector against a server that keeps state and enforces the rules.
 *
 * `drive.test.ts` proves the connector handles the answers we expect; this
 * proves the answers we expect are the ones a server holding real state would
 * give. The difference matters most where the two could drift silently — an
 * offset the client assumed, a chunk boundary off by one — because a backup
 * that uploads "successfully" as a corrupt file is the failure mode with no
 * symptoms until it is needed.
 */

const ORIGIN = 'http://fake-drive.test';

function connect(fake: FakeDrive, chunkBytes = 256 * 1024): DriveConnector {
  const http: HttpClient = (url, request) => {
    const answer = fake.handle({
      method: request.method,
      url,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    });

    const body = answer.body ?? '';

    return Promise.resolve({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: {
        get: (name: string) =>
          Object.entries(answer.headers).find(
            ([key]) => key.toLowerCase() === name.toLowerCase(),
          )?.[1] ?? null,
      },
      text: () => Promise.resolve(typeof body === 'string' ? body : new TextDecoder().decode(body)),
      arrayBuffer: () =>
        Promise.resolve(
          (typeof body === 'string' ? new TextEncoder().encode(body) : body).slice().buffer,
        ),
    });
  };

  return new DriveConnector({
    http,
    token: () => Promise.resolve('token'),
    chunkBytes,
    endpoints: { files: `${ORIGIN}/drive/v3/files`, upload: `${ORIGIN}/upload/drive/v3/files` },
  });
}

/**
 * A cheap content check. Comparing megabyte arrays element by element makes the
 * suite crawl, and a length plus an order-sensitive hash catches a byte that
 * moved just as well.
 */
function digest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return `${String(bytes.length)}:${hash.toString(16)}`;
}

/** Bytes that make an off-by-one visible: every position differs from its neighbours. */
function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + (i >> 8)) % 251;
  return bytes;
}

const NAME = archiveName('01a0', Date.UTC(2026, 7, 30, 18, 49, 41, 726));

describe('the connector against a stateful Drive', () => {
  it('uploads a multi-chunk archive and gets the same bytes back', async () => {
    const fake = new FakeDrive({ origin: ORIGIN });
    const drive = connect(fake);
    const bytes = pattern(700 * 1024);

    const uploaded = await drive.upload(NAME, bytes);
    const returned = await drive.download(uploaded.id);

    expect(uploaded.size).toBe(bytes.length);
    expect(digest(returned)).toBe(digest(bytes));
  });

  it('resumes after the connection dies mid-upload, without losing or repeating a byte', async () => {
    const fake = new FakeDrive({ origin: ORIGIN });
    const drive = connect(fake);
    const bytes = pattern(700 * 1024);

    fake.failNextChunks(1);
    const uploaded = await drive.upload(NAME, bytes);

    expect(digest(await drive.download(uploaded.id))).toBe(digest(bytes));
  });

  it('survives several failures in a row', async () => {
    const fake = new FakeDrive({ origin: ORIGIN });
    const drive = connect(fake);
    const bytes = pattern(300 * 1024);

    fake.failNextChunks(3);

    expect((await drive.upload(NAME, bytes)).size).toBe(bytes.length);
  });

  it('carries on a session started by a process that is gone', async () => {
    // The app was killed after the first chunk. All that survives is the
    // session URI, which is the case resumable uploads exist for.
    const fake = new FakeDrive({ origin: ORIGIN });
    const drive = connect(fake);
    const bytes = pattern(700 * 1024);

    const session = await drive.createSession(NAME, bytes.length);
    fake.failNextChunks(1);

    const uploaded = await drive.resume(session, bytes);

    expect(digest(await drive.download(uploaded.id))).toBe(digest(bytes));
  });

  it('reports progress that ends at the whole file', async () => {
    const fake = new FakeDrive({ origin: ORIGIN });
    const drive = connect(fake);
    const bytes = pattern(700 * 1024);

    const seen: number[] = [];
    await drive.upload(NAME, bytes, (progress) => seen.push(progress.sent));

    expect(seen.at(-1)).toBe(bytes.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('lists what it stored, and deletes it', async () => {
    const fake = new FakeDrive({ origin: ORIGIN });
    const drive = connect(fake);

    const uploaded = await drive.upload(NAME, pattern(1024));
    expect((await drive.list()).map((archive) => archive.name)).toEqual([NAME]);

    await drive.remove(uploaded.id);
    expect(await drive.list()).toEqual([]);
    expect(fake.contents()).toEqual([]);
  });

  it('writes into appDataFolder and nowhere else', async () => {
    // The fake refuses any other parent, so this passing is the assertion.
    const fake = new FakeDrive({ origin: ORIGIN });
    await connect(fake).upload(NAME, pattern(1024));

    expect(fake.contents()).toEqual([{ name: NAME, size: 1024 }]);
  });

  it('accepts a JSON body that arrived as bytes', () => {
    // Over a socket it always does, and reading it as an empty object made the
    // fake reject every real upload with a 400 that looked like the app's fault.
    const fake = new FakeDrive({ origin: ORIGIN });

    const answer = fake.handle({
      method: 'POST',
      url: '/upload/drive/v3/files?uploadType=resumable',
      headers: { Authorization: 'Bearer token', 'X-Upload-Content-Length': '10' },
      body: new TextEncoder().encode(JSON.stringify({ name: NAME, parents: ['appDataFolder'] })),
    });

    expect(answer.status).toBe(200);
    expect(answer.headers['Location']).toContain('/upload/session/');
  });

  it('reads headers whatever case they arrive in', () => {
    // Node lowercases what comes off the wire. Matching on the sender's case
    // made every real upload fail at the first chunk with a 400.
    const fake = new FakeDrive({ origin: ORIGIN });

    const started = fake.handle({
      method: 'POST',
      url: '/upload/drive/v3/files',
      headers: { authorization: 'Bearer token', 'x-upload-content-length': '4' },
      body: JSON.stringify({ name: NAME, parents: ['appDataFolder'] }),
    });

    const session = started.headers['Location'] ?? '';
    const probe = fake.handle({
      method: 'PUT',
      url: session,
      headers: { authorization: 'Bearer token', 'content-range': 'bytes */4' },
    });

    expect(probe.status).toBe(308);
  });

  it('handles a file smaller than one chunk', async () => {
    const fake = new FakeDrive({ origin: ORIGIN });
    const drive = connect(fake);
    const bytes = pattern(17);

    const uploaded = await drive.upload(NAME, bytes);

    expect(digest(await drive.download(uploaded.id))).toBe(digest(bytes));
  });

  it('handles a file that is exactly a chunk boundary', async () => {
    const fake = new FakeDrive({ origin: ORIGIN });
    const drive = connect(fake);
    const bytes = pattern(512 * 1024);

    const uploaded = await drive.upload(NAME, bytes);

    expect(digest(await drive.download(uploaded.id))).toBe(digest(bytes));
  });
});
