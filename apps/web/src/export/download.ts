import { toCsv, toReportHtml } from '@budget/report';
import type { ExportRow } from '@budget/report';

/**
 * Exporting from the browser.
 *
 * The bytes come from `@budget/report`, the same code the phone uses, so a CSV
 * exported here and one exported there are the same file. That is the whole
 * reason the formatting lives in a package: two implementations kept in step by
 * hand would drift, and the drift would show up in someone's tax return.
 *
 * There is no PDF writer here. The browser's own print dialog produces one from
 * the report's HTML, which means the output matches what the user would get by
 * printing any other page, and the app ships no PDF library to be audited.
 */

export interface DownloadableExport {
  readonly filename: string;
  readonly blob: Blob;
}

export function csvExport(rows: readonly ExportRow[], today = new Date()): DownloadableExport {
  return {
    filename: `budget-${stamp(today)}.csv`,
    // The BOM is for spreadsheets that still guess encodings from the first
    // bytes; without it a merchant with an accent opens as mojibake in Excel.
    blob: new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' }),
  };
}

export function reportHtml(rows: readonly ExportRow[], range: string, now = Date.now()): string {
  return toReportHtml(rows, { generatedAt: now, range });
}

/**
 * Hand the file to the user.
 *
 * An object URL rather than a data URL: a data URL of a large export is a
 * megabytes-long string the browser has to parse, and some of them simply
 * refuse past a size the ledger will reach.
 */
export function save(download: DownloadableExport): void {
  const url = URL.createObjectURL(download.blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = download.filename;
  link.click();

  // Freed on the next turn: revoking immediately can cancel the download in
  // browsers that fetch the URL asynchronously.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * Open the report in a window the user can print to PDF.
 *
 * Written with `srcdoc` into an iframe rather than a popup: popups are blocked
 * by default in most browsers, and a report the user cannot see is not an
 * export.
 */
export function printReport(html: string): void {
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '100%';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.srcdoc = html;

  frame.addEventListener('load', () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => {
      frame.remove();
    }, 60_000);
  });

  document.body.append(frame);
}

function stamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}
