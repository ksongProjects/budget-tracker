import { CurrencySchema, parseAmount } from '@budget/schema';
import type { Currency, MinorUnits, Timestamp } from '@budget/schema';
import type { Candidate, CandidateTransaction, OcrLine, OcrResult } from './types.js';

/**
 * Tier 2: totals, tax, date, merchant, and card last-4 from OCR'd receipt text.
 *
 * Works because receipts, whatever else they do, label the total and put it near
 * the bottom. Every rule here is a heuristic, and every result carries the line
 * it came from, so a wrong number leads back to the rule that produced it
 * instead of to a shrug.
 *
 * Nothing here decides anything: the user confirms before any of it becomes a
 * transaction.
 */

/** Ordered strongest first — an explicit "grand total" beats a bare "total". */
const TOTAL_LABELS: readonly { readonly pattern: RegExp; readonly confidence: number }[] = [
  { pattern: /\b(grand\s*total|amount\s*due|balance\s*due|total\s*due)\b/i, confidence: 0.95 },
  { pattern: /\b(total)\b/i, confidence: 0.85 },
  // The same word in the languages a traveller's receipts are printed in.
  // Without these a German receipt falls through to the largest amount on it,
  // which on a dated receipt is the date read as money.
  { pattern: /\b(summe|gesamt|gesamtbetrag|totale|importe|montant|totaal|suma)\b/i, confidence: 0.85 },
  { pattern: /\b(amount)\b/i, confidence: 0.6 },
];

/** Labels that look like totals but are not the one we want. */
const TOTAL_EXCLUSIONS =
  /\b(sub\s*total|subtotal|tax|vat|gst|hst|tip|gratuity|change|cash|discount|savings|item\s*count|balance\s*forward)\b/i;

const TAX_LABEL = /\b(sales\s*tax|tax|vat|gst|hst)\b/i;
const TIP_LABEL = /\b(tip|gratuity)\b/i;

/**
 * A money amount. Requires either a currency symbol or two decimal places, so
 * that a quantity, a street number, or a phone number is not read as a price.
 */
const AMOUNT = /(?:([$€£¥])\s*)?(\d{1,3}(?:[,\s]\d{3})*|\d+)([.,]\d{2})(?!\d)/g;

const SYMBOL_CURRENCIES: Readonly<Record<string, string>> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
};

