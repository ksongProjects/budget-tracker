import { describe, expect, it } from 'vitest';
import { CurrencySchema, parseAmount } from '@budget/schema';
import { extractJson, readModelOutput } from './read.js';
import type { StructuringRequest } from './types.js';

const USD = CurrencySchema.parse('USD');
const NOW = Date.UTC(2026, 7, 30, 12);

const RECEIPT = [
  'BLUE BOTTLE COFFEE',
  '2026-08-29',
  'Latte           4.50',
  'Croissant       3.75',
  'TAX             0.72',
  'TOTAL           8.97',
].join('\n');

function request(text = RECEIPT): StructuringRequest {
  return { text, kind: 'receipt', defaultCurrency: USD, now: NOW };
}

function read(raw: string, text = RECEIPT) {
  return readModelOutput(raw, request(text), { engine: 'double', durationMs: 12 });
}

describe('extractJson', () => {
  it('finds the JSON a model buried in prose and a fence', () => {
    const found = extractJson('Sure! Here is the JSON:\n```json\n{"total":"8.97"}\n```\nHope that helps.');
    expect(found).toEqual({ total: '8.97' });
  });

  it('keeps a nested object whole', () => {
    expect(extractJson('{"a":{"b":1},"c":2} trailing words')).toEqual({ a: { b: 1 }, c: 2 });
  });

  it('is not fooled by a brace inside a string', () => {
    expect(extractJson('{"merchant":"Café { Bar"}')).toEqual({ merchant: 'Café { Bar' });
  });

  it('returns nothing for an answer with no JSON in it', () => {
    expect(extractJson('I cannot read this receipt.')).toBeUndefined();
  });
});

describe('readModelOutput', () => {
  it('reads a well-formed answer into candidates', () => {
    const candidate = read(
      JSON.stringify({
        merchant: 'BLUE BOTTLE COFFEE',
        date: '2026-08-29',
        currency: 'USD',
        total: '8.97',
        tax: '0.72',
        lineItems: [
          { description: 'Latte', amount: '4.50' },
          { description: 'Croissant', amount: '3.75' },
        ],
      }),
    );

    expect(candidate.total?.value).toBe(parseAmount('8.97', USD));
    expect(candidate.tax?.value).toBe(parseAmount('0.72', USD));
    expect(candidate.merchant?.value).toBe('BLUE BOTTLE COFFEE');
    expect(candidate.occurredAt?.value).toBe(Date.UTC(2026, 7, 29));
    expect(candidate.lineItems).toHaveLength(2);
    expect(candidate.engine).toBe('double');
  });

  it('trusts an amount printed on the receipt more than one that is not', () => {
    const printed = read(JSON.stringify({ total: '8.97' }));
    const invented = read(JSON.stringify({ total: '9.97' }));

    expect(printed.total?.confidence).toBeGreaterThan(invented.total?.confidence ?? 1);
    expect(invented.total?.evidence).toContain('not printed');
  });

  it('marks a merchant that appears nowhere in the text as a suggestion', () => {
    const guessed = read(JSON.stringify({ total: '8.97', merchant: 'Starbucks' }));

    expect(guessed.merchant?.value).toBe('Starbucks');
    expect(guessed.merchant?.confidence).toBeLessThan(0.5);
  });

  it('drops a date in the future — a spend already happened', () => {
    const candidate = read(JSON.stringify({ total: '8.97', date: '2027-01-01' }));
    expect(candidate.occurredAt).toBeUndefined();
  });

  it('returns nothing at all when the answer is not JSON', () => {
    const candidate = read('I could not read that.');

    expect(candidate.total).toBeUndefined();
    expect(candidate.merchant).toBeUndefined();
    expect(candidate.engine).toBe('double');
  });

  it('does not offer a currency with no amount to denominate', () => {
    const candidate = read(JSON.stringify({ currency: 'USD', merchant: 'BLUE BOTTLE COFFEE' }));
    expect(candidate.currency).toBeUndefined();
  });

  it('falls back to the default currency without claiming confidence in it', () => {
    const candidate = read(JSON.stringify({ total: '8.97' }));

    expect(candidate.currency?.value).toBe(USD);
    expect(candidate.currency?.confidence).toBeLessThan(0.5);
    expect(candidate.currency?.evidence).toBe('assumed');
  });

  it('reads a decimal comma the way the receipt printed it', () => {
    const euro = readModelOutput(
      JSON.stringify({ currency: 'EUR', total: '6,00' }),
      {
        text: 'SUMME EUR 6,00',
        kind: 'receipt',
        defaultCurrency: USD,
        now: NOW,
      },
      { engine: 'double', durationMs: 1 },
    );

    expect(euro.total?.value).toBe(parseAmount('6.00', CurrencySchema.parse('EUR')));
    expect(euro.total?.confidence).toBeGreaterThan(0.8);
  });
});

describe('reconciliation', () => {
  it('says so when the items add up', () => {
    const candidate = read(
      JSON.stringify({
        total: '8.97',
        tax: '0.72',
        lineItems: [
          { description: 'Latte', amount: '4.50' },
          { description: 'Croissant', amount: '3.75' },
        ],
      }),
    );

    expect(candidate.reconciliation).toMatchObject({ balanced: true, differenceMinor: 0 });
  });

  it('reports the gap when they do not', () => {
    const candidate = read(
      JSON.stringify({
        total: '8.97',
        lineItems: [{ description: 'Latte', amount: '4.50' }],
      }),
    );

    expect(candidate.reconciliation?.balanced).toBe(false);
    expect(candidate.reconciliation?.differenceMinor).toBe(447);
  });

  it('holds down the confidence of a breakdown that does not add up', () => {
    const balanced = read(
      JSON.stringify({
        total: '8.25',
        lineItems: [
          { description: 'Latte', amount: '4.50' },
          { description: 'Croissant', amount: '3.75' },
        ],
      }),
    );
    const unbalanced = read(
      JSON.stringify({
        total: '8.97',
        lineItems: [
          { description: 'Latte', amount: '4.50' },
          { description: 'Croissant', amount: '3.75' },
        ],
      }),
    );

    expect(balanced.lineItems?.[0]?.confidence).toBeGreaterThan(0.8);
    expect(unbalanced.lineItems?.[0]?.confidence).toBeLessThanOrEqual(0.4);
  });

  it('has nothing to say without line items', () => {
    expect(read(JSON.stringify({ total: '8.97' })).reconciliation).toBeUndefined();
  });

  it('counts tip as part of the total, not as an extra', () => {
    const candidate = readModelOutput(
      JSON.stringify({
        total: '26.39',
        tax: '1.79',
        tip: '4.10',
        lineItems: [
          { description: 'Morning bun', amount: '5.50' },
          { description: 'Country loaf', amount: '11.00' },
          { description: 'Coffee', amount: '4.00' },
        ],
      }),
      request('Morning bun 5.50 Country loaf 11.00 Coffee 4.00 Tax 1.79 Tip 4.10 TOTAL 26.39'),
      { engine: 'double', durationMs: 3 },
    );

    expect(candidate.reconciliation?.balanced).toBe(true);
  });
});
