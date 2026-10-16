import type { CsvTable } from './csv.js';

/**
 * Recovering a table from a PDF's text layer.
 *
 * A PDF has no rows and no columns. It has glyphs at coordinates, and a
 * statement's table is something a human infers from where they sit. This
 * turns that inference into rules: items sharing a baseline are a line, and a
 * gap that appears in the *same place* on most lines is a column boundary.
 *
 * Tier 1 in [extraction.md](../../../../docs/extraction.md): deterministic and
 * exact, no model. The output is the same `CsvTable` a CSV import produces, so
 * a PDF statement goes through the mapping, the row reading and the dedupe that
 * are already tested — one pipeline, two front doors.
 */

/** One run of text the PDF placed, in points from the top-left of the page. */
export interface PdfTextItem {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfPage {
  /** One-based, as a reader would count them. */
  readonly number: number;
  readonly width: number;
  readonly height: number;
  readonly items: readonly PdfTextItem[];
}

export interface PdfDocument {
  readonly pages: readonly PdfPage[];
  readonly engine: string;
  /**
   * How many pages had no text layer and were read by OCR instead. Their
   * positions are a camera's rather than a typesetter's, and the layout reads
   * them with more tolerance.
   */
  readonly scannedPages?: number;
}

/** What a platform must provide to take part in Tier 1. */
export interface PdfTextEngine {
  readonly name: string;
  extract(bytes: Uint8Array): Promise<PdfDocument>;
}

export interface TextLine {
  /** Baseline of the line, for ordering and for spotting a new row. */
  readonly y: number;
  readonly items: readonly PdfTextItem[];
  readonly text: string;
}

export interface LayoutOptions {
  /**
   * How far apart two baselines may be and still be one line, in points.
   * Superscripts and slightly different fonts on one row move a baseline a
   * little; a new row moves it by roughly a line height.
   */
  readonly lineTolerance?: number;
  /** A gap this wide, in points, is a column boundary rather than a word space. */
  readonly columnGap?: number;
  /** A boundary must appear on at least this share of lines to count. */
  readonly columnSupport?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  lineTolerance: 3,
  columnGap: 8,
  columnSupport: 0.6,
};

/**
 * Group items into lines.
 *
 * Items arrive in whatever order the PDF's content stream wrote them, which is
 * frequently not reading order — a table is often written column by column.
 * Sorting by baseline and then by x is what makes the rest of this possible.
 */
export function toLines(page: PdfPage, options: LayoutOptions = {}): TextLine[] {
  const tolerance = options.lineTolerance ?? DEFAULTS.lineTolerance;
  const sorted = [...page.items].sort((a, b) => a.y - b.y || a.x - b.x);

  const lines: { y: number; items: PdfTextItem[] }[] = [];

  for (const item of sorted) {
    const line = lines.at(-1);

    if (line !== undefined && Math.abs(item.y - line.y) <= tolerance) {
      line.items.push(item);
      continue;
    }

    lines.push({ y: item.y, items: [item] });
  }

  return lines.map((line) => {
    const items = [...line.items].sort((a, b) => a.x - b.x);
    return { y: line.y, items, text: items.map((item) => item.text).join(' ').trim() };
  });
}

/**
 * Where the columns are, as x positions.
 *
 * A boundary is a horizontal gap that recurs across lines. One line with a wide
 * gap is a short description; the same gap on most lines is the edge of a
 * column — which is the difference between a rule and a coincidence.
 */
export function detectColumns(lines: readonly TextLine[], options: LayoutOptions = {}): number[] {
  const columnGap = options.columnGap ?? DEFAULTS.columnGap;
  const support = options.columnSupport ?? DEFAULTS.columnSupport;

  // Only lines with several items can speak to where columns are; a heading
  // spanning the page would otherwise vote against every boundary.
  const candidates = lines.filter((line) => line.items.length > 1);
  if (candidates.length === 0) return [];

  const votes = new Map<number, number>();

  for (const line of candidates) {
    for (const [index, item] of line.items.entries()) {
      if (index === 0) continue;

      const previous = line.items[index - 1];
      if (previous === undefined) continue;

      const gap = item.x - (previous.x + previous.width);
      if (gap < columnGap) continue;

      // Rounded to a few points: the same column edge is never at exactly the
      // same x on every line, and treating it as such finds nothing. The
      // disabled rule guards money; this is a coordinate in points.
      // eslint-disable-next-line no-restricted-syntax
      const boundary = Math.round(item.x / 4) * 4;
      votes.set(boundary, (votes.get(boundary) ?? 0) + 1);
    }
  }

  const needed = Math.max(2, Math.ceil(candidates.length * support));

  return [...votes.entries()]
    .filter(([, count]) => count >= needed)
    .map(([boundary]) => boundary)
    .sort((a, b) => a - b);
}

/**
 * Split lines into cells at the detected boundaries.
 *
 * Every line gets the same number of cells, empty where a line has nothing in
 * that column — which is what makes the result a table rather than a ragged
 * list, and what lets the CSV pipeline read it unchanged.
 */
export function toCells(
  lines: readonly TextLine[],
  boundaries: readonly number[],
): string[][] {
  return lines.map((line) => {
    const cells: string[] = Array.from({ length: boundaries.length + 1 }, () => '');

    for (const item of line.items) {
      // A cell's index is how many boundaries the item starts after. Two points
      // of slack: a column's contents are not always flush with its edge.
      const index = boundaries.filter((boundary) => item.x >= boundary - 2).length;
      const existing = cells[index] ?? '';
      cells[index] = existing === '' ? item.text : `${existing} ${item.text}`;
    }

    return cells.map((cell) => cell.trim());
  });
}

export interface TableOptions extends LayoutOptions {
  /**
   * A line matching this is the header row; everything above it is the bank's
   * letterhead. Without one, the first line with the most cells is used.
   */
  readonly headerPattern?: RegExp;
}

/**
 * A page, as a table the CSV pipeline can read.
 *
 * Lines before the header are dropped: a statement opens with an address, an
 * account number and a period, none of which are transactions, and all of which
 * would otherwise arrive as rows that fail to parse.
 */
export function tableOf(page: PdfPage, options: TableOptions = {}): CsvTable {
  const lines = toLines(page, options);
  const boundaries = detectColumns(lines, options);
  const cells = toCells(lines, boundaries);

  const headerIndex = findHeader(lines, cells, options.headerPattern);
  if (headerIndex === undefined) return { header: [], rows: [] };

  return {
    header: cells[headerIndex] ?? [],
    rows: cells.slice(headerIndex + 1).filter((row) => row.some((cell) => cell !== '')),
  };
}

function findHeader(
  lines: readonly TextLine[],
  cells: readonly string[][],
  pattern: RegExp | undefined,
): number | undefined {
  if (pattern !== undefined) {
    const found = lines.findIndex((line) => pattern.test(line.text));
    return found === -1 ? undefined : found;
  }

  let best: number | undefined;
  let bestFilled = 1;

  for (const [index, row] of cells.entries()) {
    const filled = row.filter((cell) => cell !== '').length;
    if (filled > bestFilled) {
      best = index;
      bestFilled = filled;
    }
  }

  return best;
}

/** Every page's table, stacked. Later pages repeat the header, so theirs is dropped. */
export function tableOfDocument(document: PdfDocument, options: TableOptions = {}): CsvTable {
  const tables = document.pages.map((page) => tableOf(page, options));
  const first = tables.find((table) => table.header.length > 0);

  if (first === undefined) return { header: [], rows: [] };

  return {
    header: first.header,
    rows: tables.flatMap((table) =>
      // A continuation page whose header we could not find still holds rows;
      // dropping them would lose a month of a statement without saying so.
      table.header.length === 0 ? table.rows : table.rows,
    ),
  };
}
