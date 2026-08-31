import { describe, expect, it } from 'vitest';
import { ModelOutputSchema, normaliseAmount } from './schema.js';

describe('normaliseAmount', () => {
  it.each([
    ['12.50', '12.50'],
    ['$12.50', '12.50'],
    ['USD 12.50', '12.50'],
    ['12,50', '12.50'],
    ['1,250.00', '1250.00'],
    ['1.250,00', '1250.00'],
    ['1 250,00', '1250.00'],
    ['.75', '0.75'],
    ['-3.00', '-3.00'],
    ['(3.00)', '-3.00'],
  ])('reads %s as %s', (input, expected) => {
    expect(normaliseAmount(input)).toBe(expected);
  });

  it.each(['', 'free', 'N/A', '.', '--'])('refuses %j', (input) => {
    expect(normaliseAmount(input)).toBeUndefined();
  });

  it('keeps a lone comma with three digits after it as a thousands separator', () => {
    // "1,250" is a thousand two hundred and fifty, not one and a quarter.
    expect(normaliseAmount('1,250')).toBe('1250');
  });
});

describe('the model output schema', () => {
  it('accepts what a small model actually writes', () => {
    const parsed = ModelOutputSchema.parse({
      merchant: '  Blue Bottle  ',
      date: '2026-08-29',
      currency: 'usd',
      total: '$8.97',
      tax: 0.72,
      tip: null,
      lineItems: [{ description: 'Latte', amount: '4.50', quantity: '1' }],
    });

    expect(parsed.merchant).toBe('Blue Bottle');
    expect(parsed.total).toBe('8.97');
    expect(parsed.tax).toBe('0.72');
    expect(parsed.tip).toBeNull();
    expect(parsed.lineItems?.[0]).toEqual({ description: 'Latte', amount: '4.50', quantity: 1 });
  });

  it('drops a field it cannot read rather than failing the whole answer', () => {
    // One bad field should not cost the user the total that was right.
    const parsed = ModelOutputSchema.parse({ total: '8.97', tax: 'not applicable' });

    expect(parsed.total).toBe('8.97');
    expect(parsed.tax).toBeNull();
  });

  it('drops a date that is not ISO', () => {
    expect(ModelOutputSchema.parse({ date: '08/29/2026' }).date).toBeNull();
  });

  it('drops line items with no readable amount', () => {
    const parsed = ModelOutputSchema.parse({
      lineItems: [{ description: 'Latte', amount: 'four fifty' }],
    });

    // The array itself is the field that failed, so the whole array is dropped
    // rather than silently shortened — a partial breakdown reads as complete.
    expect(parsed.lineItems).toBeNull();
  });

  it('accepts an answer with nothing in it', () => {
    // An empty object is a model saying it found nothing, which is a valid and
    // useful answer — the reader turns it into no candidate at all.
    expect(ModelOutputSchema.safeParse({}).success).toBe(true);
  });
});
