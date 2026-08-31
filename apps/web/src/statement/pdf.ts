import type { PdfDocument, PdfPage, PdfTextEngine, PdfTextItem } from '@budget/extract';

/**
 * Reading a PDF's text layer in the browser.
 *
 * Tier 1: the text is already in the file, so this is extraction rather than
 * recognition — no model, no cloud, nothing sent anywhere. A bank statement
 * that was generated rather than scanned carries a text layer, and that covers
 * the bulk of statement volume ([extraction.md](../../../../docs/extraction.md)).
 *
 * pdf.js is loaded on demand. It is a large dependency and only a visitor who
 * opens a PDF ever needs it; every other visit should not pay for it.
 */

/**
 * What pdf.js hands back for one run of text.
 *
 * Its own `TextItem` is only reachable through a deep path into the package's
 * generated types, which is a worse thing to depend on than four fields. The
 * union it returns also contains marked-content markers, which carry no text.
 */
interface TextRun {
  readonly str: string;
  readonly width: number;
  readonly height: number;
  /** [a, b, c, d, e, f] — e and f are the position. */
  readonly transform: readonly number[];
}

export const PDF_ENGINE_NAME = 'pdfjs';

export const pdfTextEngine: PdfTextEngine = {
  name: PDF_ENGINE_NAME,

  async extract(bytes: Uint8Array): Promise<PdfDocument> {
    const pdfjs = await import('pdfjs-dist');

    // The worker is bundled from the same dependency rather than fetched from a
    // CDN: the page's CSP allows no other origin, and a statement is not
    // something to hand to one anyway.
    pdfjs.GlobalWorkerOptions.workerSrc = (
      await import('pdfjs-dist/build/pdf.worker.mjs?url')
    ).default;

    const task = pdfjs.getDocument({
      data: bytes,
      // Fonts are irrelevant here and cost time on a large statement; only the
      // text layer is wanted.
      disableFontFace: true,
    });
    const loaded = await task.promise;

    const pages: PdfPage[] = [];

    for (let number = 1; number <= loaded.numPages; number += 1) {
      const page = await loaded.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const items: PdfTextItem[] = [];
      for (const entry of content.items) {
        if (!('str' in entry)) continue;

        const run = entry as TextRun;
        if (run.str.trim() === '') continue;

        items.push(toItem(run, viewport.height));
      }

      pages.push({ number, width: viewport.width, height: viewport.height, items });
    }

    // The loading task owns the worker; the document proxy does not. Leaving it
    // running would keep a worker per PDF the user opened.
    await task.destroy();

    return { pages, engine: PDF_ENGINE_NAME };
  },
};

/**
 * pdf.js reports positions from the bottom-left; the layout code works from the
 * top-left, like everything else that talks about a page. Flipping here keeps
 * that assumption in one place.
 */
function toItem(item: TextRun, pageHeight: number): PdfTextItem {
  const x = item.transform[4] ?? 0;
  const baseline = item.transform[5] ?? 0;

  return {
    text: item.str.trim(),
    x,
    y: pageHeight - baseline,
    width: item.width,
    height: item.height,
  };
}
