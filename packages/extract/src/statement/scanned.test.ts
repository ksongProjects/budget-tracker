import { describe, expect, it } from 'vitest';
import type { OcrLine, OcrResult } from '../types.js';
import { pageFromOcr } from './scanned.js';
import { readStatementDocument } from './rules.js';

const SCALE = 2.5;
const PAGE = { number: 1, width: 612, height: 792 };

/**
 * A line as ML Kit reports it on a scan: one box per column group, each word
 * boxed on its own, and rows that are not quite level — the right-hand column
 * sits a few pixels lower than the left, as a page skewed in a scanner does.
 */
function line(y: number, words: readonly [string, number][], drift = 0): OcrLine {
  const boxes = words.map(([text, x]) => ({
    text,
    box: { x: x * SCALE, y: (y + drift) * SCALE, width: text.length * 5 * SCALE, height: 10 * SCALE },
  }));
  const first = boxes[0]?.box ?? { x: 0, y: 0, width: 0, height: 0 };
  const last = boxes.at(-1)?.box ?? first;

  return {
    text: words.map(([text]) => text).join(' '),
    box: { x: first.x, y: first.y, width: last.x + last.width - first.x, height: first.height },
    words: boxes,
  };
}

/** ML Kit splits a table into blocks per column, so each row arrives as three lines. */
function row(y: number, date: string, description: string, amount: string): OcrLine[] {
  let x = 150;
  const words = description.split(' ').map((word): [string, number] => {
    const at = x;
    x += word.length * 5 + 3;
    return [word, at];
  });

  return [line(y, [[date, 50]]), line(y, words, 0.8), line(y, [[amount, 450]], 1.6)];
}

const scan: OcrResult = {
  engine: 'mlkit',
  durationMs: 0,
  lines: [
    line(40, [
      ['First', 50],
      ['Example', 80],
      ['Bank', 125],
    ]),
    ...row(100, 'Date', 'Description', 'Amount'),
    ...row(118, '2026-10-01', 'SQ *BLUE BOTTLE 0412', '-4.50'),
    ...row(136, '2026-10-02', 'SHELL OIL 57442', '-40.00'),
  ],
};

describe('a scanned statement page', () => {
  it('comes back in page points, one item per word, on the line baseline', () => {
    const page = pageFromOcr(scan, PAGE, SCALE);
    const shell = page.items.find((item) => item.text === 'SHELL');

    expect(shell?.x).toBeCloseTo(150);
    // Each word sits on its own line's baseline: the bottom of the line box.
    expect(shell?.y).toBeCloseTo(136 + 0.8 + 10);
    expect(page.width).toBe(612);
  });

  it('reads as the same table a generated PDF would', () => {
    const reading = readStatementDocument({
      pages: [pageFromOcr(scan, PAGE, SCALE)],
      engine: 'pdfjs+mlkit',
      scannedPages: 1,
    });

    expect(reading?.table.header).toEqual(['Date', 'Description', 'Amount']);
    expect(reading?.table.rows).toEqual([
      ['2026-10-01', 'SQ *BLUE BOTTLE 0412', '-4.50'],
      ['2026-10-02', 'SHELL OIL 57442', '-40.00'],
    ]);
  });

  it('falls back to the line when the engine reports no words', () => {
    const page = pageFromOcr(
      {
        engine: 'mlkit',
        durationMs: 0,
        lines: [{ text: 'TOTAL 4.50', box: { x: 25, y: 50, width: 100, height: 25 } }],
      },
      PAGE,
      SCALE,
    );

    expect(page.items).toEqual([{ text: 'TOTAL 4.50', x: 10, y: 30, width: 40, height: 10 }]);
  });

  it('finds nothing in a page OCR found nothing on', () => {
    const reading = readStatementDocument({
      pages: [pageFromOcr({ engine: 'mlkit', durationMs: 0, lines: [] }, PAGE, SCALE)],
      engine: 'pdfjs+mlkit',
      scannedPages: 1,
    });
    expect(reading).toBeUndefined();
  });
});
