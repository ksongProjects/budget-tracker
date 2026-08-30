/*
 * node:sqlite is synchronous, so the methods below are `async` without awaiting
 * anything. That is deliberate — it converts SQLite's synchronous throws into
 * rejections, which is what the SqliteDriver contract promises.
 */
/* eslint-disable @typescript-eslint/require-await */
import { DatabaseSync } from 'node:sqlite';
import type { SqliteDriver, SqlParams } from '../driver.js';
import { DatabaseError } from '../driver.js';

/**
 * node:sqlite driver, for tests and CI. Deliberately not exported from the
 * package index: importing it must never pull `node:sqlite` into a mobile or
 * browser bundle.
 */

export interface NodeDriverOptions {
  /** Defaults to an in-memory database, which is what tests want. */
  readonly path?: string;
}

export function createNodeDriver(options: NodeDriverOptions = {}): SqliteDriver {
  const db = new DatabaseSync(options.path ?? ':memory:');

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  let inTransaction = false;

  return {
    // These are `async` so that SQLite's synchronous throws surface as
    // rejections. A driver that sometimes throws and sometimes rejects would
    // force every caller to handle both.
    async exec(sql) {
      db.exec(sql);
    },

    async run(sql, params = []) {
      const result = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(result.changes) };
    },

    async all<T>(sql: string, params: SqlParams = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },

    async get<T>(sql: string, params: SqlParams = []) {
      return db.prepare(sql).get(...(params as never[])) as T | undefined;
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (inTransaction) {
        throw new DatabaseError('transactions must not be nested; compose within one call');
      }
      inTransaction = true;
      db.exec('BEGIN');
      try {
        const result = await fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        inTransaction = false;
      }
    },

    async close() {
      db.close();
    },
  };
}
