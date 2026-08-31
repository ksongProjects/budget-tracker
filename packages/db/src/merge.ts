import type { RepositoryContext } from './context.js';
import { DatabaseError } from './driver.js';
import { recordTombstone } from './tombstones.js';

/**
 * Merge, per docs/data-model.md.
 *
 * Restore and import both run this; neither ever blind-overwrites. The rules
 * are chosen so that merging is **order-independent** — merging A into B gives
 * the same ledger as merging B into A — because a user restoring the same two
 * backups in a different order must not get a different answer.
 *
 * Every superseded revision goes to the tombstone log. It is the user's money
 * data, and an overwrite they did not expect must be recoverable.
 */

/** The bookkeeping every mergeable row carries. */
export interface MergeableRow {
  readonly rev: number;
  readonly updated_at: number;
  readonly origin_device: string;
  readonly [column: string]: unknown;
}

export type MergeOutcome = 'local' | 'incoming' | 'identical';

/**
 * Which of two revisions of the same row wins.
 *
 * Higher `rev` first, then later `updated_at`, then higher `origin_device`. The
 * device id is the final tie-break purely so the result is deterministic: two
 * devices resolving the same conflict independently must reach the same answer,
 * or they will disagree forever and each keep overwriting the other.
 */
export function chooseWinner(local: MergeableRow, incoming: MergeableRow): MergeOutcome {
  if (incoming.rev !== local.rev) {
    return incoming.rev > local.rev ? 'incoming' : 'local';
  }

  if (incoming.updated_at !== local.updated_at) {
    return incoming.updated_at > local.updated_at ? 'incoming' : 'local';
  }

  if (incoming.origin_device !== local.origin_device) {
    return incoming.origin_device > local.origin_device ? 'incoming' : 'local';
  }

  return 'identical';
}

export interface MergeStats {
  readonly inserted: number;
  readonly updated: number;
  readonly kept: number;
  readonly tombstoned: number;
}

export interface MergeTable {
  readonly name: string;
  /** The primary key column. `captures` uses `capture_id`, everything else `id`. */
  readonly key: string;
}

/** The tables a backup carries, in foreign-key order so inserts never dangle. */
export const MERGE_TABLES: readonly MergeTable[] = [
  // The profile travels with the ledger: restoring onto a new phone should not
  // ask someone to introduce themselves again.
  { name: 'profile', key: 'id' },
  { name: 'merchants', key: 'id' },
  { name: 'merchant_aliases', key: 'alias' },
  { name: 'categories', key: 'id' },
  { name: 'accounts', key: 'id' },
  { name: 'captures', key: 'capture_id' },
  { name: 'transactions', key: 'id' },
  { name: 'line_items', key: 'id' },
];

/**
 * Merge one table's incoming rows into the local ledger.
 *
 * Caller supplies the rows rather than a second database handle, so this works
 * the same whether they came from an archive, another table, or a test.
 */
/** SQLite's default parameter limit is 999; stay well inside it. */
const LOOKUP_CHUNK = 400;

/**
 * Load the local rows matching the incoming ids, in bulk.
 *
 * One query per row is what this replaces: restoring a 10,000-row backup on a
 * device took minutes that way, because every row crossed the native bridge
 * twice. Restore has to work at the size a real ledger reaches.
 */
async function loadExisting(
  ctx: RepositoryContext,
  table: MergeTable,
  ids: readonly string[],
): Promise<Map<string, MergeableRow>> {
  const existing = new Map<string, MergeableRow>();

  for (let offset = 0; offset < ids.length; offset += LOOKUP_CHUNK) {
    const slice = ids.slice(offset, offset + LOOKUP_CHUNK);
    const placeholders = slice.map(() => '?').join(', ');

    const rows = await ctx.driver.all<MergeableRow>(
      `SELECT * FROM ${table.name} WHERE ${table.key} IN (${placeholders})`,
      slice,
    );

    for (const row of rows) {
      const key = row[table.key];
      if (typeof key === 'string') existing.set(key, row);
    }
  }

  return existing;
}

export async function mergeTable(
  ctx: RepositoryContext,
  table: MergeTable,
  incoming: readonly MergeableRow[],
): Promise<MergeStats> {
  let inserted = 0;
  let updated = 0;
  let kept = 0;
  let tombstoned = 0;

  const ids = incoming.map((row) => {
    const id = row[table.key];
    if (typeof id !== 'string') {
      throw new DatabaseError(`row in ${table.name} has no ${table.key}`);
    }
    return id;
  });

  const existing = await loadExisting(ctx, table, ids);

  for (const [index, row] of incoming.entries()) {
    const id = ids[index] ?? '';
    const local = existing.get(id);

    if (!local) {
      await insertRow(ctx, table, row);
      // Keep the map current: a batch may carry the same id twice, and the
      // second copy must compare against what was just written.
      existing.set(id, row);
      inserted += 1;
      continue;
    }

    const winner = chooseWinner(local, row);
    if (winner !== 'incoming') {
      kept += 1;
      continue;
    }

    // The local revision is about to be overwritten; keep it.
    await recordTombstone(ctx, table.name, id, local.rev, local);
    tombstoned += 1;

    await updateRow(ctx, table, id, row);
    existing.set(id, row);
    updated += 1;
  }

  return { inserted, updated, kept, tombstoned };
}

/**
 * Merge a whole backup into the ledger, in one transaction.
 *
 * All or nothing: a merge that fails halfway would leave the ledger in a state
 * that is neither the old one nor the new one, and the user could not tell
 * which rows made it.
 */
export async function mergeAll(
  ctx: RepositoryContext,
  rows: Readonly<Record<string, readonly MergeableRow[]>>,
): Promise<Record<string, MergeStats>> {
  return ctx.driver.transaction(async () => {
    const stats: Record<string, MergeStats> = {};

    for (const table of MERGE_TABLES) {
      const incoming = rows[table.name];
      if (!incoming || incoming.length === 0) continue;

      stats[table.name] = await mergeTable(ctx, table, incoming);
    }

    return stats;
  });
}

async function insertRow(
  ctx: RepositoryContext,
  table: MergeTable,
  row: MergeableRow,
): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');

  await ctx.driver.run(
    `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => toSqlValue(row[column])),
  );
}

async function updateRow(
  ctx: RepositoryContext,
  table: MergeTable,
  id: string,
  row: MergeableRow,
): Promise<void> {
  const columns = Object.keys(row).filter((column) => column !== table.key);
  const assignments = columns.map((column) => `${column} = ?`).join(', ');

  await ctx.driver.run(
    `UPDATE ${table.name} SET ${assignments} WHERE ${table.key} = ?`,
    [...columns.map((column) => toSqlValue(row[column])), id],
  );
}

function toSqlValue(value: unknown): string | number | null | Uint8Array {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;

  throw new DatabaseError(`cannot store value of type ${typeof value} in a merge`);
}
