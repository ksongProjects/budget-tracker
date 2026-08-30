import { formatAmount, sumAmounts } from '@budget/schema';
import type { Currency, MinorUnits } from '@budget/schema';
import { localDayKey, localMonthKey, monthLabel } from '../lib/grouping';

/**
 * Turning the ledger into files for other people's software.
 *
 * Everything here is plaintext by definition — that is what a spreadsheet or a
 * tax preparer can read. An Export is not a Backup and must never be offered as
 * one (CONTEXT.md); the screen says so, and so does the first line of the CSV.
 *
 * Pure functions: no filesystem, no sharing, so the shapes that matter — the
 * quoting rules, the per-currency totals — are testable without a device.
 */

export interface ExportRow {
  readonly occurredAt: number;
  readonly merchant: string | null;
  readonly category: string | null;
  readonly account: string | null;
  readonly amountMinor: MinorUnits;
  readonly currency: Currency;
  readonly note: string | null;
  readonly source: string;
  readonly confirmedAt: number | null;
}

const COLUMNS = [
  'Date',
  'Merchant',
  'Category',
  'Account',
  'Amount',
  'Currency',
  'Status',
  'Source',
  'Note',
] as const;

/**
 * RFC 4180 CSV.
 *
 * Amounts are written as plain decimals with no currency symbol and no
 * thousands separator: a spreadsheet reads that as a number, and anything
 * prettier arrives as text that will not add up.
 */
