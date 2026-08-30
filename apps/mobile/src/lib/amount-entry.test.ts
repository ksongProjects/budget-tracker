import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import type { MinorUnits } from '@budget/schema';
import {
  clearAmount,
  displayAmount,
  emptyAmount,
  fromMinorUnits,
  isEmpty,
  pressBackspace,
  pressDigit,
  toMinorUnits,
} from './amount-entry';
import type { AmountEntry } from './amount-entry';

const USD = CurrencySchema.parse('USD');
const JPY = CurrencySchema.parse('JPY');

const type = (digits: string, currency = USD): AmountEntry => {
  let entry = emptyAmount(currency);
  for (const digit of digits) {
    entry = pressDigit(entry, Number(digit));
  }
  return entry;
};

describe('keypad entry', () => {
  it('accumulates digits from the right', () => {
    expect(displayAmount(type('1'))).toBe('0.01');
    expect(displayAmount(type('12'))).toBe('0.12');
    expect(displayAmount(type('123'))).toBe('1.23');
    expect(displayAmount(type('1234'))).toBe('12.34');
  });

  it('starts empty at zero', () => {
    const entry = emptyAmount(USD);
    expect(displayAmount(entry)).toBe('0.00');
    expect(isEmpty(entry)).toBe(true);
    expect(toMinorUnits(entry)).toBeNull();
  });

  it('keeps leading zeros harmless', () => {
    expect(displayAmount(type('0005'))).toBe('0.05');
    expect(toMinorUnits(type('0005'))).toBe(5);
  });

  it('never involves a float', () => {
    // 12.34 via float arithmetic is 1233.9999999999998.
    expect(toMinorUnits(type('1234'))).toBe(1234);
    expect(Number.isInteger(toMinorUnits(type('1234')))).toBe(true);
  });

  it('honours a zero-decimal currency', () => {
    expect(displayAmount(type('1200', JPY))).toBe('1200');
    expect(toMinorUnits(type('1200', JPY))).toBe(1200);
  });

  it('rejects a non-digit', () => {
    const entry = emptyAmount(USD);
    for (const bad of [-1, 10, 1.5, Number.NaN]) {
      expect(() => pressDigit(entry, bad), String(bad)).toThrow();
    }
  });

  it('stops accepting digits rather than overflowing', () => {
    let entry = emptyAmount(USD);
    for (let i = 0; i < 20; i += 1) {
      entry = pressDigit(entry, 9);
    }
    expect(String(entry.minor).length).toBeLessThanOrEqual(12);
    expect(Number.isSafeInteger(entry.minor)).toBe(true);
  });
});

describe('backspace and clear', () => {
  it('removes the last digit', () => {
    expect(displayAmount(pressBackspace(type('1234')))).toBe('1.23');
  });

  it('bottoms out at zero rather than going negative', () => {
    let entry = type('1');
    for (let i = 0; i < 5; i += 1) {
      entry = pressBackspace(entry);
    }
    expect(entry.minor).toBe(0);
    expect(displayAmount(entry)).toBe('0.00');
  });

  it('clears everything', () => {
    expect(isEmpty(clearAmount(type('9999')))).toBe(true);
  });

  it('round-trips typing after a backspace', () => {
    const entry = pressDigit(pressBackspace(type('1234')), 9);
    expect(displayAmount(entry)).toBe('12.39');
  });
});

describe('seeding from an existing amount', () => {
  it('loads a stored amount for editing', () => {
    const entry = fromMinorUnits(1234 as MinorUnits, USD);
    expect(displayAmount(entry)).toBe('12.34');
  });

  it('continues typing from the loaded value', () => {
    const entry = pressDigit(fromMinorUnits(1234 as MinorUnits, USD), 5);
    expect(displayAmount(entry)).toBe('123.45');
  });

  it('round-trips through the keypad unchanged', () => {
    for (const amount of [1, 5, 99, 100, 1234, 999_999]) {
      const entry = fromMinorUnits(amount as MinorUnits, USD);
      expect(toMinorUnits(entry)).toBe(amount);
    }
  });
});
