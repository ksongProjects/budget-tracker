import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import { detectColumns, tableOf, tableOfDocument, toLines } from './layout.js';
import type { PdfPage, PdfTextItem } from './layout.js';
import { guessMapping, isComplete } from './csv.js';
import { readRows } from './rows.js';

/**
 * A PDF has no rows and no columns — only glyphs at coordinates. These fixtures
 * are what a text layer actually looks like: items in the order a content
 * stream wrote them, which is often column by column rather than in reading
 * order.
 */

const USD = CurrencySchema.parse('USD');

function item(text: string, x: number, y: number, width = text.length * 5): PdfTextItem {
  return { text, x, y, width, height: 10 };
}

function page(items: readonly PdfTextItem[]): PdfPage {
  return { number: 1, width: 612, height: 792, items };
}

/** A statement: letterhead, a header row, three transactions. */
const STATEMENT = page([
  item('First National Bank', 40, 40),
  item('Statement for account 1234', 40, 56),

  item('Date', 40, 100),
  item('Description', 120, 100),
  item('Amount', 400, 100),

  item('2026-03-14', 40, 120),
  item('BLUE BOTTLE COFFEE', 120, 120),
  item('-4.50', 400, 120),

  item('2026-03-15', 40, 140),
  item('SAFEWAY', 120, 140),
  item('-62.18', 400, 140),

  item('2026-03-16', 40, 160),
  item('RENT MARCH', 120, 160),
  item('-1850.00', 400, 160),
]);

describe('finding lines', () => {
  it('groups items that share a baseline', () => {
    const lines = toLines(STATEMENT);

    expect(lines).toHaveLength(6);
    expect(lines[2]?.text).toBe('Date Description Amount');
  });

  it('reads in reading order however the file was written', () => {
    // Written column by column, which is common and would otherwise come out
    // as three lines of dates followed by three lines of amounts.
    const columnMajor = page([
      item('2026-03-14', 40, 120),
      item('2026-03-15', 40, 140),
      item('BLUE BOTTLE', 120, 120),
      item('SAFEWAY', 120, 140),
      item('-4.50', 400, 120),
      item('-62.18', 400, 140),
    ]);

    expect(toLines(columnMajor).map((line) => line.text)).toEqual([
      '2026-03-14 BLUE BOTTLE -4.50',
      '2026-03-15 SAFEWAY -62.18',
    ]);
  });

  it('keeps a baseline that wobbles slightly on one line', () => {
    const wobbly = page([item('A', 40, 120), item('B', 120, 121.5), item('C', 400, 119)]);

    expect(toLines(wobbly)).toHaveLength(1);
  });

  it('separates lines a line-height apart', () => {
    const twoLines = page([item('A', 40, 120), item('B', 40, 140)]);

    expect(toLines(twoLines)).toHaveLength(2);
  });
});

describe('finding columns', () => {
  it('finds the boundaries that recur down the page', () => {
    const boundaries = detectColumns(toLines(STATEMENT));

    // Two boundaries: description starts near 120, amount near 400.
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toBeGreaterThan(100);
    expect(boundaries[1]).toBeGreaterThan(380);
  });

  it('ignores a gap that happens on only one line', () => {
    // One wide gap is a short description, not a column.
    const oddity = page([
      item('2026-03-14', 40, 120),
      item('COFFEE', 120, 120),
      item('2026-03-15', 40, 140),
      item('A', 120, 140),
      item('LATE', 300, 140),
      item('2026-03-16', 40, 160),
      item('RENT', 120, 160),
    ]);

    expect(detectColumns(toLines(oddity))).toEqual([120]);
  });

  it('has nothing to say about a page with no table', () => {
    expect(detectColumns(toLines(page([item('Just a sentence here', 40, 40)])))).toEqual([]);
  });
});

describe('a page as a table', () => {
  it('drops the letterhead and keeps the transactions', () => {
    const table = tableOf(STATEMENT);

    expect(table.header).toEqual(['Date', 'Description', 'Amount']);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toEqual(['2026-03-14', 'BLUE BOTTLE COFFEE', '-4.50']);
  });

  it('takes the header the caller names, when the guess would be wrong', () => {
    const table = tableOf(STATEMENT, { headerPattern: /^Date\b/ });

    expect(table.header[0]).toBe('Date');
    expect(table.rows).toHaveLength(3);
  });

  it('gives every row the same shape, with gaps left empty', () => {
    // A statement with one row missing its description. The column is known
    // because the other rows agree on it — one row alone could not establish
    // it, and inventing it from a single gap is how a table gets misread.
    const ragged = page([
      item('Date', 40, 100),
      item('Description', 120, 100),
      item('Amount', 400, 100),
      item('2026-03-14', 40, 120),
      item('COFFEE', 120, 120),
      item('-4.50', 400, 120),
      item('2026-03-15', 40, 140),
      item('-62.18', 400, 140),
    ]);

    const table = tableOf(ragged);

    expect(table.rows[0]).toEqual(['2026-03-14', 'COFFEE', '-4.50']);
    expect(table.rows[1]).toEqual(['2026-03-15', '', '-62.18']);
  });

  it('keeps a description that spills across a column gap together', () => {
    const wide = page([
      item('Date', 40, 100),
      item('Description', 120, 100),
      item('Amount', 400, 100),
      item('2026-03-14', 40, 120),
      item('BLUE BOTTLE', 120, 120),
      item('COFFEE', 200, 120),
      item('-4.50', 400, 120),
    ]);

    expect(tableOf(wide).rows[0]?.[1]).toBe('BLUE BOTTLE COFFEE');
  });
});

describe('a whole document', () => {
  it('stacks the pages and does not repeat the header', () => {
    const second = page([
      item('Date', 40, 100),
      item('Description', 120, 100),
      item('Amount', 400, 100),
      item('2026-03-20', 40, 120),
      item('SHELL', 120, 120),
      item('-40.00', 400, 120),
    ]);

    const table = tableOfDocument({ pages: [STATEMENT, second], engine: 'test' });

    expect(table.header).toEqual(['Date', 'Description', 'Amount']);
    expect(table.rows).toHaveLength(4);
  });
});

describe('a PDF through the CSV pipeline', () => {
  it('reads as transactions, with no PDF-specific path', () => {
    // The point of producing a CsvTable: a statement in a PDF and the same
    // statement as a CSV go through one mapping, one row reader, one dedupe.
    const table = tableOf(STATEMENT);
    const guess = guessMapping(table.header);

    expect(isComplete(guess)).toBe(true);
    if (!isComplete(guess)) return;

    const { rows, problems } = readRows(table, {
      mapping: guess,
      dateOrder: 'ymd',
      currency: USD,
    });

    expect(problems).toEqual([]);
    expect(rows.map((row) => row.amountMinor)).toEqual([450, 6218, 185000]);
    expect(rows[0]?.description).toBe('BLUE BOTTLE COFFEE');
  });
});
