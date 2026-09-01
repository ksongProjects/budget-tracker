import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import type { MinorUnits } from '@budget/schema';
import { buildReceiptTable, fillTable, renderTable, tableTotals } from './table.js';
import type { StructuredCandidate } from './llm/types.js';
import type { OcrLine, OcrResult } from './types.js';

/**
 * The same recorded ML Kit geometry the rules are tested against
 * (receipt.mlkit.test.ts): a real engine emits the label column and the amount
 * column as separate lines, and a table built from fixture text with both on
 * one line would prove nothing about the device.
 */

const PAGE_HEIGHT = 900;
const row = (y: number): number => y / PAGE_HEIGHT;

const line = (text: string, y: number, x: number, width: number): OcrLine => ({
  text,
  box: { x, y: row(y), width, height: row(28) },
});

const USD = CurrencySchema.parse('USD');
const minor = (value: number): MinorUnits => value as MinorUnits;

const RECEIPT: OcrResult = {
  engine: 'mlkit',
  durationMs: 519,
  lines: [
    line('BLUE BOTTLE COFFEE', 40, 0.06, 0.52),
    line('66 Mint St', 110, 0.06, 0.22),
    line('San Francisco, CA', 150, 0.06, 0.38),
    line('03/14/2026', 190, 0.06, 0.25),
    line('1 Oat Latte', 270, 0.06, 0.24),
    line('1 Croissant', 310, 0.06, 0.24),
    line('SUBTOTAL', 390, 0.06, 0.2),
    line('TAX', 430, 0.06, 0.08),
    line('TOTAL', 470, 0.06, 0.13),
    line('VISA ****4242', 550, 0.06, 0.28),
    line('Thank you!', 590, 0.06, 0.22),
    line('5.50', 270, 0.51, 0.09),
    line('4.25', 310, 0.51, 0.09),
    line('9.75', 390, 0.51, 0.09),
    line('0.85', 430, 0.51, 0.09),
    line('10.60', 470, 0.49, 0.11),
  ],
};

describe('buildReceiptTable', () => {
  it('pairs each label with the amount on its row', () => {
    const table = buildReceiptTable(RECEIPT);

    expect(table.rows.map((r) => [r.label, r.amount])).toEqual([
      ['Oat Latte', 550],
      ['Croissant', 425],
      ['SUBTOTAL', 975],
      ['TAX', 85],
      ['TOTAL', 1060],
    ]);
  });

  it('reads the quantity a till prints in front of the name', () => {
    const table = buildReceiptTable(RECEIPT);

    expect(table.rows[0]?.quantity).toBe(1);
  });

  it('classifies the tax, the subtotal and the total apart from the shopping', () => {
    const table = buildReceiptTable(RECEIPT);

    expect(table.rows.map((r) => r.kind)).toEqual(['item', 'item', 'subtotal', 'tax', 'total']);
  });

  it('keeps everything above the first price as header, not as rows', () => {
    const table = buildReceiptTable(RECEIPT);

    expect(table.header).toEqual([
      'BLUE BOTTLE COFFEE',
      '66 Mint St',
      'San Francisco, CA',
      '03/14/2026',
    ]);
  });

  it('drops the card line and the pleasantry below the last price', () => {
    const table = buildReceiptTable(RECEIPT);

    expect(table.rows.map((r) => r.label)).not.toContain('Thank you!');
    expect(table.rows.some((r) => r.label.includes('VISA'))).toBe(false);
  });

  it('keeps a labelled row whose amount OCR never read, as a gap', () => {
    const withGap: OcrResult = {
      ...RECEIPT,
      // The croissant's amount line is lost, as a crease loses one.
      lines: RECEIPT.lines.filter((l) => l.text !== '4.25'),
    };

    const table = buildReceiptTable(withGap);
    const croissant = table.rows.find((r) => r.label === 'Croissant');

    expect(croissant?.amount).toBeNull();
    expect(croissant?.confidence).toBeLessThan(0.5);
    expect(tableTotals(table.rows).missing).toBe(1);
  });

  it('has no rows to show when nothing on the page carries a price', () => {
    const table = buildReceiptTable({
      engine: 'mlkit',
      durationMs: 3,
      lines: [line('BLUE BOTTLE COFFEE', 40, 0.06, 0.52), line('66 Mint St', 110, 0.06, 0.22)],
    });

    expect(table.rows).toEqual([]);
    expect(table.header).toHaveLength(2);
  });
});

