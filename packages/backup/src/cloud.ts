/**
 * The boundary a cloud transport sits behind.
 *
 * Drive is the first one and, for the MVP, the only one — but the shape is
 * deliberately the small set of things you can do to opaque files, so Dropbox
 * or WebDAV can be added later without any of them learning more about the data
 * than Drive does ([drive-connector.md](../../../docs/drive-connector.md)).
 *
 * A connector never sees plaintext. It moves sealed archives and reads their
 * names. That is the whole contract.
 */

export interface RemoteArchive {
  /** The connector's own handle for the file. */
  readonly id: string;
  readonly name: string;
  readonly size: number;
  /** What the remote says, which both devices can agree on; may differ from the name. */
  readonly createdAt: number;
}

export interface UploadProgress {
  readonly sent: number;
  readonly total: number;
}

export interface CloudConnector {
  list(): Promise<RemoteArchive[]>;
  upload(
    name: string,
    bytes: Uint8Array,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<RemoteArchive>;
  download(id: string): Promise<Uint8Array>;
  remove(id: string): Promise<void>;
}

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

/** Thrown when the transport failed in a way that retrying could fix. */
export class TransientCloudError extends CloudError {
  constructor(
    message: string,
    status?: number,
  ) {
    super(message, status);
    this.name = 'TransientCloudError';
  }
}

/**
 * The slice of `fetch` this package uses.
 *
 * Declared rather than imported: these packages compile without DOM types on
 * purpose, so the same code runs on Hermes, in a browser, and in a test with a
 * hand-written function standing in for the network.
 */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpRequest {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Uint8Array;
  /**
   * How long to wait before abandoning the request.
   *
   * A connection that dies without answering is not a failure the retry logic
   * can see — nothing rejects, so an upload waits forever behind a spinner that
   * never moves. Adapters should honour this; the connector also enforces it,
   * because one that does not would hang the app.
   */
  readonly timeoutMs?: number;
}

export type HttpClient = (url: string, request: HttpRequest) => Promise<HttpResponse>;
