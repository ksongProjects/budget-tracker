import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import { amountsIn, extractReceipt } from './receipt.js';
import type { OcrResult } from './types.js';

/**
 * Receipt text as an OCR engine would report it. These are shapes taken from
 * real receipts — the committed fixtures, since they carry no personal data.
 * The gitignored corpus of real scans is what tracks accuracy over time
 * (docs/extraction.md); these pin the rules.
 */
const ocr = (...lines: string[]): OcrResult => ({
  lines: lines.map((text) => ({ text })),
  engine: 'fixture',
  durationMs: 0,
});

describe('amountsIn', () => {
  it('reads amounts with and without a symbol', () => {
    expect(amountsIn('TOTAL $12.34')).toEqual([1234]);
    expect(amountsIn('TOTAL 12.34')).toEqual([1234]);
  });

  it('reads thousands separators', () => {
    expect(amountsIn('TOTAL $1,234.56')).toEqual([123456]);
  });

  it('reads a comma decimal separator', () => {
    expect(amountsIn('TOTAL 12,34')).toEqual([1234]);
  });

  it('reads the country some receipts print before the dollar sign as part of the price', () => {
    expect(amountsIn('CA$11.86')).toEqual([1186]);
    expect(amountsIn('US$5.00')).toEqual([500]);
    expect(amountsIn('NZ$ 4.50')).toEqual([450]);
  });

  it('reads CA$ through the misreads ML Kit makes of it in small print', () => {
    expect(amountsIn('CAŠ9.72')).toEqual([972]);
    expect(amountsIn('CAŠ 9.72')).toEqual([972]);
    expect(amountsIn('CAS10.66')).toEqual([1066]);
  });

  it('ignores numbers that are not money', () => {
    // Quantities, phone numbers, and street numbers must not become prices.
    expect(amountsIn('2 x Coffee')).toEqual([]);
    expect(amountsIn('555-1234')).toEqual([]);
    expect(amountsIn('123 Main Street')).toEqual([]);
    expect(amountsIn('Table 4')).toEqual([]);
  });

  it('returns every amount on a line, in order', () => {
    expect(amountsIn('2 @ 3.50 = 7.00')).toEqual([350, 700]);
  });

  it('never produces a float', () => {
    for (const amount of amountsIn('TOTAL $8.20')) {
      expect(Number.isInteger(amount)).toBe(true);
    }
    // 8.20 * 100 is 819.9999999999999 in floating point.
    expect(amountsIn('TOTAL $8.20')).toEqual([820]);
  });
});

