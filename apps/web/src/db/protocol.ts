import type { SqlParams, SqlValue } from '@budget/db';

/**
 * What the page and the database worker say to each other.
 *
 * SQLite runs in a worker because the alternative is a database that blocks
 * painting: a query over ten thousand rows is fast, but it is not free, and on
 * the main thread "fast" still shows up as a dropped frame. Keeping the wire
 * format in one file means both ends are checked against the same types rather
 * than against each other's memory of them.
 *
 * Deliberately tiny — no Comlink, no proxy magic. Five verbs is not enough
 * surface to justify a dependency that has to be audited for a bundle that
 * promises no third-party scripts.
 */

export type WorkerCommand =
  | { readonly kind: 'open'; readonly name: string }
  | { readonly kind: 'wipe' }
  | { readonly kind: 'exec'; readonly sql: string }
  | { readonly kind: 'run'; readonly sql: string; readonly params: SqlParams }
  | { readonly kind: 'all'; readonly sql: string; readonly params: SqlParams }
  | { readonly kind: 'get'; readonly sql: string; readonly params: SqlParams }
  | { readonly kind: 'begin' }
  | { readonly kind: 'commit' }
  | { readonly kind: 'rollback' }
  | { readonly kind: 'close' };

export interface WorkerRequest {
  readonly id: number;
  readonly command: WorkerCommand;
}

export type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** What `open` answers with, so the page can say which storage it actually got. */
export interface OpenResult {
  /** `opfs` when the database is durable; `memory` when the browser would not allow it. */
  readonly storage: 'opfs' | 'memory';
}

export type Row = Record<string, SqlValue>;
