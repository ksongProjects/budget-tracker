import { z } from 'zod';

/**
 * Money is an integer count of a currency's minor units (cents, yen, fils) plus
 * the currency code. Never a float: 12.34 * 100 is 1233.9999999999998, and a
 * budget that drifts by a cent per receipt is a budget nobody trusts.
 *
 * Minor units are `number`, not `bigint`. The safe-integer ceiling is 9e15
 * minor units — about 90 trillion dollars — which no personal ledger reaches,
 * and bigint would cost JSON round-trips that the extraction payloads and
 * backup manifests depend on. Every value is checked against that ceiling.
 */

export const CurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'currency must be a three-letter ISO 4217 code')
  .brand<'Currency'>();

export type Currency = z.infer<typeof CurrencySchema>;

export const MinorUnitsSchema = z
  .number()
  .int('money must be a whole number of minor units')
  .brand<'MinorUnits'>();

export type MinorUnits = z.infer<typeof MinorUnitsSchema>;

/** Currencies whose minor unit is not 1/100. Everything else uses 2. */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};

export const DEFAULT_MINOR_UNIT_EXPONENT = 2;

export function minorUnitExponent(currency: Currency): number {
  return MINOR_UNIT_EXPONENTS[currency] ?? DEFAULT_MINOR_UNIT_EXPONENT;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

const AMOUNT_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a canonical decimal string into minor units, exactly. Rejects more
 * fractional digits than the currency has rather than rounding, because
 * rounding a captured amount is a decision the user should make, not a silent
 * side effect of parsing.
 *
 * Grouping separators and locale formats are a UI concern: normalize before
 * calling this.
 */
export function parseAmount(input: string, currency: Currency): MinorUnits {
  const match = AMOUNT_PATTERN.exec(input.trim());
  if (!match) {
    throw new MoneyError(`not a valid amount: ${JSON.stringify(input)}`);
  }

  const negative = match[1] === '-';
  const whole = match[2] ?? '';
  const fraction = match[3] ?? '';
  const exponent = minorUnitExponent(currency);

  if (fraction.length > exponent) {
    throw new MoneyError(
      `${currency} has ${String(exponent)} decimal places, got ${String(fraction.length)} in ${input.trim()}`,
    );
  }

  const scaled = BigInt(whole + fraction.padEnd(exponent, '0'));
  const signed = negative ? -scaled : scaled;

  return toMinorUnits(signed);
}

/** Render minor units as a canonical decimal string. Display formatting (symbols, grouping) belongs to the UI. */
export function formatAmount(value: MinorUnits, currency: Currency): string {
  const exponent = minorUnitExponent(currency);
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(exponent + 1, '0');
  const cut = digits.length - exponent;
  const body = exponent === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;

  return negative ? `-${body}` : body;
}

/** Sum minor units, failing loudly rather than overflowing into imprecision. */
export function sumAmounts(values: readonly MinorUnits[]): MinorUnits {
  return toMinorUnits(values.reduce<bigint>((total, value) => total + BigInt(value), 0n));
}

function toMinorUnits(value: bigint): MinorUnits {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError(`amount outside the safe integer range: ${String(value)}`);
  }
  return Number(value) as MinorUnits;
}
