import { CloudError, TransientCloudError } from './cloud.js';
import type {
  CloudConnector,
  HttpClient,
  HttpResponse,
  RemoteArchive,
  UploadProgress,
} from './cloud.js';

/**
 * Google Drive, `appDataFolder` only.
 *
 * Drive stores ciphertext it cannot read, so this is plumbing rather than
 * trust. The scope is the narrowest one that exists for the job — the consent
 * screen saying so is part of the privacy story, not a detail
 * ([drive-connector.md](../../../docs/drive-connector.md)).
 *
 * No DOM, no fetch import, no token handling: the HTTP client and a function
 * that produces an access token are passed in. That is what lets the same file
 * serve the phone and, later, the browser — and lets every path here be tested
 * without a network or an account.
 */

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,name,size,createdTime';

/** Drive requires resumable chunks to be a multiple of 256 KiB. */
const CHUNK_ALIGNMENT = 256 * 1024;
export const DEFAULT_CHUNK_BYTES = 4 * CHUNK_ALIGNMENT;

export interface DriveOptions {
  readonly http: HttpClient;
  /**
   * An access token. Called again with `refresh` when Drive rejects one, so a
   * token that expired mid-upload costs a retry rather than the upload.
   */
  readonly token: (refresh?: boolean) => Promise<string>;
  readonly chunkBytes?: number;
  /** Attempts per chunk before giving up. Interruptions are the normal case, not the exception. */
  readonly maxAttempts?: number;
}

/** A resumable upload in progress. Persist it and an interrupted upload can carry on later. */
export interface UploadSession {
  readonly uri: string;
  readonly name: string;
  readonly total: number;
}

