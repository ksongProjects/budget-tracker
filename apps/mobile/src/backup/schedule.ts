import type { RepositoryContext } from '@budget/db';

/**
 * When an automatic backup is worth running.
 *
 * Split out of `auto.ts` and free of any React Native import, because this is
 * the part that decides whether the user's data gets written at all. Deciding
 * wrong in the quiet direction — "nothing changed" when something did — loses
 * money data silently, so it is tested against a real database rather than
 * trusted because it reads correctly.
 */

/** Tables whose `updated_at` decides whether anything is worth backing up. */
const CHANGE_TABLES = [
  'merchants',
  'merchant_aliases',
  'categories',
  'accounts',
  'captures',
  'transactions',
  'line_items',
] as const;

export type AutoBackupOutcome = 'not-set-up' | 'too-soon' | 'unchanged' | 'written';

export interface AutoBackupReport {
  readonly outcome: AutoBackupOutcome;
  /** Present when an archive was written. */
  readonly bytes?: number;
  /** How many old archives were deleted by retention. */
  readonly pruned?: number;
}

export interface AutoBackupOptions {
  readonly minIntervalMs?: number;
  /** Ignore both guards. The user pressing "back up now" is not a schedule. */
  readonly force?: boolean;
}

/**
 * Everything the decision needs from the device, passed in rather than
 * imported: the real versions reach the OS keystore and the filesystem, and a
 * test has no business doing either.
 */
export interface BackupHooks {
  readonly isSetUp: () => Promise<boolean>;
  readonly lastBackupAt: () => Promise<number | undefined>;
  readonly writeBackup: () => Promise<{ bytes: number; pruned: number }>;
  readonly now: () => number;
}

/**
 * Write a backup if one is due.
 *
 * Never throws for the ordinary reasons — backup not set up, nothing changed —
 * because those are answers, not failures. A real failure (no space, keystore
 * unavailable) still throws, so a caller that can show it does.
 */
export async function runScheduledBackup(
  ctx: RepositoryContext,
  hooks: BackupHooks,
  options: AutoBackupOptions & { readonly minIntervalMs: number },
): Promise<AutoBackupReport> {
  if (!(await hooks.isSetUp())) return { outcome: 'not-set-up' };

  const last = await hooks.lastBackupAt();

  if (last !== undefined && options.force !== true) {
    if (hooks.now() - last < options.minIntervalMs) return { outcome: 'too-soon' };
    if (!(await ledgerChangedSince(ctx, last))) return { outcome: 'unchanged' };
  }

  const result = await hooks.writeBackup();

  return { outcome: 'written', bytes: result.bytes, pruned: result.pruned };
}

/**
 * Whether any row has been written at or after `since`.
 *
 * Cheaper than the alternative by orders of magnitude: the question is whether
 * to spend seconds encrypting the whole ledger, and this answers it in a scan.
 *
 * The comparison is inclusive on purpose. `since` is stamped before the
 * snapshot is taken, so a row sharing that exact millisecond is almost always
 * already inside the archive and re-backing it up is wasted work — but if the
 * two ever land in the same millisecond the other way round, an exclusive
 * comparison would drop that row from every future backup until something
 * unrelated changed. One redundant backup is cheap; a row that is never backed
 * up again is not.
 */
export async function ledgerChangedSince(
  ctx: RepositoryContext,
  since: number,
): Promise<boolean> {
  const query = CHANGE_TABLES.map(
    (table) => `SELECT MAX(updated_at) AS changed FROM ${table}`,
  ).join(' UNION ALL ');

  const rows = await ctx.driver.all<{ changed: number | null }>(query);
  return rows.some((row) => row.changed !== null && row.changed >= since);
}
