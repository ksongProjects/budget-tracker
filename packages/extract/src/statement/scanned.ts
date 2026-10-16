import type { OcrResult } from '../types.js';
import type { PdfPage, PdfTextItem } from './layout.js';

/**
 * A scanned page, as if it had had a text layer.
 *
 * A scanned statement has no text in it — each page is a picture. The reader
 * draws the page at a known scale, OCR reads the picture, and this turns what
 * OCR found back into the page's own coordinates: points, origin top-left,
 * one item per word. From there it is the same layout code as a generated PDF,
 * which is the point — one idea of where the columns are, whatever made the
 * page.
 *
 * Words, not lines: a line of OCR across a statement runs through every
 * column, and the gaps between words are the only evidence of where one
 * column ends. Every word on a line shares the line's baseline, because the
 * layout groups by baseline and a word's own box drops with its descenders.
 */
export function pageFromOcr(
  result: OcrResult,
  page: { readonly number: number; readonly width: number; readonly height: number },
  /** Pixels in the OCR'd image per PDF point. */
  scale: number,
): PdfPage {
  const items: PdfTextItem[] = [];

  for (const line of result.lines) {
    if (line.box === undefined) continue;

    const baseline = (line.box.y + line.box.height) / scale;
    const height = line.box.height / scale;
    const words = line.words ?? [{ text: line.text, box: line.box }];

    for (const word of words) {
      const text = word.text.trim();
      if (text === '') continue;

      items.push({
        text,
        x: word.box.x / scale,
        y: baseline,
        width: word.box.width / scale,
        height,
      });
    }
  }

  return { number: page.number, width: page.width, height: page.height, items };
}

/**
 * Layout tolerances for pages read by OCR.
 *
 * A typeset page puts every cell of a row on exactly one baseline. A scan puts
 * them within a few pixels of each other — the page was not quite square in
 * the scanner, and OCR boxes each line on its own — so two cells of one row
 * must still count as one line.
 */
export const SCANNED_LAYOUT = { lineTolerance: 6 } as const;
