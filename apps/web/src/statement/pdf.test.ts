import { describe, expect, it } from 'vitest';
import { tableOfDocument } from '@budget/extract';
import { pdfTextEngine } from './pdf';

/**
 * A real PDF, read by the real pdf.js, in a real browser.
 *
 * The fixture is built here rather than checked in as bytes so that what it
 * contains is legible: a header row and three transactions, placed at
 * coordinates the way a bank's generator would place them. Real statements stay
 * out of the repository (docs/extraction.md) — the conventions do not have to.
 */

/** Text to draw, in PDF user space: origin bottom-left, y counted upwards. */
interface Cell {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

const PAGE_HEIGHT = 792;

const CELLS: readonly Cell[] = [
  { text: 'First National Bank', x: 40, y: PAGE_HEIGHT - 40 },

  { text: 'Date', x: 40, y: PAGE_HEIGHT - 100 },
  { text: 'Description', x: 160, y: PAGE_HEIGHT - 100 },
  { text: 'Amount', x: 400, y: PAGE_HEIGHT - 100 },

  { text: '2026-03-14', x: 40, y: PAGE_HEIGHT - 120 },
  { text: 'BLUE BOTTLE COFFEE', x: 160, y: PAGE_HEIGHT - 120 },
  { text: '-4.50', x: 400, y: PAGE_HEIGHT - 120 },

  { text: '2026-03-15', x: 40, y: PAGE_HEIGHT - 140 },
  { text: 'SAFEWAY', x: 160, y: PAGE_HEIGHT - 140 },
  { text: '-62.18', x: 400, y: PAGE_HEIGHT - 140 },

  { text: '2026-03-16', x: 40, y: PAGE_HEIGHT - 160 },
  { text: 'RENT MARCH', x: 160, y: PAGE_HEIGHT - 160 },
  { text: '-1850.00', x: 400, y: PAGE_HEIGHT - 160 },
];

/**
 * The smallest PDF that carries a text layer.
 *
 * Five objects — catalog, pages, page, content stream, font — with a real
 * cross-reference table, because pdf.js reads one. Uncompressed on purpose: a
 * fixture nobody can read is a fixture nobody can fix.
 */
function buildPdf(cells: readonly Cell[]): Uint8Array {
  const content = [
    'BT',
    '/F1 10 Tf',
    ...cells.map((cell) => `1 0 0 1 ${String(cell.x)} ${String(cell.y)} Tm (${escape(cell.text)}) Tj`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${String(PAGE_HEIGHT)}] ` +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }

  const xref = pdf.length;
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(xref)}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

/** Parentheses and backslashes end a string literal in a content stream. */
function escape(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

describe('reading a PDF text layer', () => {
  it('finds every run of text, positioned from the top-left', async () => {
    const document = await pdfTextEngine.extract(buildPdf(CELLS));

    expect(document.pages).toHaveLength(1);
    const items = document.pages[0]?.items ?? [];

    expect(items).toHaveLength(CELLS.length);

    // The heading is near the top of the page in our coordinates, which is the
    // flip: pdf.js reports it near 752 from the bottom.
    const heading = items.find((item) => item.text === 'First National Bank');
    expect(heading?.y).toBeGreaterThan(30);
    expect(heading?.y).toBeLessThan(60);
  });

  it('becomes the same table a CSV would', async () => {
    const document = await pdfTextEngine.extract(buildPdf(CELLS));
    const table = tableOfDocument(document);

    expect(table.header).toEqual(['Date', 'Description', 'Amount']);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toEqual(['2026-03-14', 'BLUE BOTTLE COFFEE', '-4.50']);
    expect(table.rows[2]).toEqual(['2026-03-16', 'RENT MARCH', '-1850.00']);
  });

  it('reads a description containing the characters a PDF uses for its own syntax', async () => {
    const awkward = [
      { text: 'Date', x: 40, y: PAGE_HEIGHT - 100 },
      { text: 'Description', x: 160, y: PAGE_HEIGHT - 100 },
      { text: 'Amount', x: 400, y: PAGE_HEIGHT - 100 },
      { text: '2026-03-14', x: 40, y: PAGE_HEIGHT - 120 },
      { text: 'CAFE (BRANCH 12)', x: 160, y: PAGE_HEIGHT - 120 },
      { text: '-4.50', x: 400, y: PAGE_HEIGHT - 120 },
    ];

    const table = tableOfDocument(await pdfTextEngine.extract(buildPdf(awkward)));

    expect(table.rows[0]?.[1]).toBe('CAFE (BRANCH 12)');
  });

  it('refuses something that is not a PDF at all', async () => {
    await expect(
      pdfTextEngine.extract(new TextEncoder().encode('this is not a PDF')),
    ).rejects.toThrow();
  });
});
