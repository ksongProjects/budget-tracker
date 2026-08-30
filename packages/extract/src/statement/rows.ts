import { CurrencySchema, parseAmount } from '@budget/schema';
import type { Currency, MinorUnits } from '@budget/schema';
import type { ColumnMapping, CsvTable } from './csv.js';

/**
 * Turning a bank's cells into rows this app can reason about.
 *
 * Every ambiguity a statement carries is decided explicitly here, because the
 * alternative is deciding it by accident: `03/04/2026` is two different days
 * depending on the country, `1.234` is either a thousand or one and a bit, and
 * whether a debit arrives negative is a per-bank convention with no marker in
 * the file.
 *
 * A row that cannot be read is not skipped and not guessed at — it comes back
 * with a reason attached, so the import screen can show it and the user can
 * decide. Silently dropping rows from a bank statement is how a ledger ends up
 * quietly wrong.
 */

export type DateOrder = 'dmy' | 'mdy' | 'ymd';

export interface RowOptions {
  readonly mapping: ColumnMapping;
  /** How to read an ambiguous date. Detected where possible, asked for where not. */
  readonly dateOrder: DateOrder;
  /** Used when the file states no currency of its own. */
  readonly currency: Currency;
  /**
   * True when the bank writes spending as a positive number. Most write it
   * negative; the ones that do not are usually the ones with a separate credit
   * column.
   */
  readonly debitsArePositive?: boolean;
}

export interface StatementRow {
  readonly line: number;
  readonly occurredAt: number;
  readonly description: string;
  readonly amountMinor: MinorUnits;
  readonly currency: Currency;
}

export interface RowProblem {
  readonly line: number;
  readonly cells: readonly string[];
  readonly reason: string;
}

export interface ParsedRows {
  readonly rows: readonly StatementRow[];
  readonly problems: readonly RowProblem[];
}

export function readRows(table: CsvTable, options: RowOptions): ParsedRows {
  const rows: StatementRow[] = [];
  const problems: RowProblem[] = [];

  for (const [index, cells] of table.rows.entries()) {
    // Line numbers are what a user sees in a spreadsheet: one-based, header
    // included. Reporting a zero-based row index would send them to the wrong
    // line of a thousand-line file.
    const line = index + 2;
    const complain = (reason: string): void => {
      problems.push({ line, cells, reason });
    };

    if (cells.length !== table.header.length) {
      // A row that does not line up with the header is usually an unquoted
      // separator inside a field — a thousands comma, a comma in a memo —
      // which shifts every column after it. Read blindly, that is not an error
      // but a plausible wrong number: the amount becomes "1" and the
      // description becomes "850.00".
      complain(
        `this row has ${String(cells.length)} columns, the header has ${String(table.header.length)}`,
      );
      continue;
    }

    const occurredAt = parseDate(cell(cells, options.mapping.date), options.dateOrder);
    if (occurredAt === undefined) {
      complain(`could not read the date "${cell(cells, options.mapping.date)}"`);
      continue;
    }

    const currency = rowCurrency(cells, options);
    if (currency === undefined) {
      complain(`could not read the currency "${cell(cells, options.mapping.currency ?? -1)}"`);
      continue;
    }

    const amount = rowAmount(cells, options, currency);
    if (amount === undefined) {
      complain(`could not read the amount "${cell(cells, options.mapping.amount)}"`);
      continue;
    }

    const description = cell(cells, options.mapping.description).trim();
    if (description === '') {
      // A row with no description is not obviously a transaction, and importing
      // it would put an unlabelled amount in someone's ledger.
      complain('the description is empty');
      continue;
    }

    rows.push({ line, occurredAt, description, amountMinor: amount, currency });
  }

  return { rows, problems };
}

function cell(cells: readonly string[], index: number): string {
  return cells[index] ?? '';
}

function rowCurrency(cells: readonly string[], options: RowOptions): Currency | undefined {
  if (options.mapping.currency === undefined) return options.currency;

  const stated = cell(cells, options.mapping.currency).trim().toUpperCase();
  if (stated === '') return options.currency;

  const parsed = CurrencySchema.safeParse(stated);
  return parsed.success ? parsed.data : undefined;
}

