import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { RepositoryContext } from '@budget/db';
import { toCsv, toReportHtml } from './format';
import type { ExportRow } from './format';

/**
 * Writing the ledger out as plaintext, on purpose.
 *
 * An Export is not a Backup: it is unencrypted, it carries no key material, and
 * restoring from it is not a thing this app does. It exists because
 * spreadsheets and tax preparers exist. The user is told that before the file
 * is written, not after it is shared.
 */

export type ExportRange = 'all' | 'this-year' | 'last-90-days';

export interface ExportResult {
  readonly path: string;
  readonly rows: number;
  readonly bytes: number;
}

const EXPORT_DIR = `${FileSystem.cacheDirectory ?? ''}exports/`;

export function rangeLabel(range: ExportRange): string {
  switch (range) {
    case 'this-year':
      return String(new Date().getFullYear());
    case 'last-90-days':
      return 'Last 90 days';
    default:
      return 'All time';
  }
}

function rangeStart(range: ExportRange, now: number): number {
  switch (range) {
    case 'this-year':
      return new Date(new Date(now).getFullYear(), 0, 1).getTime();
    case 'last-90-days':
      return now - 90 * 86_400_000;
    default:
      return 0;
  }
}

interface ExportSqlRow {
  occurred_at: number;
  merchant: string | null;
  category: string | null;
  account: string | null;
  amount_minor: number;
  currency: string;
  note: string | null;
  source: string;
  confirmed_at: number | null;
}

/**
 * The rows an export covers: everything not deleted, newest first, with the
 * names joined in. Tombstoned rows stay out — an export is what the ledger says
 * now, not its history.
 */
export async function collectRows(
  ctx: RepositoryContext,
  range: ExportRange,
  now: number = Date.now(),
): Promise<ExportRow[]> {
  const rows = await ctx.driver.all<ExportSqlRow>(
    `SELECT t.occurred_at, t.amount_minor, t.currency, t.note, t.source, t.confirmed_at,
            m.canonical_name AS merchant, c.name AS category, a.name AS account
     FROM transactions t
     LEFT JOIN merchants  m ON m.id = t.merchant_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts   a ON a.id = t.account_id
     WHERE t.deleted_at IS NULL AND t.occurred_at >= ?
     ORDER BY t.occurred_at DESC`,
    [rangeStart(range, now)],
  );

  return rows.map((row) => ({
    occurredAt: row.occurred_at,
    merchant: row.merchant,
    category: row.category,
    account: row.account,
    amountMinor: row.amount_minor as ExportRow['amountMinor'],
    currency: row.currency as ExportRow['currency'],
    note: row.note,
    source: row.source,
    confirmedAt: row.confirmed_at,
  }));
}

export async function exportCsv(
  ctx: RepositoryContext,
  range: ExportRange,
): Promise<ExportResult> {
  const rows = await collectRows(ctx, range);
  const csv = toCsv(rows);
  const path = `${EXPORT_DIR}${fileStem(range)}.csv`;

  await ensureDir();
  await FileSystem.writeAsStringAsync(path, csv, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  return { path, rows: rows.length, bytes: csv.length };
}

export async function exportPdf(
  ctx: RepositoryContext,
  range: ExportRange,
): Promise<ExportResult> {
  const rows = await collectRows(ctx, range);
  const html = toReportHtml(rows, { generatedAt: Date.now(), range: rangeLabel(range) });

  // The platform's own print pipeline renders it, so the PDF matches what the
  // user would get from Print in any other app on the device.
  const { uri } = await Print.printToFileAsync({ html });

  await ensureDir();
  const path = `${EXPORT_DIR}${fileStem(range)}.pdf`;
  await FileSystem.deleteAsync(path, { idempotent: true });
  await FileSystem.moveAsync({ from: uri, to: path });

  const info = await FileSystem.getInfoAsync(path);

  return { path, rows: rows.length, bytes: info.exists ? info.size : 0 };
}

/**
 * Hand the file to whatever the user picks.
 *
 * This is the moment the data leaves the app's private storage, which is why
 * the screen says so first. There is no upload here and nothing is sent
 * anywhere by us — the destination is the user's choice, every time.
 */
export async function shareExport(path: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;

  await Sharing.shareAsync(path, {
    mimeType: path.endsWith('.pdf') ? 'application/pdf' : 'text/csv',
    UTI: path.endsWith('.pdf') ? 'com.adobe.pdf' : 'public.comma-separated-values-text',
  });

  return true;
}

/** Delete the plaintext files this app has written. */
export async function clearExports(): Promise<number> {
  const info = await FileSystem.getInfoAsync(EXPORT_DIR);
  if (!info.exists) return 0;

  const names = await FileSystem.readDirectoryAsync(EXPORT_DIR);
  for (const name of names) {
    await FileSystem.deleteAsync(`${EXPORT_DIR}${name}`, { idempotent: true });
  }

  return names.length;
}

function fileStem(range: ExportRange): string {
  const today = new Date().toISOString().slice(0, 10);
  return `budget-${range}-${today}`;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(EXPORT_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
  }
}
