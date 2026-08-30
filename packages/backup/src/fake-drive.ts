import { archiveName } from './naming.js';

/**
 * Drive's resumable-upload protocol, in memory.
 *
 * This exists because the connector's hard parts — chunk alignment, resuming
 * from what the server holds, a session that outlives a dropped socket — are
 * agreements with a server, and a test that stubs the server's answers only
 * proves we agree with ourselves. Here the answers come from something that
 * keeps state and enforces the rules, so a wrong assumption shows up as a
 * failure rather than as a fixture nobody questioned.
 *
 * It is also what lets the phone exercise the real upload path with no Google
 * account: `tools/fake-drive.mjs` puts it behind a socket.
 *
 * It is a test double, not an emulator. It implements what the connector uses.
 */

export interface FakeRequest {
  readonly method: string;
  /** Path and query, or a full URL — both are accepted so callers need not care. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
}

export interface FakeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
}

interface StoredFile {
  readonly id: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly createdAt: number;
}

interface Session {
  readonly id: string;
  readonly name: string;
  readonly total: number;
  received: Uint8Array;
}

export interface FakeDriveOptions {
  /** Where the fake believes it lives, so upload sessions carry a usable URL. */
  readonly origin?: string;
  readonly now?: () => number;
}

export class FakeDrive {
  private readonly files = new Map<string, StoredFile>();
  private readonly sessions = new Map<string, Session>();
  private readonly origin: string;
  private readonly now: () => number;

  private nextId = 1;
  /** Set by a test to make the next chunk fail, the way a radio does. */
  private failuresQueued: number[] = [];

  constructor(options: FakeDriveOptions = {}) {
    this.origin = options.origin ?? 'http://fake-drive.test';
    this.now = options.now ?? Date.now;
  }

  /** Make the next `count` chunk writes answer with `status` instead of storing anything. */
  failNextChunks(count: number, status = 503): void {
    this.failuresQueued = Array.from({ length: count }, () => status);
  }

  /** Seed a file, for testing restore without uploading one first. */
  put(name: string, bytes: Uint8Array): StoredFile {
    const file = { id: `file-${String(this.nextId++)}`, name, bytes, createdAt: this.now() };
    this.files.set(file.id, file);
    return file;
  }

  /** Everything stored, for assertions. */
  contents(): { name: string; size: number }[] {
    return [...this.files.values()].map((file) => ({ name: file.name, size: file.bytes.length }));
  }

  handle(request: FakeRequest): FakeResponse {
    const url = new URL(request.url, this.origin);
    const path = url.pathname;

    // HTTP header names are case-insensitive and Node lowercases what it
    // receives, so every lookup goes through here. Reading them by the exact
    // case a caller happened to send is a bug that only appears once the
    // request has crossed a socket — which is the only case that matters.
    const headers = new Headers(request.headers);
    if (headers.get('authorization') === null) {
      return json(401, { error: 'missing token' });
    }

    const seen: FakeRequest = { ...request, headers: headers.all() };

    if (request.method === 'POST' && path === '/upload/drive/v3/files') {
      return this.startSession(seen);
    }
    if (request.method === 'PUT' && path.startsWith('/upload/session/')) {
      return this.writeChunk(path.slice('/upload/session/'.length), seen);
    }
    if (request.method === 'GET' && path === '/drive/v3/files') {
      return this.list(url);
    }
    if (request.method === 'GET' && path.startsWith('/drive/v3/files/')) {
      return this.download(decodeURIComponent(path.slice('/drive/v3/files/'.length)));
    }
    if (request.method === 'DELETE' && path.startsWith('/drive/v3/files/')) {
      this.files.delete(decodeURIComponent(path.slice('/drive/v3/files/'.length)));
      return { status: 204, headers: {} };
    }

    return json(404, { error: `no route for ${request.method} ${path}` });
  }

  private startSession(request: FakeRequest): FakeResponse {
    // Over a socket even a JSON body arrives as bytes, so decode rather than
    // assuming the shape a caller in the same process would hand over.
    const parsed = JSON.parse(decode(request.body) || '{}') as {
      name?: string;
      parents?: string[];
    };

    if (parsed.parents?.[0] !== 'appDataFolder') {
      // The whole privacy story rests on this folder. A connector that quietly
      // wrote elsewhere would still pass every other test.
      return json(400, { error: 'uploads must target appDataFolder' });
    }

    const id = `session-${String(this.nextId++)}`;
    const total = Number(request.headers['x-upload-content-length'] ?? '0');
    this.sessions.set(id, {
      id,
      name: parsed.name ?? archiveName('0000', this.now()),
      total,
      received: new Uint8Array(0),
    });

    return { status: 200, headers: { Location: `${this.origin}/upload/session/${id}` } };
  }

  private writeChunk(id: string, request: FakeRequest): FakeResponse {
    const session = this.sessions.get(id);
    if (session === undefined) return json(404, { error: 'no such session' });

    const range = request.headers['content-range'] ?? '';

    // `bytes */total` is the resume probe: how much do you have?
    if (/^bytes \*\//.test(range)) {
      return this.progress(session);
    }

    const failure = this.failuresQueued.shift();
    if (failure !== undefined) return json(failure, { error: 'try again' });

    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!match) return json(400, { error: `bad Content-Range: ${range}` });

    const start = Number(match[1]);
    const end = Number(match[2]) + 1;

    if (start !== session.received.length) {
      // Drive rejects a chunk that does not continue where it left off, and a
      // connector that assumed its own offset would corrupt the file here.
      return this.progress(session);
    }

    const chunk = toBytes(request.body);
    if (chunk.length !== end - start) {
      return json(400, { error: 'Content-Range does not match the body length' });
    }

    const combined = new Uint8Array(session.received.length + chunk.length);
    combined.set(session.received, 0);
    combined.set(chunk, session.received.length);
    session.received = combined;

    if (session.received.length < session.total) return this.progress(session);

    this.sessions.delete(id);
    const file: StoredFile = {
      id: `file-${String(this.nextId++)}`,
      name: session.name,
      bytes: session.received,
      createdAt: this.now(),
    };
    this.files.set(file.id, file);

    return json(200, describe(file));
  }

  private progress(session: Session): FakeResponse {
    if (session.received.length === 0) return { status: 308, headers: {} };
    return {
      status: 308,
      headers: { Range: `bytes=0-${String(session.received.length - 1)}` },
    };
  }

  private list(url: URL): FakeResponse {
    if (url.searchParams.get('spaces') !== 'appDataFolder') {
      return json(400, { error: 'listing must be scoped to appDataFolder' });
    }

    return json(200, { files: [...this.files.values()].map(describe) });
  }

  private download(id: string): FakeResponse {
    const file = this.files.get(id);
    if (file === undefined) return json(404, { error: 'no such file' });

    return { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, body: file.bytes };
  }
}

/** Case-insensitive header access, since the wire does not preserve case. */
class Headers {
  private readonly entries = new Map<string, string>();

  constructor(headers: Readonly<Record<string, string>>) {
    for (const [key, value] of Object.entries(headers)) {
      this.entries.set(key.toLowerCase(), value);
    }
  }

  get(name: string): string | null {
    return this.entries.get(name.toLowerCase()) ?? null;
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.entries);
  }
}

function describe(file: StoredFile): Record<string, string> {
  return {
    id: file.id,
    name: file.name,
    size: String(file.bytes.length),
    createdTime: new Date(file.createdAt).toISOString(),
  };
}

function json(status: number, body: unknown): FakeResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function decode(body: Uint8Array | string | undefined): string {
  if (body === undefined) return '';
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

function toBytes(body: Uint8Array | string | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return body;
}