function rowAmount(
  cells: readonly string[],
  options: RowOptions,
  currency: Currency,
): MinorUnits | undefined {
  const debit = parseMoney(cell(cells, options.mapping.amount), currency);

  if (options.mapping.credit !== undefined) {
    const credit = parseMoney(cell(cells, options.mapping.credit), currency);

    // Split columns: exactly one side carries the number. A row with both, or
    // with neither, is not something to interpret on the user's behalf.
    if (debit !== undefined && credit !== undefined) return undefined;
    if (credit !== undefined) return negate(credit);
    if (debit !== undefined) return debit;
    return undefined;
  }

  if (debit === undefined) return undefined;
  return options.debitsArePositive === true ? debit : negate(debit);
}

/** Money is branded, so flipping a sign goes through one checked place. */
function negate(amount: MinorUnits): MinorUnits {
  return (0 - amount) as MinorUnits;
}

/**
 * Money as banks write it.
 *
 * Accepts a leading or trailing currency symbol, thousands separators in either
 * convention, and parentheses for negatives — an accounting habit that survives
 * into plenty of exports. Returns undefined rather than zero for anything it
 * cannot read: a zero would import as a real transaction of no value.
 */
export function parseMoney(text: string, currency: Currency): MinorUnits | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;

  const negative = /^\(.*\)$/.test(trimmed) || trimmed.startsWith('-');
  const digits = trimmed.replace(/[^\d.,]/g, '');
  if (digits === '') return undefined;

  const normalised = normaliseSeparators(digits);
  if (normalised === undefined) return undefined;

  try {
    // The schema owns how a decimal becomes minor units, including how many of
    // them a currency has. Doing that arithmetic here would be a second, less
    // tested answer to a question that already has one.
    const scaled = parseAmount(normalised, currency);
    return negative ? negate(scaled) : scaled;
  } catch {
    return undefined;
  }
}

/**
 * Decide which separator is the decimal point.
 *
 * `1.234,56` and `1,234.56` are the same amount written by different countries,
 * and `1,234` is a thousand in one and one-and-a-bit in the other. The rule:
 * whichever separator appears last is the decimal one — unless the tail is not
 * a plausible fraction, in which case both are grouping.
 */
function normaliseSeparators(digits: string): string | undefined {
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');

  if (lastComma === -1 && lastDot === -1) return digits;

  const decimalAt = Math.max(lastComma, lastDot);
  const tail = digits.slice(decimalAt + 1);

  // Three digits after the final separator, with no other separator, is
  // grouping: "1,234" is a thousand, not one point two three four.
  const grouping = tail.length === 3 && lastComma !== lastDot ? lastComma === -1 || lastDot === -1 : false;
  if (grouping || tail.length > 2) {
    return digits.replaceAll(',', '').replaceAll('.', '');
  }

  const whole = digits.slice(0, decimalAt).replaceAll(',', '').replaceAll('.', '');
  if (whole === '' && tail === '') return undefined;

  return `${whole === '' ? '0' : whole}.${tail}`;
}

/**
 * Dates, in the order the file uses.
 *
 * ISO is recognised whatever the stated order, because `2026-03-04` is never
 * ambiguous. Everything else is read as told: a statement does not say which
 * convention it used, and guessing per row would put half a file in March and
 * half in April.
 */
export function parseDate(text: string, order: DateOrder): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return utc(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const parts = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(trimmed);
  if (!parts) return undefined;

  const [, first = '', second = '', third = ''] = parts;

  const [year, month, day] =
    order === 'ymd'
      ? [first, second, third]
      : order === 'dmy'
        ? [third, second, first]
        : [third, first, second];

  return utc(fullYear(Number(year)), Number(month), Number(day));
}

function fullYear(year: number): number {
  // Two-digit years appear in older exports. The window matters: 70 is 1970 and
  // 26 is 2026, which is the convention every other tool settled on.
  if (year >= 100) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

/**
 * Midday UTC, not midnight.
 *
 * A statement gives a calendar day with no time. Storing midnight puts the row
 * on the previous day for anyone west of UTC as soon as it is rendered in local
 * time, which is how an import silently moves a week's spending.
 */
function utc(year: number, month: number, day: number): number | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  const at = Date.UTC(year, month - 1, day, 12);
  const check = new Date(at);

  // Rejects 31 February, which Date would roll into March without complaint.
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;

  return at;
}
