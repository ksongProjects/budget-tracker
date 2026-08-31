/**
 * The smallest PDF that carries a text layer, built at test time.
 *
 * Five objects — catalog, pages, page, content stream, font — with a real
 * cross-reference table, because pdf.js reads one. Uncompressed on purpose: a
 * fixture nobody can read is a fixture nobody can fix.
 *
 * Test-only. Nothing in the app imports it, so it is not in the bundle. Real
 * statements are personal financial documents and stay out of the repository
 * (docs/extraction.md); what is committed is the layout they share.
 */

export interface FixtureCell {
  readonly text: string;
  /** Points from the left of the page. */
  readonly x: number;
  /** Points from the *top* of the page, flipped on the way in. */
  readonly y: number;
}

export const FIXTURE_PAGE_HEIGHT = 792;

export function buildPdf(cells: readonly FixtureCell[]): Uint8Array {
  const content = [
    'BT',
    '/F1 10 Tf',
    ...cells.map(
      (cell) =>
        `1 0 0 1 ${String(cell.x)} ${String(FIXTURE_PAGE_HEIGHT - cell.y)} Tm ` +
        `(${escapeText(cell.text)}) Tj`,
    ),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${String(FIXTURE_PAGE_HEIGHT)}] ` +
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

  const startXref = pdf.length;
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(startXref)}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

/** Parentheses and backslashes end a string literal in a content stream. */
function escapeText(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

/** A statement from a bank the shipped rule sets recognise. */
export const RECOGNISED_STATEMENT: readonly FixtureCell[] = [
  { text: 'First National Bank', x: 40, y: 40 },

  { text: 'Date', x: 40, y: 110 },
  { text: 'Description', x: 160, y: 110 },
  { text: 'Amount', x: 420, y: 110 },

  { text: '2026-03-14', x: 40, y: 130 },
  { text: 'BLUE BOTTLE COFFEE', x: 160, y: 130 },
  { text: '-4.50', x: 420, y: 130 },

  { text: '2026-03-15', x: 40, y: 150 },
  { text: 'SAFEWAY', x: 160, y: 150 },
  { text: '-62.18', x: 420, y: 150 },

  { text: '2026-03-16', x: 40, y: 170 },
  { text: 'RENT MARCH', x: 160, y: 170 },
  { text: '-1850.00', x: 420, y: 170 },
];
