import { describe, expect, it } from 'vitest';
import { DriveConnector } from './drive.js';
import type { HttpClient, HttpRequest, HttpResponse } from './cloud.js';
import { CloudError } from './cloud.js';

/**
 * Drive without Drive.
 *
 * The interesting paths here are the ones an account and a good network would
 * never show: a session dropped mid-upload, a token that expires between
 * chunks, a server that returns fewer bytes than were sent. Those get written
 * as fixtures, not hoped for.
 */

interface Call {
  readonly url: string;
  readonly request: HttpRequest;
}

function reply(
  status: number,
  body = '',
  headers: Record<string, string> = {},
): HttpResponse {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
  };
}

const SESSION = 'https://upload.example/session-1';

function fileJson(size: number, id = 'file-1', name = 'archive.btbk'): string {
  return JSON.stringify({
    id,
    name,
    size: String(size),
    createdTime: '2026-08-30T18:49:41.726Z',
  });
}

/** A transport driven by a queue of canned answers, recording what it was asked. */
function transport(answers: (HttpResponse | Error)[]): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];

  const http: HttpClient = (url, request) => {
    calls.push({ url, request });
    const next = answers.shift();
    if (next === undefined) throw new Error(`no canned answer for ${request.method} ${url}`);
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };

  return { http, calls };
}

const token = () => Promise.resolve('token-1');

describe('listing', () => {
  it('reads names, sizes and dates out of appDataFolder', async () => {
    const { http, calls } = transport([
      reply(
        200,
        JSON.stringify({
          files: [
            { id: 'a', name: 'btbk-v1-01a0-2026-08-30T18-49-41-726Z.btbk', size: '2941682', createdTime: '2026-08-30T18:49:41.726Z' },
          ],
        }),
      ),
    ]);

    const archives = await new DriveConnector({ http, token }).list();

    expect(archives).toEqual([
      {
        id: 'a',
        name: 'btbk-v1-01a0-2026-08-30T18-49-41-726Z.btbk',
        size: 2941682,
        createdAt: Date.parse('2026-08-30T18:49:41.726Z'),
      },
    ]);
    expect(calls[0]?.url).toContain('spaces=appDataFolder');
  });

  it('follows pagination rather than reporting the first page as everything', async () => {
    const { http } = transport([
      reply(200, JSON.stringify({ files: [{ id: 'a', name: 'a.btbk' }], nextPageToken: 'p2' })),
      reply(200, JSON.stringify({ files: [{ id: 'b', name: 'b.btbk' }] })),
    ]);

    const archives = await new DriveConnector({ http, token }).list();

    expect(archives.map((archive) => archive.id)).toEqual(['a', 'b']);
  });
});