export class DriveConnector implements CloudConnector {
  private readonly chunkBytes: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: DriveOptions) {
    // Aligned up rather than rejected: a caller asking for "about a megabyte"
    // should not have to know Drive's 256 KiB rule, and rounding down could
    // produce a zero-length chunk.
    const requested = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const blocks = Math.max(1, Math.ceil(requested / CHUNK_ALIGNMENT));
    this.chunkBytes = blocks * CHUNK_ALIGNMENT;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  async list(): Promise<RemoteArchive[]> {
    const archives: RemoteArchive[] = [];
    let pageToken: string | undefined;

    do {
      const query = new URLSearchParams({
        spaces: 'appDataFolder',
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: '100',
      });
      if (pageToken !== undefined) query.set('pageToken', pageToken);

      const response = await this.send(`${FILES}?${query.toString()}`, { method: 'GET', headers: {} });
      const body = JSON.parse(await response.text()) as {
        files?: { id: string; name: string; size?: string; createdTime?: string }[];
        nextPageToken?: string;
      };

      for (const file of body.files ?? []) {
        archives.push({
          id: file.id,
          name: file.name,
          size: Number(file.size ?? 0),
          createdAt: file.createdTime === undefined ? 0 : Date.parse(file.createdTime),
        });
      }

      pageToken = body.nextPageToken;
    } while (pageToken !== undefined);

    return archives;
  }

  /**
   * Start a resumable upload.
   *
   * Separate from sending the bytes so a caller can persist the session URI
   * first: an upload interrupted by a dead network or a killed app then resumes
   * instead of starting a multi-megabyte transfer again.
   */
  async createSession(name: string, total: number): Promise<UploadSession> {
    const query = new URLSearchParams({ uploadType: 'resumable', fields: FIELDS });
    const response = await this.send(`${UPLOAD}?${query.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(total),
      },
      body: JSON.stringify({ name, parents: ['appDataFolder'] }),
    });

    const uri = response.headers.get('location');
    if (uri === null || uri === '') {
      throw new CloudError('Drive did not return an upload session.', response.status);
    }

    return { uri, name, total };
  }

  async upload(
    name: string,
    bytes: Uint8Array,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<RemoteArchive> {
    const session = await this.createSession(name, bytes.length);
    return this.resume(session, bytes, onProgress);
  }

  /**
   * Send the bytes, picking up wherever the server says it got to.
   *
   * The offset is always asked for rather than assumed, because the interesting
   * case is the one where our idea of progress is wrong: the app was killed,
   * the radio dropped mid-chunk, the process restarted.
   */
  async resume(
    session: UploadSession,
    bytes: Uint8Array,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<RemoteArchive> {
    let offset = await this.uploadedBytes(session);
    onProgress?.({ sent: offset, total: session.total });

    while (offset < session.total) {
      const end = Math.min(offset + this.chunkBytes, session.total);
      const chunk = bytes.subarray(offset, end);

      const response = await this.sendChunk(session, chunk, offset, end);

      if (response.status === 308) {
        offset = rangeEnd(response) ?? end;
        onProgress?.({ sent: offset, total: session.total });
        continue;
      }

      if (!response.ok) {
        throw new CloudError(`Drive refused the upload (${String(response.status)}).`, response.status);
      }

      onProgress?.({ sent: session.total, total: session.total });
      const file = JSON.parse(await response.text()) as {
        id: string;
        name: string;
        size?: string;
        createdTime?: string;
      };

      const uploaded = Number(file.size ?? 0);
      // Drive reporting a different size than we sent means the archive up there
      // is not the archive down here, and a backup nobody can open is worse than
      // a backup that failed loudly.
      if (uploaded !== session.total) {
        throw new CloudError(
          `Drive stored ${String(uploaded)} bytes of a ${String(session.total)}-byte backup.`,
        );
      }

      return {
        id: file.id,
        name: file.name,
        size: uploaded,
        createdAt: file.createdTime === undefined ? Date.now() : Date.parse(file.createdTime),
      };
    }

    throw new CloudError('The upload finished without Drive confirming the file.');
  }

  /** How much of a session the server already holds. Zero for a fresh one. */
  async uploadedBytes(session: UploadSession): Promise<number> {
    const response = await this.send(session.uri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${String(session.total)}` },
    });

    if (response.status === 308) return rangeEnd(response) ?? 0;
    if (response.ok) return session.total;

    throw new CloudError(
      `Drive lost the upload session (${String(response.status)}).`,
      response.status,
    );
  }

  async download(id: string): Promise<Uint8Array> {
    const response = await this.send(`${FILES}/${encodeURIComponent(id)}?alt=media`, {
      method: 'GET',
      headers: {},
    });

    return new Uint8Array(await response.arrayBuffer());
  }

  async remove(id: string): Promise<void> {
    await this.send(`${FILES}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: {} });
  }

  private async sendChunk(
    session: UploadSession,
    chunk: Uint8Array,
    start: number,
    end: number,
  ): Promise<HttpResponse> {
    return this.attempt(() =>
      this.options.http(session.uri, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${String(start)}-${String(end - 1)}/${String(session.total)}`,
          'Content-Length': String(chunk.length),
        },
        body: chunk,
      }),
    );
  }

  /**
   * One authorised request, retried while the failure looks temporary.
   *
   * A 401 is retried exactly once with a fresh token: more than that means the
   * grant is gone, and hammering an unauthorised endpoint is how an app gets
   * its quota cut.
   */
  private async send(
    url: string,
    request: { method: string; headers: Record<string, string>; body?: string | Uint8Array },
  ): Promise<HttpResponse> {
    let refreshed = false;

    return this.attempt(async () => {
      const token = await this.options.token(refreshed);
      const response = await this.options.http(url, {
        ...request,
        headers: { ...request.headers, Authorization: `Bearer ${token}` },
      });

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        throw new TransientCloudError('The Drive token expired.', 401);
      }

      return response;
    });
  }

  private async attempt(work: () => Promise<HttpResponse>): Promise<HttpResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        const response = await work();
        if (isTransientStatus(response.status)) {
          lastError = new TransientCloudError(
            `Drive is unavailable (${String(response.status)}).`,
            response.status,
          );
          continue;
        }
        return response;
      } catch (cause) {
        // A thrown error from the transport is the offline case: no response at
        // all. That is the one this whole class exists to survive.
        lastError = cause;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new TransientCloudError('Drive could not be reached.');
  }
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Drive answers a resume probe with `Range: bytes=0-<last byte received>`.
 * No header at all means it has nothing yet, which is different from an error.
 */
function rangeEnd(response: HttpResponse): number | undefined {
  const range = response.headers.get('range');
  if (range === null) return undefined;

  const match = /bytes=0-(\d+)/.exec(range);
  if (!match?.[1]) return undefined;

  return Number(match[1]) + 1;
}
