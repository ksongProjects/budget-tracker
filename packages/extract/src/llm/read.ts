import { CurrencySchema, minorUnitExponent, parseAmount, sumAmounts } from '@budget/schema';
import type { Currency, MinorUnits, Timestamp } from '@budget/schema';
import type { Candidate } from '../types.js';
import { ModelOutputSchema, normaliseAmount } from './schema.js';
import type { ModelOutput } from './schema.js';
import type { LineItem, Reconciliation, StructuredCandidate, StructuringRequest } from './types.js';

/**
 * Turning what a model said into candidates, or into nothing.
 *
 * This is the layer that protects the ledger from the model. A 3B model on a
 * phone wraps its JSON in prose, invents a total that appears nowhere in the
 * receipt, and dates a coffee next Tuesday — all of which are caught here
 * rather than in front of the user, because every field is checked against the
 * text it was supposed to be read from.
 *
 * Confidence is derived, not asked for. A model's self-reported confidence is a
 * number it made up; whether the amount it returned literally appears in the
 * source text is a fact, and it is the one that predicts whether the number is
 * right.
 */

export interface ReadOptions {
  readonly engine: string;
  readonly durationMs: number;
}

export function readModelOutput(
  raw: string,
  request: StructuringRequest,
  options: ReadOptions,
): StructuredCandidate {
  const empty: StructuredCandidate = { engine: options.engine, durationMs: options.durationMs };

  const json = extractJson(raw);
  if (json === undefined) return empty;

  const parsed = ModelOutputSchema.safeParse(json);
  if (!parsed.success) return empty;

  return build(parsed.data, request, options);
}

/**
 * The JSON inside whatever the model wrote around it.
 *
 * Models are told to return JSON and only JSON; small ones add "Here is the
 * JSON:" and a markdown fence anyway. Braces are counted rather than matched
 * with a regex, so a nested object survives.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

function build(
  output: ModelOutput,
  request: StructuringRequest,
  options: ReadOptions,
): StructuredCandidate {
  const haystack = request.text.toLowerCase();
  const currency = readCurrency(output.currency, request, haystack);
  const exponent = minorUnitExponent(currency.value);

  const total = readAmount(output.total, currency.value, exponent, haystack);
  const tax = readAmount(output.tax, currency.value, exponent, haystack);
  const tip = readAmount(output.tip, currency.value, exponent, haystack);
  const merchant = readMerchant(output.merchant, haystack);
  const occurredAt = readDate(output.date, request.now);
  const lineItems = readLineItems(output.lineItems, currency.value, exponent, haystack);
  const reconciliation = reconcile(lineItems, tax?.value, tip?.value, total?.value);

  return {
    engine: options.engine,
    durationMs: options.durationMs,
    ...(total === undefined ? {} : { total }),
    // A currency with no amount to denominate is noise on the screen.
    ...(total === undefined ? {} : { currency }),
    ...(merchant === undefined ? {} : { merchant }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(tax === undefined ? {} : { tax }),
    ...(tip === undefined ? {} : { tip }),
    ...(lineItems.length === 0 ? {} : { lineItems: weigh(lineItems, reconciliation) }),
    ...(reconciliation === undefined ? {} : { reconciliation }),
  };
}

/**
 * An amount, and how much to trust it.
 *
 * The digits either appear in the source text or the model produced them from
 * somewhere else. Both are worth keeping — a total that OCR only caught inside
 * a longer line is real — but they are not worth the same, and that difference
 * is what the user needs to see before confirming.
 */
function readAmount(
  value: string | null | undefined,
  currency: Currency,
  exponent: number,
  haystack: string,
): Candidate<MinorUnits> | undefined {
  if (value === null || value === undefined) return undefined;

  const normalised = normaliseAmount(value);
  if (normalised === undefined) return undefined;

  let minor: MinorUnits;
  try {
    minor = parseAmount(Number(normalised).toFixed(exponent), currency);
  } catch {
    return undefined;
  }

  const quoted = appearsIn(haystack, normalised);

  return {
    value: minor,
    confidence: quoted ? 0.9 : 0.6,
    evidence: quoted ? normalised : `${normalised} (not printed)`,
  };
}

function readCurrency(
  code: string | null | undefined,
  request: StructuringRequest,
  haystack: string,
): Candidate<Currency> {
  const parsed =
    code === null || code === undefined ? undefined : CurrencySchema.safeParse(code.toUpperCase());

  if (parsed?.success === true) {
    const named =
      haystack.includes(parsed.data.toLowerCase()) || hasSymbolFor(haystack, parsed.data);

    return {
      value: parsed.data,
      confidence: named ? 0.95 : 0.5,
      evidence: named ? parsed.data : `${parsed.data} (not printed)`,
    };
  }

  return { value: request.defaultCurrency, confidence: 0.4, evidence: 'assumed' };
}

