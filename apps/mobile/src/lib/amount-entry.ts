import { formatAmount, minorUnitExponent } from '@budget/schema';
import type { Currency, MinorUnits } from '@budget/schema';

/**
 * The amount keypad, as a state machine over minor units.
 *
 * Entry accumulates integers — pressing 1, 2, 3, 4 walks 0.01 → 0.12 → 1.23 →
 * 12.34 — so no decimal string is ever parsed and no float is ever involved.
 * The displayed value is derived from the integer, never the other way round.
 */

export interface AmountEntry {
  readonly minor: number;
  readonly currency: Currency;
}

/** Digits that fit under the safe-integer ceiling with room to spare. */
const MAX_DIGITS = 12;

export function emptyAmount(currency: Currency): AmountEntry {
  return { minor: 0, currency };
}

export function pressDigit(entry: AmountEntry, digit: number): AmountEntry {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
    throw new Error(`not a digit: ${String(digit)}`);
  }

  // Refuse rather than overflow: a silently truncated amount is a wrong amount.
  if (String(entry.minor).length >= MAX_DIGITS) return entry;

  return { ...entry, minor: entry.minor * 10 + digit };
}

export function pressBackspace(entry: AmountEntry): AmountEntry {
  return { ...entry, minor: Math.trunc(entry.minor / 10) };
}

export function clearAmount(entry: AmountEntry): AmountEntry {
  return { ...entry, minor: 0 };
}

/** What the keypad shows: always the currency's full precision, so 0.05 never reads as 0.5. */
export function displayAmount(entry: AmountEntry): string {
  return formatAmount(entry.minor as MinorUnits, entry.currency);
}

export function isEmpty(entry: AmountEntry): boolean {
  return entry.minor === 0;
}

/**
 * The value to save. Zero is not a spend, so it is not submittable — this is
 * what the entry screen's save button is disabled on.
 */
export function toMinorUnits(entry: AmountEntry): MinorUnits | null {
  return entry.minor === 0 ? null : (entry.minor as MinorUnits);
}

/**
 * Seed the keypad from an existing amount, for the edit screen.
 */
export function fromMinorUnits(minor: MinorUnits, currency: Currency): AmountEntry {
  return { minor: Math.abs(minor), currency };
}

/**
 * How many digits sit after the separator, for rendering the display with the
 * fractional part de-emphasised.
 */
export function fractionDigits(currency: Currency): number {
  return minorUnitExponent(currency);
}
