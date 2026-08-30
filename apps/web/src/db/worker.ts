import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { OpenResult, Row, WorkerReply, WorkerRequest } from './protocol';

/**
 * SQLite, in a worker, over OPFS.
 *
 * The storage is the OPFS "SAH pool" VFS rather than the other OPFS backend,
 * for one reason that decides it: the pool needs no cross-origin isolation, so
 * the app can be served as ordinary static files. Requiring COOP and COEP
 * headers would make the deployment story "and you must control the server",
 * which is not a promise a local-first app should need to make.
 *
 * If OPFS is unavailable — a private window in some browsers, an old engine —
 * the database opens in memory instead of failing. That is a degraded mode and
 * the page is told so, because a ledger that silently forgets itself on reload
 * is far worse than one that says it is temporary.
 */

interface Sqlite3Db {
  exec(options: { sql: string; bind?: readonly unknown[]; rowMode?: string; returnValue?: string }): unknown;
  changes(): number;
  close(): void;
}

interface SahPool {
  OpfsSAHPoolDb: new (filename: string) => Sqlite3Db;
  wipeFiles(): Promise<void>;
  getCapacity(): number;
  addCapacity(n: number): Promise<number>;
}

interface Sqlite3Api {
  oo1: {
    DB: new (filename: string, flags?: string) => Sqlite3Db;
  };
  installOpfsSAHPoolVfs?: (options: {
    name?: string;
    initialCapacity?: number;
  }) => Promise<SahPool>;
}

let db: Sqlite3Db | undefined;
let pool: SahPool | undefined;

/**
 * Room for more than one database file.
 *
 * The pool claims a fixed number of OPFS access handles up front. The app needs
 * one file, but a restore stages a second alongside it, and the test suite runs
 * a fresh database per contract case — the default of six ran out and SQLite
 * reported it as "unable to open database file", which reads like a bug in the
 * ledger rather than a pool that is full.
 */
const POOL_CAPACITY = 24;

/**
 * The pool takes *exclusive* access handles for the whole origin, so a second
 * worker asking for the same pool waits on the first forever. One worker owns
 * it, installs the VFS once, and keeps it.
 */
async function acquirePool(): Promise<SahPool | undefined> {
  if (pool !== undefined) return pool;

  const sqlite3 = (await sqlite3InitModule({
    print: () => undefined,
    printErr: () => undefined,
  })) as unknown as Sqlite3Api;

  api = sqlite3;
  if (sqlite3.installOpfsSAHPoolVfs === undefined) return undefined;

  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({
      name: 'budget-opfs',
      initialCapacity: POOL_CAPACITY,
    });
    return pool;
  } catch {
    // No OPFS here. The page is told, and the ledger opens in memory.
    return undefined;
  }
}

let api: Sqlite3Api | undefined;

async function open(name: string): Promise<OpenResult> {
  db?.close();
  db = undefined;

  const acquired = await acquirePool();

  if (acquired !== undefined) {
    if (acquired.getCapacity() < POOL_CAPACITY) {
      await acquired.addCapacity(POOL_CAPACITY - acquired.getCapacity());
    }
    db = new acquired.OpfsSAHPoolDb(`/${name}`);
    configure();
    return { storage: 'opfs' };
  }

  const sqlite3 =
    api ??
    ((await sqlite3InitModule({
      print: () => undefined,
      printErr: () => undefined,
    })) as unknown as Sqlite3Api);
  api = sqlite3;

  db = new sqlite3.oo1.DB(':memory:', 'c');
  configure();
  return { storage: 'memory' };
}

function configure(): void {
  // No WAL: the SAH pool VFS is a single-connection store, and WAL buys nothing
  // where there is no second connection to keep out of the way.
  required().exec({ sql: 'PRAGMA foreign_keys = ON' });
}

function required(): Sqlite3Db {
  if (db === undefined) throw new Error('the database is not open');
  return db;
}

function rows(sql: string, params: readonly unknown[]): Row[] {
  return required().exec({
    sql,
    bind: params,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Row[];
}

async function handle(command: WorkerRequest['command']): Promise<unknown> {
  switch (command.kind) {
    case 'open':
      return open(command.name);
    case 'wipe':
      // Only a test asks for this. It exists because the pool is per origin:
      // files left behind by one case are still there for the next.
      db?.close();
      db = undefined;
      await pool?.wipeFiles();
      return undefined;
    case 'exec':
      required().exec({ sql: command.sql });
      return undefined;
    case 'run':
      rows(command.sql, command.params);
      return { changes: required().changes() };
    case 'all':
      return rows(command.sql, command.params);
    case 'get':
      return rows(command.sql, command.params)[0];
    case 'begin':
      required().exec({ sql: 'BEGIN' });
      return undefined;
    case 'commit':
      required().exec({ sql: 'COMMIT' });
      return undefined;
    case 'rollback':
      required().exec({ sql: 'ROLLBACK' });
      return undefined;
    case 'close':
      db?.close();
      db = undefined;
      return undefined;
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { id, command } = event.data;

  handle(command).then(
    (value) => {
      reply({ id, ok: true, value });
    },
    (cause: unknown) => {
      // Errors do not survive structured cloning with their class intact, so
      // the message crosses as text and the page rebuilds a DatabaseError.
      reply({ id, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    },
  );
});

function reply(message: WorkerReply): void {
  self.postMessage(message);
}