describe('total', () => {
  it('reads a labelled total', () => {
    const result = extractReceipt(ocr('BLUE BOTTLE', 'Latte 5.50', 'TOTAL 5.50'));
    expect(result.total?.value).toBe(550);
  });

  it('prefers the total over the subtotal', () => {
    const result = extractReceipt(
      ocr('SUBTOTAL 10.00', 'TAX 0.88', 'TOTAL 10.88'),
    );
    expect(result.total?.value).toBe(1088);
  });

  it('prefers an explicit grand total over a bare total', () => {
    const result = extractReceipt(ocr('TOTAL 10.00', 'AMOUNT DUE 12.50'));
    expect(result.total?.value).toBe(1250);
  });

  it('reads "amount paid" as the total, the way order tickets print it', () => {
    const result = extractReceipt(ocr('Subtotal $47.19', 'Tax $2.36', 'Amount paid $49.55'));
    expect(result.total?.value).toBe(4955);
    expect(result.total?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('is not fooled by tax, tip, change, or cash lines', () => {
    const result = extractReceipt(
      ocr(
        'SUBTOTAL 20.00',
        'TAX 1.75',
        'TIP 4.00',
        'TOTAL 25.75',
        'CASH 30.00',
        'CHANGE 4.25',
      ),
    );
    expect(result.total?.value).toBe(2575);
  });

  it('takes the lower total when the word appears twice', () => {
    // Receipts often repeat the total in a card-authorization block below.
    const result = extractReceipt(ocr('TOTAL 25.75', 'CARD TOTAL 25.75'));
    expect(result.total?.value).toBe(2575);
  });

  it('takes the last amount on a total line', () => {
    const result = extractReceipt(ocr('TOTAL 3 ITEMS 25.75'));
    expect(result.total?.value).toBe(2575);
  });

  it('falls back to the largest amount, with low confidence', () => {
    const result = extractReceipt(ocr('BLUE BOTTLE', '5.50', '1.25'));
    expect(result.total?.value).toBe(550);
    expect(result.total?.confidence).toBeLessThan(0.5);
  });

  it('reports higher confidence for a labelled total than a guessed one', () => {
    const labelled = extractReceipt(ocr('TOTAL 5.50'));
    const guessed = extractReceipt(ocr('5.50'));
    expect(labelled.total?.confidence).toBeGreaterThan(guessed.total?.confidence ?? 1);
  });

  it('carries the line it read, so a wrong number is traceable', () => {
    const result = extractReceipt(ocr('BLUE BOTTLE', 'TOTAL DUE   12.34'));
    expect(result.total?.evidence).toBe('TOTAL DUE   12.34');
  });

  it('proposes nothing when there is nothing to read', () => {
    expect(extractReceipt(ocr('BLUE BOTTLE', 'Thank you')).total).toBeUndefined();
  });
});

describe('tax and tip', () => {
  it('reads tax', () => {
    expect(extractReceipt(ocr('TAX 1.75')).tax?.value).toBe(175);
    expect(extractReceipt(ocr('SALES TAX 1.75')).tax?.value).toBe(175);
    expect(extractReceipt(ocr('VAT 2.40')).tax?.value).toBe(240);
  });

  it('reads a tip', () => {
    expect(extractReceipt(ocr('TIP 4.00')).tip?.value).toBe(400);
    expect(extractReceipt(ocr('GRATUITY 4.00')).tip?.value).toBe(400);
  });
});

describe('currency', () => {
  it('reads a code the receipt actually prints', () => {
    expect(extractReceipt(ocr('SUMME EUR 12,34')).currency?.value).toBe('EUR');
    expect(extractReceipt(ocr('TOTAL CAD 12.34')).currency?.value).toBe('CAD');
  });

  it('ignores the symbol, which names no country', () => {
    // A dollar sign is printed by a dozen currencies. Reading it as USD put a
    // confidently wrong number in a Canadian ledger, which is how this rule
    // came to exist.
    expect(extractReceipt(ocr('TOTAL $12.34')).currency).toBeUndefined();
  });

  it('reads a country printed against the dollar sign as a statement', () => {
    expect(extractReceipt(ocr('Eggcellent CA$11.86')).currency?.value).toBe('CAD');
    expect(extractReceipt(ocr('Latte US$5.00')).currency?.value).toBe('USD');
  });

  it('leaves C$ alone, which Canada and Nicaragua both print', () => {
    expect(extractReceipt(ocr('Latte C$4.50')).currency).toBeUndefined();
  });

  it('proposes none when nothing states one and no default is given', () => {
    expect(extractReceipt(ocr('TOTAL 12.34')).currency).toBeUndefined();
  });
});

describe('date', () => {
  it('reads an ISO date confidently', () => {
    const result = extractReceipt(ocr('2026-03-14', 'TOTAL 5.50'));
    const date = new Date(result.occurredAt?.value ?? 0);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(14);
    expect(result.occurredAt?.confidence).toBeGreaterThan(0.8);
  });

  it('reads a slashed date', () => {
    const result = extractReceipt(ocr('03/14/2026', 'TOTAL 5.50'));
    const date = new Date(result.occurredAt?.value ?? 0);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(14);
  });

  it('reads a two-digit year', () => {
    const result = extractReceipt(ocr('03/14/26'));
    expect(new Date(result.occurredAt?.value ?? 0).getFullYear()).toBe(2026);
  });

  it('lowers confidence when day and month are ambiguous', () => {
    // 03/04/2026 is March 4th in the US and April 3rd in most of the world.
    const ambiguous = extractReceipt(ocr('03/04/2026'));
    const unambiguous = extractReceipt(ocr('03/14/2026'));

    expect(ambiguous.occurredAt?.confidence).toBeLessThan(
      unambiguous.occurredAt?.confidence ?? 0,
    );
  });

  it('reads a named month with its year, confidently', () => {
    const result = extractReceipt(ocr('September 12, 2026 7:59 PM'));
    const date = new Date(result.occurredAt?.value ?? 0);
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 8, 12]);
    expect(result.occurredAt?.confidence).toBeGreaterThan(0.8);
  });

  it('reads a named month printed after the day', () => {
    const date = new Date(extractReceipt(ocr('12 Sep 2026')).occurredAt?.value ?? 0);
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 8, 12]);
  });

  it('places a date printed without a year in the most recent past', () => {
    // An order ticket, "Placed at September 12, 7:59 PM", photographed the next night.
    const now = new Date(2026, 8, 13, 22, 45).getTime();
    const result = extractReceipt(ocr('Placed at September 12, 7:59 PM'), { now });
    const date = new Date(result.occurredAt?.value ?? 0);

    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 8, 12]);
    // Not flagged as day/month-ambiguous, which the confirm screen does below
    // 0.7: a named month cannot be swapped with the day.
    expect(result.occurredAt?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('does not date a year-less receipt in the future', () => {
    const now = new Date(2026, 0, 3, 9).getTime();
    const result = extractReceipt(ocr('Dec 30'), { now });
    expect(new Date(result.occurredAt?.value ?? 0).getFullYear()).toBe(2025);
  });

  it('leaves a year-less date unread when it does not know when the photo was taken', () => {
    expect(extractReceipt(ocr('Placed at September 12, 7:59 PM')).occurredAt).toBeUndefined();
  });

  it('does not read a time as the day of a named month', () => {
    const now = new Date(2026, 8, 13).getTime();
    expect(extractReceipt(ocr('Mar 7:59'), { now }).occurredAt).toBeUndefined();
  });

  it('skips a named date that does not exist', () => {
    expect(extractReceipt(ocr('February 30, 2026')).occurredAt).toBeUndefined();
  });

  it('skips an impossible date rather than inventing one', () => {
    expect(extractReceipt(ocr('99/99/2026')).occurredAt).toBeUndefined();
  });
});