describe('tableTotals', () => {
  it('adds the shopping and the tax, and leaves the subtotal out of it', () => {
    const totals = tableTotals(buildReceiptTable(RECEIPT).rows);

    expect(totals.itemsMinor).toBe(975);
    expect(totals.taxMinor).toBe(85);
    expect(totals.itemisedTotal).toBe(1060);
    expect(totals.statedTotal).toBe(1060);
    expect(totals.balanced).toBe(true);
  });

  it('reports the gap when a discount makes the rows overshoot', () => {
    const totals = tableTotals([
      {
        id: 'a',
        label: 'Steak',
        amount: minor(2000),
        quantity: null,
        kind: 'item',
        confidence: 0.8,
        source: 'ocr',
        evidence: 'Steak 20.00',
      },
      {
        id: 'b',
        label: 'DISCOUNT',
        amount: minor(-500),
        quantity: null,
        kind: 'discount',
        confidence: 0.8,
        source: 'ocr',
        evidence: 'DISCOUNT -5.00',
      },
      {
        id: 'c',
        label: 'TOTAL',
        amount: minor(1400),
        quantity: null,
        kind: 'total',
        confidence: 0.9,
        source: 'ocr',
        evidence: 'TOTAL 14.00',
      },
    ]);

    expect(totals.itemisedTotal).toBe(1500);
    expect(totals.balanced).toBe(false);
    expect(totals.differenceMinor).toBe(-100);
  });
});

describe('renderTable', () => {
  it('marks a missing value so a model is asked a narrow question', () => {
    const withGap: OcrResult = {
      ...RECEIPT,
      lines: RECEIPT.lines.filter((l) => l.text !== '4.25'),
    };

    const rendered = renderTable(buildReceiptTable(withGap), USD);

    expect(rendered).toContain('BLUE BOTTLE COFFEE');
    expect(rendered).toContain('\tCroissant (x1)\t?');
    expect(rendered).toContain('\tTOTAL\t10.60');
  });
});

describe('fillTable', () => {
  const structured = (items: readonly { description: string; amount: number }[]): StructuredCandidate => ({
    engine: 'test',
    durationMs: 1,
    lineItems: items.map((item) => ({
      value: { description: item.description, amount: minor(item.amount) },
      confidence: 0.7,
      evidence: item.description,
    })),
  });

  it('fills a gap the model priced, and says the model priced it', () => {
    const withGap = buildReceiptTable({
      ...RECEIPT,
      lines: RECEIPT.lines.filter((l) => l.text !== '4.25'),
    });

    const filled = fillTable(withGap, structured([{ description: 'Croissant', amount: 425 }]));
    const croissant = filled.rows.find((r) => r.label === 'Croissant');

    expect(croissant?.amount).toBe(425);
    expect(croissant?.source).toBe('model');
  });

  it('never overwrites a number the receipt actually printed', () => {
    const table = buildReceiptTable(RECEIPT);

    const filled = fillTable(table, structured([{ description: 'Oat Latte', amount: 999 }]));

    expect(filled.rows.find((r) => r.label === 'Oat Latte')?.amount).toBe(550);
    expect(filled.rows.find((r) => r.label === 'Oat Latte')?.source).toBe('ocr');
  });

  it('appends an item no row claimed rather than dropping it', () => {
    const table = buildReceiptTable(RECEIPT);

    const filled = fillTable(table, structured([{ description: 'Sparkling Water', amount: 300 }]));
    const added = filled.rows.at(-1);

    expect(added?.label).toBe('Sparkling Water');
    expect(added?.source).toBe('model');
    expect(added?.evidence).toBe('');
  });
});