const SYMBOLS: Readonly<Record<string, string>> = {
  USD: '$',
  GBP: '£',
  EUR: '€',
  JPY: '¥',
};

function hasSymbolFor(haystack: string, currency: Currency): boolean {
  const symbol = SYMBOLS[currency];
  return symbol !== undefined && haystack.includes(symbol);
}

/**
 * The merchant, if the model did not write one out of thin air.
 *
 * A name that appears nowhere in the text is a model's most confident
 * hallucination — "Starbucks" for any coffee receipt — so it is kept at a
 * confidence that reads as a suggestion rather than as a reading.
 */
function readMerchant(
  value: string | null | undefined,
  haystack: string,
): Candidate<string> | undefined {
  if (value === null || value === undefined) return undefined;

  const name = value.trim();
  if (name === '') return undefined;

  const quoted = haystack.includes(name.toLowerCase());

  return {
    value: name,
    confidence: quoted ? 0.85 : 0.45,
    evidence: quoted ? name : `${name} (not printed)`,
  };
}

/** A day, unless it is in the future — a spend already happened. */
function readDate(value: string | null | undefined, now: number): Candidate<Timestamp> | undefined {
  if (value === null || value === undefined) return undefined;

  const at = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(at)) return undefined;

  // Tomorrow in the device's timezone can be today in UTC, so the boundary sits
  // a day out rather than exactly at `now`.
  if (at > now + 86_400_000) return undefined;

  return { value: at as Timestamp, confidence: 0.8, evidence: value };
}

function readLineItems(
  items: ModelOutput['lineItems'],
  currency: Currency,
  exponent: number,
  haystack: string,
): Candidate<LineItem>[] {
  if (items === null || items === undefined) return [];

  const read: Candidate<LineItem>[] = [];

  for (const item of items) {
    const amount = readAmount(item.amount, currency, exponent, haystack);
    if (amount === undefined) continue;

    const described = haystack.includes(item.description.toLowerCase());

    read.push({
      value: {
        description: item.description,
        amount: amount.value,
        ...(item.quantity === null || item.quantity === undefined
          ? {}
          : { quantity: item.quantity }),
      },
      // Both halves have to be there: an amount off the receipt attached to a
      // description that is not on it is still a made-up line.
      confidence: described && amount.confidence >= 0.9 ? 0.85 : 0.5,
      evidence: `${item.description} ${amount.evidence}`,
    });
  }

  return read;
}

/**
 * Do the parts add up to the whole?
 *
 * Items plus tax plus tip against the stated total. Exact, with no tolerance: a
 * receipt that is off by a cent is off, and the user is the right person to
 * decide whether a discount line explains it. The flag exists to stop a
 * plausible-looking breakdown from being confirmed unread.
 */
export function reconcile(
  lineItems: readonly Candidate<LineItem>[],
  tax: MinorUnits | undefined,
  tip: MinorUnits | undefined,
  total: MinorUnits | undefined,
): Reconciliation | undefined {
  if (lineItems.length === 0 || total === undefined) return undefined;

  const parts = [
    ...lineItems.map((item) => item.value.amount),
    ...(tax === undefined ? [] : [tax]),
    ...(tip === undefined ? [] : [tip]),
  ];
  const itemisedTotal = sumAmounts(parts);

  return {
    balanced: itemisedTotal === total,
    itemisedTotal,
    differenceMinor: total - itemisedTotal,
  };
}

/** A breakdown that does not add up is not worth the confidence of one that does. */
function weigh(
  items: readonly Candidate<LineItem>[],
  reconciliation: Reconciliation | undefined,
): readonly Candidate<LineItem>[] {
  if (reconciliation === undefined || reconciliation.balanced) return items;

  return items.map((item) => ({ ...item, confidence: Math.min(item.confidence, 0.4) }));
}

/** Whether the digits are printed in the text, however they were punctuated there. */
function appearsIn(haystack: string, amount: string): boolean {
  const digits = amount.replace('-', '');
  if (haystack.includes(digits)) return true;

  // "1250.00" is printed as "1,250.00"; "12.50" may be written "12,50".
  const [whole = '', fraction] = digits.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const withComma = fraction === undefined ? grouped : `${grouped},${fraction}`;

  return (
    haystack.includes(fraction === undefined ? grouped : `${grouped}.${fraction}`) ||
    haystack.includes(withComma)
  );
}