describe('merchant', () => {
  it('reads the shop name from the header', () => {
    const result = extractReceipt(
      ocr('BLUE BOTTLE COFFEE', '123 Main Street', '555-1234', 'TOTAL 5.50'),
    );
    expect(result.merchant?.value).toBe('BLUE BOTTLE COFFEE');
  });

  it('skips receipt boilerplate', () => {
    const result = extractReceipt(ocr('RECEIPT', 'CUSTOMER COPY', 'TARTINE BAKERY'));
    expect(result.merchant?.value).toBe('TARTINE BAKERY');
  });

  it('skips a line that is mostly digits', () => {
    const result = extractReceipt(ocr('555-123-4567', 'TARTINE BAKERY'));
    expect(result.merchant?.value).toBe('TARTINE BAKERY');
  });

  it('does not read an amount as a merchant', () => {
    const result = extractReceipt(ocr('12.34', 'TARTINE BAKERY'));
    expect(result.merchant?.value).toBe('TARTINE BAKERY');
  });

  it('skips the customer and field lines an order ticket prints at the top', () => {
    const result = extractReceipt(
      ocr('New customer', 'Disposable items: No', 'Store#: 40832', 'TARTINE BAKERY'),
    );
    expect(result.merchant?.value).toBe('TARTINE BAKERY');
  });

  it('prefers the business that signs off at the bottom over a person at the top', () => {
    const result = extractReceipt(
      ocr(
        'Alex P. 123AB',
        'New customer',
        '1 x Latte CA$5.00',
        'Amount paid $5.00',
        'Thank you for ordering from Sweet Cafe',
      ),
    );
    expect(result.merchant?.value).toBe('Sweet Cafe');
  });

  it('reads a sign-off whose name wrapped onto the next line', () => {
    const result = extractReceipt(ocr('Alex P. 123AB', 'Thank you for ordering from', 'Sweet Cafe'));
    expect(result.merchant?.value).toBe('Sweet Cafe');
  });

  it('does not take "us" for a business', () => {
    const result = extractReceipt(ocr('BLUE BOTTLE COFFEE', 'Thank you for shopping with us!'));
    expect(result.merchant?.value).toBe('BLUE BOTTLE COFFEE');
  });

  it('only looks near the top, where the name is printed', () => {
    const result = extractReceipt(
      ocr('1', '2', '3', '4', '5', 'BURIED MERCHANT NAME'),
    );
    expect(result.merchant?.value).not.toBe('BURIED MERCHANT NAME');
  });
});

