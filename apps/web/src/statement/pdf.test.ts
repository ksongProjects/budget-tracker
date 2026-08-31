import { describe, expect, it } from 'vitest';
import { matchRuleSet, readWithRuleSet, tableOfDocument } from '@budget/extract';
import { pdfTextEngine } from './pdf';
import { RECOGNISED_STATEMENT, buildPdf } from './pdf-fixture';

/**
 * A real PDF, read by the real pdf.js, in a real browser.
 *
 * Nothing here is recorded output: the file is built, parsed by the library the
 * app ships, and the result checked. A fixture of pre-extracted items would
 * only prove that the layout code agrees with itself.
 */

describe('reading a PDF text layer', () => {
  it('finds every run of text, positioned from the top-left', async () => {
    const document = await pdfTextEngine.extract(buildPdf(RECOGNISED_STATEMENT));

    expect(document.pages).toHaveLength(1);
    const items = document.pages[0]?.items ?? [];

    expect(items).toHaveLength(RECOGNISED_STATEMENT.length);

    // pdf.js reports this near 752 from the bottom; the flip is what lets the
    // layout code talk about a page the way a reader does.
    const heading = items.find((item) => item.text === 'First National Bank');
    expect(heading?.y).toBeGreaterThan(30);
    expect(heading?.y).toBeLessThan(60);
  });

  it('becomes the same table a CSV would', async () => {
    const table = tableOfDocument(await pdfTextEngine.extract(buildPdf(RECOGNISED_STATEMENT)));

    expect(table.header).toEqual(['Date', 'Description', 'Amount']);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]).toEqual(['2026-03-14', 'BLUE BOTTLE COFFEE', '-4.50']);
    expect(table.rows[2]).toEqual(['2026-03-16', 'RENT MARCH', '-1850.00']);
  });

  it('reads a description containing the characters a PDF uses for its own syntax', async () => {
    const awkward = [
      { text: 'Date', x: 40, y: 110 },
      { text: 'Description', x: 160, y: 110 },
      { text: 'Amount', x: 420, y: 110 },
      { text: '2026-03-14', x: 40, y: 130 },
      { text: 'CAFE (BRANCH 12)', x: 160, y: 130 },
      { text: '-4.50', x: 420, y: 130 },
    ];

    const table = tableOfDocument(await pdfTextEngine.extract(buildPdf(awkward)));

    expect(table.rows[0]?.[1]).toBe('CAFE (BRANCH 12)');
  });

  it('is read by the rule set for the bank that wrote it', async () => {
    // The letterhead says First National, and that rule set knows the column
    // names, the date order and the currency without being asked.
    const document = await pdfTextEngine.extract(buildPdf(RECOGNISED_STATEMENT));
    const ruleSet = matchRuleSet(document);

    expect(ruleSet?.id).toBe('example-first-national');
    if (ruleSet === undefined) return;

    const reading = readWithRuleSet(document, ruleSet);

    expect(reading?.dateOrder).toBe('ymd');
    expect(reading?.currency).toBe('USD');
    expect(reading?.table.rows).toHaveLength(3);
  });

  it('refuses something that is not a PDF at all', async () => {
    await expect(
      pdfTextEngine.extract(new TextEncoder().encode('this is not a PDF')),
    ).rejects.toThrow();
  });
});