describe('upload', () => {
  const bytes = new Uint8Array(600 * 1024).fill(7);
  const chunkBytes = 256 * 1024;

  it('sends the file in aligned chunks and confirms the stored size', async () => {
    const { http, calls } = transport([
      reply(200, '', { Location: SESSION }),
      reply(308), // resume probe: nothing yet
      reply(308, '', { Range: 'bytes=0-262143' }),
      reply(308, '', { Range: 'bytes=0-524287' }),
      reply(200, fileJson(bytes.length)),
    ]);

    const seen: number[] = [];
    const archive = await new DriveConnector({ http, token, chunkBytes }).upload(
      'archive.btbk',
      bytes,
      (progress) => seen.push(progress.sent),
    );

    expect(archive.size).toBe(bytes.length);
    expect(seen.at(-1)).toBe(bytes.length);

    const ranges = calls
      .map((call) => call.request.headers['Content-Range'])
      .filter((range): range is string => range !== undefined);

    expect(ranges).toEqual([
      'bytes */614400',
      'bytes 0-262143/614400',
      'bytes 262144-524287/614400',
      'bytes 524288-614399/614400',
    ]);
  });

  it('picks up from what the server already holds', async () => {
    // The app was killed after one chunk. Nothing local remembers that; the
    // session does, and it is the only account of it that can be trusted.
    const { http, calls } = transport([
      reply(308, '', { Range: 'bytes=0-262143' }),
      reply(308, '', { Range: 'bytes=0-524287' }),
      reply(200, fileJson(bytes.length)),
    ]);

    const drive = new DriveConnector({ http, token, chunkBytes });
    await drive.resume({ uri: SESSION, name: 'archive.btbk', total: bytes.length }, bytes);

    expect(calls[1]?.request.headers['Content-Range']).toBe('bytes 262144-524287/614400');
  });

  it('survives the network dropping mid-upload', async () => {
    const { http } = transport([
      reply(200, '', { Location: SESSION }),
      reply(308),
      new Error('Network request failed'),
      reply(308, '', { Range: 'bytes=0-262143' }),
      reply(308, '', { Range: 'bytes=0-524287' }),
      reply(200, fileJson(bytes.length)),
    ]);

    const archive = await new DriveConnector({ http, token, chunkBytes }).upload('archive.btbk', bytes);

    expect(archive.id).toBe('file-1');
  });

  it('retries a chunk while Drive is unavailable', async () => {
    const { http } = transport([
      reply(200, '', { Location: SESSION }),
      reply(308),
      reply(503),
      reply(308, '', { Range: 'bytes=0-262143' }),
      reply(308, '', { Range: 'bytes=0-524287' }),
      reply(200, fileJson(bytes.length)),
    ]);

    const archive = await new DriveConnector({ http, token, chunkBytes }).upload('archive.btbk', bytes);

    expect(archive.size).toBe(bytes.length);
  });

  it('asks for a fresh token when one expires mid-upload', async () => {
    const asked: (boolean | undefined)[] = [];
    const { http } = transport([
      reply(401),
      reply(200, '', { Location: SESSION }),
      reply(308),
      reply(308, '', { Range: 'bytes=0-262143' }),
      reply(308, '', { Range: 'bytes=0-524287' }),
      reply(200, fileJson(bytes.length)),
    ]);

    await new DriveConnector({
      http,
      chunkBytes,
      token: (refresh) => {
        asked.push(refresh);
        return Promise.resolve('token-1');
      },
    }).upload('archive.btbk', bytes);

    expect(asked[0]).toBe(false);
    expect(asked[1]).toBe(true);
  });

  it('fails loudly when Drive stored a different number of bytes', async () => {
    // A backup that cannot be opened is worse than one that never happened, and
    // a truncated archive looks exactly like a good one in a file listing.
    const { http } = transport([
      reply(200, '', { Location: SESSION }),
      reply(308),
      reply(308, '', { Range: 'bytes=0-262143' }),
      reply(308, '', { Range: 'bytes=0-524287' }),
      reply(200, fileJson(bytes.length - 10)),
    ]);

    await expect(
      new DriveConnector({ http, token, chunkBytes }).upload('archive.btbk', bytes),
    ).rejects.toThrow(/stored 614390 bytes of a 614400-byte backup/);
  });

  it('gives up rather than looping forever on a dead session', async () => {
    const { http } = transport([reply(200, '', { Location: SESSION }), reply(404)]);

    await expect(
      new DriveConnector({ http, token, chunkBytes }).upload('archive.btbk', bytes),
    ).rejects.toBeInstanceOf(CloudError);
  });

  it('refuses to start without a session URI', async () => {
    const { http } = transport([reply(200)]);

    await expect(
      new DriveConnector({ http, token }).upload('archive.btbk', bytes),
    ).rejects.toThrow(/did not return an upload session/);
  });

  it('rounds an unaligned chunk size to what Drive accepts', async () => {
    const { http, calls } = transport([
      reply(200, '', { Location: SESSION }),
      reply(308),
      reply(200, fileJson(bytes.length)),
    ]);

    await new DriveConnector({ http, token, chunkBytes: 1000 }).upload('archive.btbk', bytes);

    // 1000 bytes is not a legal chunk; the smallest legal one is 256 KiB.
    expect(calls[2]?.request.headers['Content-Range']).toBe('bytes 0-262143/614400');
  });
});

describe('download and delete', () => {
  it('fetches the file content', async () => {
    const { http, calls } = transport([reply(200, 'ciphertext')]);

    const bytes = await new DriveConnector({ http, token }).download('file-1');

    expect(new TextDecoder().decode(bytes)).toBe('ciphertext');
    expect(calls[0]?.url).toContain('alt=media');
  });

  it('deletes by id', async () => {
    const { http, calls } = transport([reply(204)]);

    await new DriveConnector({ http, token }).remove('file-1');

    expect(calls[0]?.request.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('file-1');
  });
});
