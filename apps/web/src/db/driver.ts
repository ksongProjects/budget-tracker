import { DatabaseError } from '@budget/db';
import type { SqlParams, SqliteDriver } from '@budget/db';
import type { OpenResult, WorkerCommand, WorkerReply, WorkerRequest } from './protocol';

/**
 * The page's half of the database.
 *
 * Every call is a message to the worker and a promise waiting on the reply. The
 * worker handles messages in order, which is what makes `transaction` safe
 * without a lock: BEGIN, the statements inside it, and COMMIT are separate
 * messages, but nothing else can be interleaved between them by this driver.
 * A second driver against the same database would break that, which is why
 * there is exactly one.
 */

export interface WebDriver extends SqliteDriver {
  /** Whether the ledger is durable. `memory` means this browser refused OPFS. */
  readonly storage: 'opfs' | 'memory';
  /**
   * Point this driver at another database file.
   *
   * A restore stages the archive's snapshot beside the live ledger and then
   * has to read it; reopening beats standing up a second worker, which the
   * OPFS pool would refuse anyway — it holds its access handles exclusively.
   */
  reopen(name: string): Promise<void>;
  /** Delete every file in the pool. Tests only; there is no undo. */
  wipe(): Promise<void>;
}

export const DATABASE_NAME = 'budget.db';

export interface WebDriverOptions {
  readonly name?: string;
  /**
   * The worker to talk to. Supplied by the caller because how a worker is
   * constructed differs between the app bundle and a test harness, and that
   * difference has no business inside the driver.
   */
  readonly worker: Worker;
}

export async function createWebDriver(options: WebDriverOptions): Promise<WebDriver> {
  const { worker } = options;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (cause: unknown) => void }>();

  let nextId = 1;
  let inTransaction = false;

  worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    const waiting = pending.get(reply.id);
    if (waiting === undefined) return;

    pending.delete(reply.id);
    if (reply.ok) waiting.resolve(reply.value);
    else waiting.reject(new DatabaseError(reply.error));
  });

  worker.addEventListener('error', (event) => {
    // A worker that dies takes every outstanding query with it. Failing them
    // all is the only honest answer; leaving them pending would hang the page.
    const failure = new DatabaseError(`the database worker failed: ${event.message}`);
    for (const waiting of pending.values()) waiting.reject(failure);
    pending.clear();
  });

  const send = async <T>(command: WorkerCommand): Promise<T> => {
    const id = nextId++;
    const request: WorkerRequest = { id, command };

    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage(request);
    });
  };

  let opened = await send<OpenResult>({ kind: 'open', name: options.name ?? DATABASE_NAME });

  return {
    get storage() {
      return opened.storage;
    },

    async reopen(name: string) {
      opened = await send<OpenResult>({ kind: 'open', name });
    },

    async wipe() {
      await send<undefined>({ kind: 'wipe' });
    },

    async exec(sql) {
      await send<undefined>({ kind: 'exec', sql });
    },

    async run(sql, params = []) {
      return send<{ changes: number }>({ kind: 'run', sql, params });
    },

    async all<T>(sql: string, params: SqlParams = []) {
      return send<T[]>({ kind: 'all', sql, params });
    },

    async get<T>(sql: string, params: SqlParams = []) {
      return send<T | undefined>({ kind: 'get', sql, params });
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (inTransaction) {
        throw new DatabaseError('transactions must not be nested; compose within one call');
      }

      inTransaction = true;
      await send<undefined>({ kind: 'begin' });

      try {
        const result = await fn();
        await send<undefined>({ kind: 'commit' });
        return result;
      } catch (error) {
        await send<undefined>({ kind: 'rollback' });
        throw error;
      } finally {
        inTransaction = false;
      }
    },

    async close() {
      await send<undefined>({ kind: 'close' });
      worker.terminate();
    },
  };
}
