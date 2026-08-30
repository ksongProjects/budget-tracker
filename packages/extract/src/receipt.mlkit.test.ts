import { describe, expect, it } from 'vitest';
import { extractReceipt, mergeColumns } from './receipt.js';
import type { OcrLine, OcrResult } from './types.js';

/**
 * The shape ML Kit actually returns, recorded from a device run against
 * `apps/mobile/assets/test-receipt.png`.
 *
 * The engine emits the label column and the amount column as separate lines —
 * 12 left-column entries plus 5 amount-only lines, 17 in total, which is
 * exactly what the device reported. The rules were originally written against
 * fixture text with labels and amounts on one line, and silently found no tax
 * at all on real output.
 *
 * Page coordinates are normalized 0–1. The receipt was rendered 700x900 with
 * the header at y=40 and body lines every 40px from y=110, so these are the
 * real positions rather than invented ones.
 */

const PAGE_HEIGHT = 900;
const row = (y: number): number => y / PAGE_HEIGHT;

const line = (text: string, y: number, x: number, width: number): OcrLine => ({
  text,
  box: { x, y: row(y), width, height: row(28) },
});

/** Left column at x≈0.06, amounts right-aligned near x≈0.5. */
const MLKIT_RECEIPT: OcrResult = {
  engine: 'mlkit',
  durationMs: 519,
  lines: [
    line('BLUE BOTTLE COFFEE', 40, 0.06, 0.52),
    line('66 Mint St', 110, 0.06, 0.22),
    line('San Francisco, CA', 150, 0.06, 0.38),
    line('03/14/2026', 190, 0.06, 0.25),
    line('09:12 AM', 190, 0.36, 0.18),
    line('1 Oat Latte', 270, 0.06, 0.24),
    line('1 Croissant', 310, 0.06, 0.24),
    line('SUBTOTAL', 390, 0.06, 0.2),
    line('TAX', 430, 0.06, 0.08),
    line('TOTAL', 470, 0.06, 0.13),
    line('VISA ****4242', 550, 0.06, 0.28),
    line('Thank you!', 590, 0.06, 0.22),
    // The amount column, emitted separately.
    line('5.50', 270, 0.51, 0.09),
    line('4.25', 310, 0.51, 0.09),
    line('9.75', 390, 0.51, 0.09),
    line('0.85', 430, 0.51, 0.09),
    line('10.60', 470, 0.49, 0.11),
  ],
};

describe('mergeColumns', () => {
  it('pairs an amount with the label sharing its row', () => {
    const merged = mergeColumns(MLKIT_RECEIPT.lines);
    const texts = merged.map((l) => l.text);

    expect(texts).toContain('TAX 0.85');
    expect(texts).toContain('TOTAL 10.60');
    expect(texts).toContain('SUBTOTAL 9.75');
    expect(texts).toContain('1 Oat Latte 5.50');
  });

  it('consumes each amount once', () => {
    const merged = mergeColumns(MLKIT_RECEIPT.lines);
    // 17 lines in, 5 amounts merged away, 12 out.
    expect(merged).toHaveLength(12);
  });

  it('leaves lines that already carry an amount alone', () => {
    const merged = mergeColumns([
      { text: 'TOTAL 10.60', box: { x: 0.06, y: 0.5, width: 0.5, height: 0.03 } },
    ]);
    expect(merged.map((l) => l.text)).toEqual(['TOTAL 10.60']);
  });

  it('does nothing without boxes, rather than guessing at pairings', () => {
    const lines: OcrLine[] = [{ text: 'TAX' }, { text: '0.85' }];
    expect(mergeColumns(lines).map((l) => l.text)).toEqual(['TAX', '0.85']);
  });

  it('does not pair across rows', () => {
    const merged = mergeColumns([
      line('TAX', 430, 0.06, 0.08),
      line('10.60', 470, 0.49, 0.11),
    ]);
    // Different rows: pairing these would file the total as tax.
    expect(merged.map((l) => l.text)).toEqual(['TAX', '10.60']);
  });

  it('keeps a non-amount line on the same row from being swallowed', () => {
    const merged = mergeColumns([
      line('03/14/2026', 190, 0.06, 0.25),
      line('09:12 AM', 190, 0.36, 0.18),
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('extraction from real ML Kit output', () => {
  const result = extractReceipt(MLKIT_RECEIPT);

  it('reads the total from its label, not from a guess', () => {
    expect(result.total?.value).toBe(1060);
    // Before column merging this fell through to "largest amount", which
    // happened to be right here and would not be on a receipt with a big
    // single line item.
    expect(result.total?.confidence).toBeGreaterThan(0.5);
  });

  it('reads the tax, which was missed entirely on the device', () => {
    expect(result.tax?.value).toBe(85);
  });

  it('still reads merchant, card, and date', () => {
    expect(result.merchant?.value).toBe('BLUE BOTTLE COFFEE');
    expect(result.cardLast4?.value).toBe('4242');

    const date = new Date(result.occurredAt?.value ?? 0);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(14);
  });

  it('does not mistake the subtotal for the total', () => {
    expect(result.total?.value).not.toBe(975);
  });
});
