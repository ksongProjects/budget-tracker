import { uuidv7 } from '@budget/schema';
import type { RepositoryContext } from './context.js';

/**
 * The append-only record of superseded revisions. Every overwrite — a local
 * edit, a delete, or the losing side of a Merge — leaves the previous revision
 * here.
 *
 * This exists because the alternative is silently losing a number the user
 * entered. Nothing in the app deletes from this table.
 */

export interface TombstoneRow {
  readonly id: string;
  readonly table_name: string;
  readonly row_id: string;
  readonly rev: number;
  readonly payload: string;
  readonly superseded_at: number;
}

export async function recordTombstone(
  ctx: RepositoryContext,
  tableName: string,
  rowId: string,
  rev: number,
  payload: unknown,
): Promise<void> {
  await ctx.driver.run(
    `INSERT INTO tombstones (id, table_name, row_id, rev, payload, superseded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv7(), tableName, rowId, rev, JSON.stringify(payload), ctx.clock()],
  );
}

/** Superseded revisions of one row, newest first. The basis of "undo this overwrite". */
export async function tombstonesFor(
  ctx: RepositoryContext,
  tableName: string,
  rowId: string,
): Promise<TombstoneRow[]> {
  return ctx.driver.all<TombstoneRow>(
    `SELECT id, table_name, row_id, rev, payload, superseded_at
     FROM tombstones WHERE table_name = ? AND row_id = ?
     ORDER BY superseded_at DESC, rev DESC`,
    [tableName, rowId],
  );
}
