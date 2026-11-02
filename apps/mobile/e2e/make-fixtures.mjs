/* global Buffer, console, process */
/**
 * Writes the files the upload flow imports: a statement CSV, a PDF with a text
 * layer, and a scanned PDF whose only page is a JPEG — no text at all, so the
 * app has to draw it and read it with ML Kit.
 *
 * Each file holds different rows, so one import can never be mistaken for a
 * duplicate of another. The amounts are invented; real statements stay out of
 * the repository (docs/extraction.md).
 *
 *   node apps/mobile/e2e/make-fixtures.mjs
 *
 * The scan is rendered by the Playwright Chromium the web suite already
 * installs. The outputs are committed; rerun only to change them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const out = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(out, { recursive: true });

// --- CSV -----------------------------------------------------------------

writeFileSync(
  join(out, 'e2e-statement.csv'),
  [
    'Date,Description,Amount',
    '02/03/2026,SQ *TARTINE BAKERY,-18.50',
    '02/04/2026,SHELL OIL 5741,-40.00',
    '02/05/2026,NETFLIX.COM,-15.49',
    '',
  ].join('\n'),
);

// --- PDF with a text layer ----------------------------------------------

const PAGE_HEIGHT = 792;

/** A bank the shipped rule sets recognise, as in apps/web's PDF fixture. */
const TEXT_CELLS = [
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

const escape = (text) => text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');

/** Objects in order, with a real cross-reference table: pdf.js reads one. */
function pdfOf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n')];
  let length = chunks[0].length;
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const parts = [Buffer.from(`${String(index + 1)} 0 obj\n`), ...[object].flat(), Buffer.from('\nendobj\n')]
      .map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part)));
    for (const part of parts) {
      chunks.push(part);
      length += part.length;
    }
  }
  let tail = `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) tail += `${String(offset).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(length)}\n%%EOF\n`;
  chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}

const content = [
  'BT',
  '/F1 10 Tf',
  ...TEXT_CELLS.map((c) => `1 0 0 1 ${String(c.x)} ${String(PAGE_HEIGHT - c.y)} Tm (${escape(c.text)}) Tj`),
  'ET',
].join('\n');

writeFileSync(
  join(out, 'e2e-statement-text.pdf'),
  pdfOf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${String(PAGE_HEIGHT)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]),
);

// --- Scanned PDF: one JPEG page, no text ---------------------------------

const SCAN_ROWS = [
  ['2026-04-02', 'WHOLE FOODS MARKET', '-87.20'],
  ['2026-04-03', 'CHEVRON 0042', '-51.75'],
  ['2026-04-05', 'CITY PARKING', '-12.00'],
];

// Letter size at 200 dpi, which is what an office scanner produces.
const WIDTH = 1700;
const HEIGHT = 2200;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff;font:36px Arial,sans-serif;color:#111">
    <div style="position:absolute;left:110px;top:110px;font-size:48px">Community Credit Union</div>
    ${[['Date', 'Description', 'Amount'], ...SCAN_ROWS]
      .map(
        ([date, description, amount], row) => `
      <div style="position:absolute;top:${String(300 + row * 70)}px;left:110px">${date}</div>
      <div style="position:absolute;top:${String(300 + row * 70)}px;left:480px">${description}</div>
      <div style="position:absolute;top:${String(300 + row * 70)}px;left:1250px">${amount}</div>`,
      )
      .join('')}
  </body></html>`);
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 85 });

  const drawing = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
  writeFileSync(
    join(out, 'e2e-statement-scanned.pdf'),
    pdfOf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${String(drawing.length)} >>\nstream\n${drawing}\nendstream`,
      [
        `<< /Type /XObject /Subtype /Image /Width ${String(WIDTH)} /Height ${String(HEIGHT)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${String(jpeg.length)} >>\nstream\n`,
        jpeg,
        '\nendstream',
      ],
    ]),
  );
} finally {
  await browser.close();
}

console.log(`fixtures written to ${out}`);
process.exitCode = 0;