export function toCsv(rows: readonly ExportRow[]): string {
  const lines = [COLUMNS.join(',')];

  for (const row of rows) {
    lines.push(
      [
        cell(localDayKey(row.occurredAt)),
        freeText(row.merchant ?? ''),
        freeText(row.category ?? ''),
        freeText(row.account ?? ''),
        cell(formatAmount(row.amountMinor, row.currency)),
        cell(row.currency),
        cell(row.confirmedAt === null ? 'pending' : 'confirmed'),
        cell(row.source),
        freeText(row.note ?? ''),
      ].join(','),
    );
  }

  // A trailing newline: tools that read line-by-line otherwise drop the last row.
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Quote only when it changes meaning, so the common case stays readable in a
 * text editor.
 */
function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * A cell whose content came off a receipt or out of the keyboard.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe, because
 * spreadsheets treat those as formulas — a merchant called "=cmd" is a merchant
 * name, not something to execute. Only text gets this: doing it to the amount
 * column would turn every refund into a string that will not add up, which is a
 * worse bug than the one it guards against.
 */
function freeText(value: string): string {
  return cell(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
}

export interface CurrencyTotal {
  readonly currency: Currency;
  readonly totalMinor: MinorUnits;
  readonly count: number;
}

/**
 * Totals are per currency, never summed across them. A single number spanning
 * two currencies would be meaningless and would look exactly like a right one.
 */
export function totalsByCurrency(rows: readonly ExportRow[]): CurrencyTotal[] {
  const buckets = new Map<Currency, MinorUnits[]>();

  for (const row of rows) {
    const bucket = buckets.get(row.currency);
    if (bucket) bucket.push(row.amountMinor);
    else buckets.set(row.currency, [row.amountMinor]);
  }

  return [...buckets.entries()]
    .map(([currency, amounts]) => ({
      currency,
      // sumAmounts refuses to overflow into imprecision rather than returning a
      // number that is quietly wrong, which is the only acceptable failure for
      // a total the user may hand to a tax office.
      totalMinor: sumAmounts(amounts),
      count: amounts.length,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export interface GroupTotal {
  readonly key: string;
  readonly label: string;
  readonly currencies: readonly CurrencyTotal[];
}

/** Month totals, newest first — the shape the report is read in. */
export function totalsByMonth(rows: readonly ExportRow[]): GroupTotal[] {
  return groupTotals(rows, (row) => localMonthKey(row.occurredAt), monthLabel).sort((a, b) =>
    b.key.localeCompare(a.key),
  );
}

/** Category totals, largest first, with uncategorised last whatever its size. */
export function totalsByCategory(rows: readonly ExportRow[]): GroupTotal[] {
  const groups = groupTotals(
    rows,
    (row) => row.category ?? '',
    (key) => (key === '' ? 'Uncategorised' : key),
  );

  return groups.sort((a, b) => {
    if (a.key === '') return 1;
    if (b.key === '') return -1;
    return largest(b) - largest(a);
  });
}

function largest(group: GroupTotal): number {
  return Math.max(...group.currencies.map((entry) => entry.totalMinor), 0);
}

function groupTotals(
  rows: readonly ExportRow[],
  keyOf: (row: ExportRow) => string,
  labelOf: (key: string) => string,
): GroupTotal[] {
  const groups = new Map<string, ExportRow[]>();

  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()].map(([key, group]) => ({
    key,
    label: labelOf(key),
    currencies: totalsByCurrency(group),
  }));
}

export interface ReportOptions {
  readonly generatedAt: number;
  /** How the rows were filtered, said in the user's words, for the report's header. */
  readonly range: string;
  /** Override the entry cap. Tests use a small value; nothing else should. */
  readonly maxEntries?: number;
}

/**
 * How many entries the report lists.
 *
 * Totals always cover every row — the cap is on the printed list only. A report
 * is a summary someone reads; the full row-by-row dump is what the CSV is for.
 * This is not a nicety: the platform renders the PDF by laying the HTML out in a
 * WebView, and handing it ten thousand table rows takes the device down with it.
 * That was measured, not guessed.
 */
export const MAX_REPORT_ENTRIES = 500;

/**
 * The PDF's source. HTML because the platform's print pipeline renders it; the
 * markup stays inline-styled and self-contained so nothing is fetched while
 * printing a document about the user's spending.
 */
export function toReportHtml(rows: readonly ExportRow[], options: ReportOptions): string {
  // Every entry is listed, but only confirmed ones are totalled: an unconfirmed
  // row is a guess the user has not agreed with yet, and a total built on
  // guesses is the one number here that must never be wrong (CONTEXT.md).
  const counted = rows.filter((row) => row.confirmedAt !== null);
  const pending = rows.length - counted.length;
  const limit = options.maxEntries ?? MAX_REPORT_ENTRIES;
  const listed = rows.slice(0, limit);
  const omitted = rows.length - listed.length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Spending report</title>
<style>
  body { font-family: -apple-system, Roboto, Helvetica, sans-serif; color: #14171c; margin: 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; }
  .meta { color: #626b78; font-size: 12px; margin: 0; }
  .warn { border: 1px solid #b26a1c; background: #fdf4e7; color: #7a4a10;
          padding: 10px 12px; border-radius: 6px; font-size: 12px; margin: 20px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th { text-align: left; border-bottom: 1px solid #c9cfd8; padding: 6px 4px; }
  td { border-bottom: 1px solid #eceff3; padding: 6px 4px; }
  td.amount, th.amount { text-align: right; font-variant-numeric: tabular-nums; }
  tr.pending td { color: #8a6218; }
  .empty { color: #626b78; font-size: 13px; }
</style>
</head>
<body>
<h1>Spending report</h1>
<p class="meta">${escapeHtml(options.range)} · ${String(rows.length)} entries${
    pending === 0 ? '' : `, ${String(pending)} still unconfirmed and not counted in the totals`
  } · generated ${escapeHtml(new Date(options.generatedAt).toLocaleString())}</p>

<div class="warn">
  This report is not encrypted and not a backup. Anyone who opens the file can read
  every entry in it. Keep it where you would keep a bank statement, and delete it when
  you are done.
</div>

<h2>Total</h2>
${totalsTable(totalsByCurrency(counted))}

<h2>By month</h2>
${groupTable(totalsByMonth(counted))}

<h2>By category</h2>
${groupTable(totalsByCategory(counted))}

<h2>Entries</h2>
${
    omitted === 0
      ? ''
      : `<p class="meta">Newest ${String(listed.length)} of ${String(rows.length)}. ` +
        `The remaining ${String(omitted)} are in the CSV export, which has no limit.</p>`
  }
${entriesTable(listed)}
</body>
</html>`;
}

function totalsTable(totals: readonly CurrencyTotal[]): string {
  if (totals.length === 0) return '<p class="empty">Nothing to total.</p>';

  return `<table><tbody>${totals
    .map(
      (total) =>
        `<tr><td>${escapeHtml(total.currency)}</td><td>${String(total.count)} entries</td>` +
        `<td class="amount">${escapeHtml(formatAmount(total.totalMinor, total.currency))}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function groupTable(groups: readonly GroupTotal[]): string {
  if (groups.length === 0) return '<p class="empty">Nothing to total.</p>';

  return `<table><tbody>${groups
    .map(
      (group) =>
        `<tr><td>${escapeHtml(group.label)}</td><td class="amount">${group.currencies
          .map(
            (total) =>
              `${escapeHtml(formatAmount(total.totalMinor, total.currency))} ${escapeHtml(total.currency)}`,
          )
          .join('<br />')}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function entriesTable(rows: readonly ExportRow[]): string {
  if (rows.length === 0) return '<p class="empty">No entries in this range.</p>';

  return `<table>
<thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th class="amount">Amount</th></tr></thead>
<tbody>${rows
    .map(
      (row) =>
        `<tr class="${row.confirmedAt === null ? 'pending' : ''}">` +
        `<td>${escapeHtml(localDayKey(row.occurredAt))}</td>` +
        `<td>${escapeHtml(row.merchant ?? '—')}${row.confirmedAt === null ? ' (pending)' : ''}</td>` +
        `<td>${escapeHtml(row.category ?? '—')}</td>` +
        `<td class="amount">${escapeHtml(formatAmount(row.amountMinor, row.currency))} ${escapeHtml(row.currency)}</td>` +
        `</tr>`,
    )
    .join('')}</tbody></table>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