/** Card last-4 as printed: masks, then four digits. Never the full number. */
const CARD_LAST4 = /(?:[*x#•]{2,}\s*|ending\s+(?:in\s+)?|xxxx\s*)(\d{4})\b/i;

/**
 * How far apart two lines' centres may be and still count as the same row,
 * as a fraction of the typical line height.
 *
 * Relative to line height rather than to the page, because engines report boxes
 * in whatever units they like — ML Kit uses pixels, others normalize to 0–1 —
 * and a fraction of a line height means the same thing in both.
 */
const SAME_ROW_FRACTION = 0.6;

/**
 * Real OCR engines emit a receipt's label column and amount column as separate
 * lines: `TAX` and `0.85` arrive apart, not as `TAX 0.85`.
 *
 * This was found by running ML Kit against a known receipt on a device — the
 * fixture text the rules were written against had them on one line, and the
 * rules silently missed every labelled amount as a result. Fixture text cannot
 * tell you how an engine splits a page.
 *
 * Where boxes are available, an amount-only line is merged into the label line
 * sharing its row. Without boxes the lines are returned untouched, since
 * guessing at pairing would invent numbers.
 */
export function mergeColumns(lines: readonly OcrLine[]): OcrLine[] {
  const centre = (line: OcrLine): number | undefined =>
    line.box ? line.box.y + line.box.height / 2 : undefined;

  const isAmountOnly = (line: OcrLine): boolean =>
    amountsIn(line.text).length > 0 && /^[^a-z]*$/i.test(line.text.replace(/[\d.,$€£¥\s-]/g, ''));

  const heights = lines
    .map((line) => line.box?.height)
    .filter((height): height is number => height !== undefined && height > 0)
    .sort((a, b) => a - b);

  if (heights.length === 0) return [...lines];

  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  const tolerance = medianHeight * SAME_ROW_FRACTION;

  const merged: OcrLine[] = [];
  const consumed = new Set<number>();

  for (const [index, line] of lines.entries()) {
    if (consumed.has(index)) continue;

    // A line that already carries its own amount needs no partner.
    if (amountsIn(line.text).length > 0 || centre(line) === undefined) {
      merged.push(line);
      continue;
    }

    const row = centre(line);
    if (row === undefined) {
      merged.push(line);
      continue;
    }

    const partner = lines.findIndex((other, otherIndex) => {
      if (otherIndex === index || consumed.has(otherIndex)) return false;
      if (!isAmountOnly(other)) return false;

      const otherRow = centre(other);
      return otherRow !== undefined && Math.abs(otherRow - row) <= tolerance;
    });

    if (partner === -1) {
      merged.push(line);
      continue;
    }

    consumed.add(partner);
    const amountLine = lines[partner];
    merged.push({
      ...line,
      text: `${line.text.trim()} ${amountLine?.text.trim() ?? ''}`.trim(),
    });
  }

  return merged;
}

export function extractReceipt(ocr: OcrResult): CandidateTransaction {
  const lines = mergeColumns(ocr.lines).filter((line) => line.text.trim() !== '');

  const total = findTotal(lines);
  const candidate: {
    -readonly [K in keyof CandidateTransaction]: CandidateTransaction[K];
  } = {};

  if (total) candidate.total = total;

  const tax = findLabelled(lines, TAX_LABEL, 0.8);
  if (tax) candidate.tax = tax;

  const tip = findLabelled(lines, TIP_LABEL, 0.8);
  if (tip) candidate.tip = tip;

  const currency = findCurrency(lines);
  if (currency) candidate.currency = currency;

  const occurredAt = findDate(lines);
  if (occurredAt) candidate.occurredAt = occurredAt;

  const merchant = findMerchant(lines);
  if (merchant) candidate.merchant = merchant;

  const cardLast4 = findCardLast4(lines);
  if (cardLast4) candidate.cardLast4 = cardLast4;

  return candidate;
}

/**
 * The total: a labelled amount, preferring the strongest label and, among
 * equals, the one furthest down the receipt.
 *
 * Falls back to the largest amount on the receipt only when no label is found —
 * with low confidence, because "largest" is a guess that a big line item can
 * defeat.
 */
function findTotal(lines: readonly OcrLine[]): Candidate<MinorUnits> | undefined {
  let best: (Candidate<MinorUnits> & { readonly index: number }) | undefined;

  for (const [index, line] of lines.entries()) {
    if (TOTAL_EXCLUSIONS.test(line.text)) continue;

    for (const label of TOTAL_LABELS) {
      if (!label.pattern.test(line.text)) continue;

      const amounts = amountsIn(line.text);
      const amount = amounts.at(-1);
      if (amount === undefined) continue;

      // Later lines win ties: the total sits below the items.
      if (
        best === undefined ||
        label.confidence > best.confidence ||
        (label.confidence === best.confidence && index > best.index)
      ) {
        best = {
          value: amount,
          confidence: label.confidence,
          evidence: line.text.trim(),
          index,
        };
      }
      break;
    }
  }

  if (best) {
    return { value: best.value, confidence: best.confidence, evidence: best.evidence };
  }

  return largestAmount(lines);
}

function largestAmount(lines: readonly OcrLine[]): Candidate<MinorUnits> | undefined {
  let best: Candidate<MinorUnits> | undefined;

  for (const line of lines) {
    for (const amount of amountsIn(line.text)) {
      if (best === undefined || amount > best.value) {
        // Low confidence on purpose: no label was found, so this is a guess and
        // the confirm screen should say so.
        best = { value: amount, confidence: 0.3, evidence: line.text.trim() };
      }
    }
  }

  return best;
}

function findLabelled(
  lines: readonly OcrLine[],
  label: RegExp,
  confidence: number,
): Candidate<MinorUnits> | undefined {
  for (const line of lines) {
    if (!label.test(line.text)) continue;
    const amount = amountsIn(line.text).at(-1);
    if (amount !== undefined) {
      return { value: amount, confidence, evidence: line.text.trim() };
    }
  }
  return undefined;
}

/** Every money amount in a line, in order, as minor units. */
export function amountsIn(text: string): MinorUnits[] {
  const found: MinorUnits[] = [];

  for (const match of text.matchAll(AMOUNT)) {
    const whole = (match[2] ?? '').replace(/[,\s]/g, '');
    const fraction = (match[3] ?? '').replace(',', '.');

    try {
      // Parsed through the money helpers so the no-floats rule holds here too.
      found.push(parseAmount(`${whole}${fraction}`, CurrencySchema.parse('USD')));
    } catch {
      // A malformed amount is skipped, never guessed at.
    }
  }

  return found;
}

function findCurrency(lines: readonly OcrLine[]): Candidate<Currency> | undefined {
  for (const line of lines) {
    for (const [symbol, code] of Object.entries(SYMBOL_CURRENCIES)) {
      if (line.text.includes(symbol)) {
        return {
          value: CurrencySchema.parse(code),
          confidence: 0.7,
          evidence: line.text.trim(),
        };
      }
    }
  }

  // Outside the symbol currencies, receipts print the code instead: "SUMME EUR
  // 6,00". Read only where an amount shares the line, so an address in
  // "CHF-strasse" or a product code is not mistaken for the currency.
  for (const line of lines) {
    const code = CODE_IN_LINE.exec(line.text);
    if (code?.[1] !== undefined && AMOUNT_ON_LINE.test(line.text)) {
      return {
        value: CurrencySchema.parse(code[1].toUpperCase()),
        confidence: 0.75,
        evidence: line.text.trim(),
      };
    }
  }

  return undefined;
}

/** ISO codes common enough on a receipt to be worth reading, symbols aside. */
const CODE_IN_LINE = /\b(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|CZK)\b/i;
const AMOUNT_ON_LINE = /\d+[.,]\d{2}\b/;

const DATE_PATTERNS: readonly { readonly pattern: RegExp; readonly order: 'dmy' | 'mdy' | 'ymd' }[] =
  [
    { pattern: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, order: 'ymd' },
    { pattern: /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/, order: 'mdy' },
    { pattern: /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2})\b/, order: 'mdy' },
  ];

