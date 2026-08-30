/**
 * The narrow SQLite surface every platform can provide: node:sqlite in tests
 * and CI, expo-sqlite on mobile, SQLite WASM over OPFS on the web.
 *
 * The interface is async because two of the three are, and a synchronous driver
 * wraps trivially while the reverse does not. Keeping it this small is what lets
 * the repositories be plain TypeScript that runs anywhere, tested in CI with no
 * device and no native build.
 */

export type SqlValue = string | number | null | Uint8Array;
export type SqlParams = readonly SqlValue[];

export interface SqliteDriver {
  /** Run one or more statements for their effect. Not parameterized; migrations only. */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParams): Promise<{ changes: number }>;
  all<T>(sql: string, params?: SqlParams): Promise<T[]>;
  get<T>(sql: string, params?: SqlParams): Promise<T | undefined>;
  /**
   * Run `fn` inside a transaction, committing on return and rolling back on
   * throw. Implementations must not nest: callers compose within one call.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class DatabaseError extends Error {
  override readonly name = 'DatabaseError';
}
