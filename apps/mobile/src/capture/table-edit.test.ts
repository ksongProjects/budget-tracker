import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import type { MinorUnits } from '@budget/schema';
import { buildReceiptTable } from '@budget/extract';
import type { OcrResult } from '@budget/extract';
import {
  blankRow,
  editableTotals,
  readAmount,
  toDrafts,
  toEditable,
  unanswered,
} from './table-edit';
import type { EditableRow } from './table-edit';

const USD = CurrencySchema.parse('USD');
const JPY = CurrencySchema.parse('JPY');

const PAGE_HEIGHT = 900;
const line = (text: string, y: number, x: number): { text: string; box: { x: number; y: number; width: number; height: number } } => ({
  text,
  box: { x, y: y / PAGE_HEIGHT, width: 0.3, height: 28 / PAGE_HEIGHT },
});

const RECEIPT: OcrResult = {
  engine: 'mlkit',
  durationMs: 12,
  lines: [
    line('CAFE', 40, 0.06),
    line('Oat Latte', 270, 0.06),
    line('Croissant', 310, 0.06),
    line('TAX', 430, 0.06),
    line('TOTAL', 470, 0.06),
    line('5.50', 270, 0.51),
    line('0.85', 430, 0.51),
    line('10.60', 470, 0.49),
  ],
};

const row = (over: Partial<EditableRow> = {}): EditableRow => ({
  key: 'k',
  label: 'Oat Latte',
  amount: '5.50',
  quantity: null,
  kind: 'item',
  source: 'ocr',
  confidence: 0.8,
  ...over,
});

describe('readAmount', () => {
  it('reads what a user types, comma or point', () => {
    expect(readAmount('5.50', USD)).toBe(550);
    expect(readAmount('5,50', USD)).toBe(550);
    expect(readAmount(' 12 ', USD)).toBe(1200);
  });

  it('reads a discount as the negative it is', () => {
    expect(readAmount('-2.00', USD)).toBe(-200);
  });

  it('holds its judgement while a number is still being typed', () => {
    expect(readAmount('', USD)).toBeNull();
    expect(readAmount('-', USD)).toBeNull();
    expect(readAmount('5.', USD)).toBeNull();
  });

  it('refuses cents in a currency that has none', () => {
    expect(readAmount('500', JPY)).toBe(500);
    expect(readAmount('5.50', JPY)).toBeNull();
  });
});

describe('toEditable', () => {
  it('carries a row with no amount through as an empty field', () => {
    const rows = toEditable(buildReceiptTable(RECEIPT), USD);

    expect(rows.map((r) => [r.label, r.amount])).toEqual([
      ['Oat Latte', '5.50'],
      ['Croissant', ''],
      ['TAX', '0.85'],
      ['TOTAL', '10.60'],
    ]);
  });
});

describe('editableTotals', () => {
  it('adds what has been typed and ignores what has not', () => {
    const totals = editableTotals(toEditable(buildReceiptTable(RECEIPT), USD), USD);

    expect(totals.itemsMinor).toBe(550);
    expect(totals.itemisedTotal).toBe(635);
    expect(totals.statedTotal).toBe(1060);
    expect(totals.balanced).toBe(false);
    expect(totals.missing).toBe(1);
  });

  it('balances once the missing row is filled in', () => {
    const rows = toEditable(buildReceiptTable(RECEIPT), USD).map((r) =>
      r.label === 'Croissant' ? { ...r, amount: '4.25', source: 'user' as const } : r,
    );

    expect(editableTotals(rows, USD).balanced).toBe(true);
  });
});

describe('toDrafts', () => {
  it('keeps the shopping and the tax, and leaves the total to the transaction', () => {
    const rows = toEditable(buildReceiptTable(RECEIPT), USD).map((r) =>
      r.label === 'Croissant' ? { ...r, amount: '4.25' } : r,
    );

    expect(toDrafts(rows, USD).map((d) => [d.kind, d.name, d.totalMinor])).toEqual([
      ['item', 'Oat Latte', 550],
      ['item', 'Croissant', 425],
      ['tax', 'TAX', 85],
    ]);
  });

  it('writes no row for a question the user never answered', () => {
    expect(toDrafts([row({ amount: '' }), blankRow('u1')], USD)).toEqual([]);
  });

  it('writes no row for an amount with no name', () => {
    expect(toDrafts([row({ label: '  ', amount: '3.00' })], USD)).toEqual([]);
  });

  it('carries a quantity the till printed', () => {
    expect(toDrafts([row({ quantity: 2 })], USD)[0]?.quantity).toBe(2);
  });
});

describe('unanswered', () => {
  it('counts named rows with no number, and not blank ones', () => {
    const rows = [row({ key: 'a', amount: '' }), blankRow('b'), row({ key: 'c' })];

    expect(unanswered(rows, USD)).toBe(1);
  });
});

describe('blankRow', () => {
  it('belongs to the user from the moment it exists', () => {
    const fresh = blankRow('u1');

    expect(fresh.source).toBe('user');
    expect(fresh.amount).toBe('');
    expect(readAmount(fresh.amount, USD)).toBeNull();
  });
});

/** Guards the branded-type boundary: minor units never become floats in here. */
describe('amounts stay integers', () => {
  it('reads a three-decimal currency without rounding into one', () => {
    const KWD = CurrencySchema.parse('KWD');

    expect(readAmount('1.234', KWD)).toBe(1234 as MinorUnits);
    expect(readAmount('1.2345', KWD)).toBeNull();
  });
});
