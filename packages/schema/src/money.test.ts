import { describe, expect, it } from 'vitest';
import {
  CurrencySchema,
  MinorUnitsSchema,
  MoneyError,
  formatAmount,
  minorUnitExponent,
  parseAmount,
  sumAmounts,
} from './money.js';
import type { Currency, MinorUnits } from './money.js';

const usd = CurrencySchema.parse('USD');
const jpy = CurrencySchema.parse('JPY');
const kwd = CurrencySchema.parse('KWD');
const minor = (n: number): MinorUnits => MinorUnitsSchema.parse(n);

describe('currency', () => {
  it('accepts ISO 4217 codes and rejects anything else', () => {
    expect(CurrencySchema.parse('EUR')).toBe('EUR');
    expect(() => CurrencySchema.parse('usd')).toThrow();
    expect(() => CurrencySchema.parse('DOLLAR')).toThrow();
    expect(() => CurrencySchema.parse('US')).toThrow();
  });

  it('knows which currencies are not hundredths', () => {
    expect(minorUnitExponent(usd)).toBe(2);
    expect(minorUnitExponent(jpy)).toBe(0);
    expect(minorUnitExponent(kwd)).toBe(3);
  });
});

describe('parseAmount', () => {
  it('parses without float error', () => {
    // 12.34 * 100 is 1233.9999999999998 in floating point.
    expect(parseAmount('12.34', usd)).toBe(1234);
    expect(parseAmount('0.07', usd)).toBe(7);
    expect(parseAmount('1.10', usd)).toBe(110);
    expect(parseAmount('8.20', usd)).toBe(820);
    expect(parseAmount('129.95', usd)).toBe(12995);
  });

  it('pads short fractions and accepts whole amounts', () => {
    expect(parseAmount('12.3', usd)).toBe(1230);
    expect(parseAmount('12', usd)).toBe(1200);
    expect(parseAmount('0', usd)).toBe(0);
  });

  it('honours the currency exponent', () => {
    expect(parseAmount('1200', jpy)).toBe(1200);
    expect(parseAmount('1.234', kwd)).toBe(1234);
  });

  it('rejects more precision than the currency has, rather than rounding', () => {
    expect(() => parseAmount('12.345', usd)).toThrow(MoneyError);
    expect(() => parseAmount('12.5', jpy)).toThrow(MoneyError);
  });

  it('handles negative amounts', () => {
    expect(parseAmount('-5.50', usd)).toBe(-550);
  });

  it('rejects malformed input loudly', () => {
    for (const bad of ['', ' ', '1,234.56', '$12.34', '12.', '.34', '1e3', 'abc', '--1', '1.2.3']) {
      expect(() => parseAmount(bad, usd), bad).toThrow(MoneyError);
    }
  });

  it('rejects amounts beyond the safe integer range', () => {
    expect(() => parseAmount('99999999999999999999', usd)).toThrow(MoneyError);
  });
});

describe('formatAmount', () => {
  it('round-trips with parseAmount', () => {
    for (const text of ['0.00', '12.34', '1.10', '-5.50', '129.95', '1000000.01']) {
      expect(formatAmount(parseAmount(text, usd), usd)).toBe(text);
    }
  });

  it('pads amounts smaller than one major unit', () => {
    expect(formatAmount(minor(7), usd)).toBe('0.07');
    expect(formatAmount(minor(0), usd)).toBe('0.00');
    expect(formatAmount(minor(-7), usd)).toBe('-0.07');
  });

  it('omits the separator for zero-exponent currencies', () => {
    expect(formatAmount(minor(1200), jpy)).toBe('1200');
  });

  it('handles three-decimal currencies', () => {
    expect(formatAmount(minor(1234), kwd)).toBe('1.234');
    expect(formatAmount(minor(4), kwd)).toBe('0.004');
  });
});

describe('sumAmounts', () => {
  it('sums exactly, which is the line-item reconciliation check', () => {
    const items = ['4.50', '3.25', '0.94'].map((t) => parseAmount(t, usd));
    expect(sumAmounts(items)).toBe(parseAmount('8.69', usd));
  });

  it('is zero for no values', () => {
    expect(sumAmounts([])).toBe(0);
  });

  it('throws rather than silently overflowing', () => {
    const big = minor(Number.MAX_SAFE_INTEGER);
    expect(() => sumAmounts([big, big])).toThrow(MoneyError);
  });
});

describe('MinorUnitsSchema', () => {
  it('rejects fractional minor units', () => {
    expect(() => MinorUnitsSchema.parse(12.5)).toThrow();
    expect(() => MinorUnitsSchema.parse(Number.NaN)).toThrow();
  });

  it('rejects values past the safe integer ceiling', () => {
    expect(() => MinorUnitsSchema.parse(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });
});

describe('currency types are not interchangeable', () => {
  it('keeps branded types distinct at the type level', () => {
    const amount: MinorUnits = parseAmount('1.00', usd);
    const currency: Currency = usd;
    expect(typeof amount).toBe('number');
    expect(typeof currency).toBe('string');
  });
});
