import { describe, expect, it } from 'vitest';
import { extractReceipt } from './receipt.js';
import { pageSlope, straighten } from './receipt-layout.js';
import { buildReceiptTable, tableTotals } from './table.js';
import { VALVOLINE_INVOICE } from './fixtures/real/valvoline-invoice.js';
import type { OcrLine, OcrResult } from './types.js';

/**
 * A real photo, not a fixture written to shape: see the fixture's own comment
 * for what it is and what it used to read as.
 */
const INVOICE: OcrResult = { engine: 'mlkit', durationMs: 5426, lines: VALVOLINE_INVOICE };

/** When the photo was taken: the day after the service. */
const TAKEN = new Date(2026, 10, 2, 13, 18).getTime();

describe('a tilted invoice photo with a card slip in frame', () => {
  const candidate = extractReceipt(INVOICE, { now: TAKEN });
  const table = buildReceiptTable(INVOICE);

  it('measures the tilt from the words', () => {
    const slope = pageSlope(VALVOLINE_INVOICE);
    expect(slope).toBeLessThan(-0.03);
    expect(slope).toBeGreaterThan(-0.06);
  });

  it('reads the merchant over its address, not the slip or the dashboard', () => {
    expect(candidate.merchant?.value).toBe('VALVOLINE EXPRESS CARE');
    expect(candidate.merchant?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('reads the labelled date with its time, settled by when the photo was taken', () => {
    const at = new Date(candidate.occurredAt?.value ?? 0);
    expect([at.getFullYear(), at.getMonth(), at.getDate()]).toEqual([2026, 10, 1]);
    expect([at.getHours(), at.getMinutes()]).toEqual([16, 43]);
    // Above the 0.7 below which the confirm screen calls the date ambiguous.
    expect(candidate.occurredAt?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('reads the printed total, not the largest amount', () => {
    expect(candidate.total?.value).toBe(26316);
    expect(candidate.total?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('adds both taxes', () => {
    expect(candidate.tax?.value).toBe(1645 + 1175);
  });

  it('lists the invoice lines and nothing from the checklist or the slip', () => {
    const items = table.rows.filter((row) => row.kind === 'item');
    expect(items.map((row) => row.label)).toEqual([
      'PREMIUM FULL SYNTHETIC PACKAGE',
      'SHOP SUPPLIES',
      'VO106 OIL FILTER',
      'VALVOLINE OW20 SYN BULK',
      'STANDARD CHECKLIST',
      'TIRE PRESSURE IS ===>',
      'BATTERY PASS',
      'WASHER FLUID',
      'FREE OIL TOP UP IN BETWEEN OIL CHANGES',
      'FREE AIR PRESSURE CHECK ANYTIME',
      'OIL DRAIN PLUG TORQUE SPECS',
      'VA464 AIR FILTER',
      'VCA1061 CABIN AIR FILTER',
    ]);
    expect(items.map((row) => row.amount)).toEqual([14299, 699, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4499, 6499]);
    expect(table.rows.some((row) => /CHECKED|N\/A|VISA|Method/i.test(row.label))).toBe(false);
  });

  it('keeps the discount negative and balances to the printed total', () => {
    const discount = table.rows.find((row) => row.kind === 'discount');
    expect(discount?.amount).toBe(-2500);

    const totals = tableTotals(table.rows);
    expect(totals.statedTotal).toBe(26316);
    expect(totals.balanced).toBe(true);
    expect(totals.missing).toBe(0);
  });

  it('reads the quantity column, not just the price', () => {
    expect(table.rows.find((row) => row.label === 'SHOP SUPPLIES')?.quantity).toBe(1);
  });
});

describe('tax', () => {
  it('does not count a "total tax" line that restates the others', () => {
    const tax = extractReceipt({
      engine: 't',
      durationMs: 0,
      lines: [{ text: 'GST 5.00' }, { text: 'PST 7.00' }, { text: 'TOTAL TAX 12.00' }, { text: 'TOTAL 112.00' }],
    }).tax;
    expect(tax?.value).toBe(1200);
  });
});

describe('straighten', () => {
  it('leaves a page without boxes in the order it came', () => {
    const lines: OcrLine[] = [{ text: 'B' }, { text: 'A' }];
    expect(straighten(lines).map((line) => line.text)).toEqual(['B', 'A']);
  });
});

describe('dates on their own', () => {
  const at = (text: string, now?: number): Date =>
    new Date(extractReceipt({ engine: 't', durationMs: 0, lines: [{ text }] }, now === undefined ? {} : { now }).occurredAt?.value ?? 0);

  it('keeps a printed time', () => {
    expect(at('03/14/2026 09:12 AM').getHours()).toBe(9);
    expect(at('14.03.2026 18:05').getHours()).toBe(18);
  });

  it('refuses a reading in the future', () => {
    // 4/9 is 9 April or 4 September; photographed in May, only April has happened.
    const may = new Date(2026, 4, 10).getTime();
    expect(at('4/9/2026', may).getMonth()).toBe(3);
    expect(at('9/4/2026', may).getMonth()).toBe(3);
  });

  it('still flags a date both readings of which are plausible', () => {
    const late = new Date(2026, 11, 20).getTime();
    const date = extractReceipt(
      { engine: 't', durationMs: 0, lines: [{ text: '03/04/2026' }] },
      { now: late },
    ).occurredAt;
    expect(date?.confidence).toBeLessThan(0.7);
  });
});