/**
 * The receipt date. Ambiguous day/month order is the known weakness: 03/04/2026
 * is March 4th in the US and April 3rd almost everywhere else. We assume
 * month-first and lower the confidence when the reading is ambiguous, so the
 * confirm screen can flag it rather than quietly filing the wrong month.
 */
function findDate(lines: readonly OcrLine[]): Candidate<Timestamp> | undefined {
  for (const line of lines) {
    for (const { pattern, order } of DATE_PATTERNS) {
      const match = pattern.exec(line.text);
      if (!match) continue;

      const parts = [match[1], match[2], match[3]].map(Number);
      const [a, b, c] = parts as [number, number, number];

      let year: number;
      let month: number;
      let day: number;

      if (order === 'ymd') {
        [year, month, day] = [a, b, c];
      } else {
        [month, day] = [a, b];
        year = c < 100 ? 2000 + c : c;
      }

      if (month < 1 || month > 12 || day < 1 || day > 31) continue;

      const date = new Date(year, month - 1, day, 12);
      if (Number.isNaN(date.getTime())) continue;

      const ambiguous = order !== 'ymd' && day <= 12 && month <= 12;
      return {
        value: date.getTime() as Timestamp,
        confidence: ambiguous ? 0.55 : 0.85,
        evidence: line.text.trim(),
      };
    }
  }
  return undefined;
}

const NOT_A_MERCHANT =
  /^\s*(?:receipt|invoice|order|table|server|cashier|welcome|thank\s*you|customer\s*copy|merchant\s*copy|\d[\d\s\-()+.]*|.{0,2})\s*$/i;

/**
 * The merchant name: the first substantial line at the top of the receipt.
 * Receipts put the shop name in the header, above the address and the phone
 * number, which is why this looks only at the first few lines.
 */
function findMerchant(lines: readonly OcrLine[]): Candidate<string> | undefined {
  for (const line of lines.slice(0, 5)) {
    const text = line.text.trim();
    if (NOT_A_MERCHANT.test(text)) continue;
    if (amountsIn(text).length > 0) continue;
    // A line that is mostly digits is an address or a phone number.
    if ((text.replace(/\D/g, '').length / text.length) > 0.4) continue;

    return { value: text, confidence: 0.6, evidence: text };
  }
  return undefined;
}

function findCardLast4(lines: readonly OcrLine[]): Candidate<string> | undefined {
  for (const line of lines) {
    const match = CARD_LAST4.exec(line.text);
    if (match?.[1] !== undefined) {
      return { value: match[1], confidence: 0.9, evidence: line.text.trim() };
    }
  }
  return undefined;
}
