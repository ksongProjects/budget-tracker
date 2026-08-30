/**
 * Reading a bank's CSV export.
 *
 * Tier 0 in [extraction.md](../../../../docs/extraction.md): structured input,
 * parsed directly, no inference. Banks disagree about almost everything —
 * column names, date order, whether a debit is negative, whether thousands are
 * separated by commas or dots — so nothing here guesses silently. What cannot
 * be read is reported as a problem on a row, and a row with a problem is not
 * imported.
 *
 * The parser is deliberately its own thing rather than a dependency: a CSV
 * library is a lot of surface for a format whose hard parts are quoting rules
 * that fit in thirty lines, and this package is bundled into an app that
 * promises to ship no third-party scripts.
 */

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * Split CSV text into cells, per RFC 4180.
 *
 * Handles quoted fields containing commas, escaped quotes (`""`), and both
 * line-ending conventions. A quoted field may span lines, which is how a
 * multi-line memo arrives from a bank that allows one.
 */
export function parseCsv(text: string): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let index = 0;

  // A byte-order mark survives every export path and would otherwise become
  // part of the first column's name, so the header never matches.
  const input = text.startsWith('﻿') ? text.slice(1) : text;

  const endCell = (): void => {
    row.push(cell);
    cell = '';
  };

  const endRow = (): void => {
    endCell();
    // Trailing newlines are normal; a row of one empty cell is not data.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const char = input[index] ?? '';

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += char;
      index += 1;
      continue;
    }

    if (char === '"' && cell === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endCell();
      index += 1;
      continue;
    }
    if (char === '\r') {
      index += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }

    cell += char;
    index += 1;
  }

  if (cell !== '' || row.length > 0) endRow();

  const [header = [], ...body] = rows;
  return { header, rows: body };
}

/** Which column means what. Indexes into the header, so a bank's own names never leak inward. */
export interface ColumnMapping {
  readonly date: number;
  readonly amount: number;
  readonly description: number;
  /** Some exports split money across two columns instead of signing one. */
  readonly credit?: number;
  /** Present when the file states a currency per row. */
  readonly currency?: number;
}

export interface MappingGuess extends Partial<ColumnMapping> {
  /** Columns the guess could not place, for the mapping UI to offer. */
  readonly unmatched: readonly string[];
}

const DATE_NAMES = ['date', 'transaction date', 'posted date', 'posting date', 'value date'];
const AMOUNT_NAMES = ['amount', 'value', 'debit', 'withdrawal', 'money out'];
const CREDIT_NAMES = ['credit', 'deposit', 'money in'];
const DESCRIPTION_NAMES = ['description', 'details', 'memo', 'narrative', 'payee', 'merchant', 'name'];
const CURRENCY_NAMES = ['currency', 'ccy'];

/**
 * A first guess at the mapping, from the header row.
 *
 * Only ever a suggestion: the user confirms it before anything is imported.
 * Guessing wrong is cheap when someone is looking at the result; guessing
 * silently would put a posting date in an amount column.
 */
export function guessMapping(header: readonly string[]): MappingGuess {
  const normalised = header.map((name) => name.trim().toLowerCase());
  const taken = new Set<number>();

  const find = (names: readonly string[]): number | undefined => {
    for (const name of names) {
      const index = normalised.indexOf(name);
      if (index !== -1 && !taken.has(index)) {
        taken.add(index);
        return index;
      }
    }

    // Fall back to a contained word, which catches "Transaction Amount (USD)".
    for (const name of names) {
      const index = normalised.findIndex((column) => column.includes(name));
      if (index !== -1 && !taken.has(index)) {
        taken.add(index);
        return index;
      }
    }

    return undefined;
  };

  const date = find(DATE_NAMES);
  const amount = find(AMOUNT_NAMES);
  const credit = find(CREDIT_NAMES);
  const description = find(DESCRIPTION_NAMES);
  const currency = find(CURRENCY_NAMES);

  return {
    ...(date === undefined ? {} : { date }),
    ...(amount === undefined ? {} : { amount }),
    ...(credit === undefined ? {} : { credit }),
    ...(description === undefined ? {} : { description }),
    ...(currency === undefined ? {} : { currency }),
    unmatched: header.filter((_, index) => !taken.has(index)),
  };
}

export function isComplete(mapping: Partial<ColumnMapping>): mapping is ColumnMapping {
  return (
    mapping.date !== undefined &&
    mapping.amount !== undefined &&
    mapping.description !== undefined
  );
}