describe('card last 4', () => {
  it('reads masked digits', () => {
    expect(extractReceipt(ocr('VISA ****4242')).cardLast4?.value).toBe('4242');
    expect(extractReceipt(ocr('XXXX4242')).cardLast4?.value).toBe('4242');
    expect(extractReceipt(ocr('Card ending in 4242')).cardLast4?.value).toBe('4242');
  });

  it('proposes none when no card line is printed', () => {
    expect(extractReceipt(ocr('TOTAL 5.50')).cardLast4).toBeUndefined();
  });
});

describe('a whole receipt', () => {
  it('reads the fields a user would check', () => {
    const result = extractReceipt(
      ocr(
        'BLUE BOTTLE COFFEE',
        '66 Mint St',
        'San Francisco, CA',
        '03/14/2026  09:12 AM',
        '',
        '1 Oat Latte        5.50',
        '1 Croissant        4.25',
        '',
        'SUBTOTAL           9.75',
        'TAX                0.85',
        'TOTAL             $10.60',
        'VISA ****4242',
        'Thank you!',
      ),
    );

    expect(result.total?.value).toBe(1060);
    expect(result.tax?.value).toBe(85);
    expect(result.currency).toBeUndefined();
    expect(result.merchant?.value).toBe('BLUE BOTTLE COFFEE');
    expect(result.cardLast4?.value).toBe('4242');

    const date = new Date(result.occurredAt?.value ?? 0);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(14);
  });

  it('degrades to partial fields rather than failing', () => {
    const result = extractReceipt(ocr('smudged', 'TOTAL 7.00'));
    expect(result.total?.value).toBe(700);
    expect(result.cardLast4).toBeUndefined();
    expect(result.tax).toBeUndefined();
  });
});

/**
 * Currency comes from what the receipt says, or from the user.
 *
 * Reported from a real phone in Canada: `$12.50` came back as USD, because the
 * symbol table had one answer for `$`. Reading the receipt harder would not
 * have helped — the symbol carries no country. So symbols are not read at all,
 * and what fills the gap is the currency the user records in, marked as an
 * assumption they can change.
 */
describe('currency without a symbol table', () => {
  const receipt = (text: string): OcrResult => ({
    lines: [{ text: 'CAFE' }, { text }],
    engine: 'test',
    durationMs: 0,
  });

  const CAD = CurrencySchema.parse('CAD');
  const EUR = CurrencySchema.parse('EUR');

  it('uses the currency the user records in when nothing states one', () => {
    const found = extractReceipt(receipt('TOTAL $12.50'), { defaultCurrency: CAD }).currency;

    expect(found?.value).toBe(CAD);
    expect(found?.evidence).toMatch(/not printed/i);
  });

  it('marks that as an assumption rather than a reading', () => {
    const assumed = extractReceipt(receipt('TOTAL $12.50'), { defaultCurrency: CAD }).currency;
    const stated = extractReceipt(receipt('TOTAL EUR 12.50'), { defaultCurrency: CAD }).currency;

    expect(assumed?.confidence).toBeLessThan(stated?.confidence ?? 1);
  });

  it('lets a printed code beat the default', () => {
    // The one thing that overrides the user's own currency is the receipt
    // saying otherwise in words.
    expect(extractReceipt(receipt('TOTAL EUR 12,50'), { defaultCurrency: CAD }).currency?.value).toBe(
      EUR,
    );
  });

  it('never invents a currency from a symbol, whatever the default', () => {
    expect(extractReceipt(receipt('TOTAL $12.50')).currency).toBeUndefined();
    expect(extractReceipt(receipt('TOTAL €12,50')).currency).toBeUndefined();
  });
});
