import { CurrencySchema, parseAmount } from '@budget/schema';
import type { Currency, MinorUnits, Timestamp } from '@budget/schema';
import type { Candidate, CandidateTransaction, OcrLine, OcrResult } from './types.js';
import { joinRows, layOut } from './receipt-layout.js';

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
  {
    // "Amount paid" is how order tickets say total.
    pattern: /\b(grand\s*total|amount\s*due|balance\s*due|total\s*due|amount\s*paid|total\s*paid)\b/i,
    confidence: 0.95,
  },
  { pattern: /\b(total)\b/i, confidence: 0.85 },
  // The same word in the languages a traveller's receipts are printed in.
  // Without these a German receipt falls through to the largest amount on it,
  // which on a dated receipt is the date read as money.
  { pattern: /\b(summe|gesamt|gesamtbetrag|totale|importe|montant|totaal|suma)\b/i, confidence: 0.85 },
  { pattern: /\b(amount)\b/i, confidence: 0.6 },
];

/** Labels that look like totals but are not the one we want. */
const TOTAL_EXCLUSIONS =
  /\b(sub\s*total|subtotal|tax|vat|gst|hst|pst|qst|tip|gratuity|change|cash|discount|savings|item\s*count|balance\s*forward)\b/i;

// PST and QST are how Canadian provinces print theirs, beside the federal GST.
const TAX_LABEL = /\b(sales\s*tax|tax|vat|gst|hst|pst|qst)\b/i;
const TOTAL_WORD = /\btotal\b/i;
const TIP_LABEL = /\b(tip|gratuity)\b/i;

/**
 * A money amount. Requires two decimal places, so that a quantity, a street
 * number, or a phone number is not read as a price.
 *
 * What is printed in front belongs to the amount, including the country some
 * receipts put before the dollar sign: `CA$11.86`, `US$5.00`, `NZ$ 4.50`. A
 * Canadian café ticket read without that came back as `$11.86` with a stray
 * `CA` left over, and the `CA` became the name of every item on it.
 *
 * `CAŠ`, `CAŞ` and `CAS` are how ML Kit reads `CA$` in small print. They count only
 * straight after a two-letter country, and a plain `S` only when a digit
 * follows at once, so `CASH 20.00` keeps its name.
 */
const AMOUNT =
  /(?:(?:\b(?:CA|US|AU|NZ|HK|A|C|S)\$|[$€£¥])\s*|\b(?:CA|US|AU|NZ|HK)(?:[Š§Ş]\s*|S(?=\d)))?(\d{1,3}(?:[,\s]\d{3})*|\d+)([.,]\d{2})(?!\d)/g;

/**
 * A fresh matcher over the same pattern.
 *
 * A `/g` regex carries `lastIndex`, so handing this one out would let two
 * callers interleave into each other's scan. Everyone who needs to walk the
 * amounts on a line gets their own.
 */
export function amountPattern(): RegExp {
  return new RegExp(AMOUNT.source, 'g');
}

/**
 * Currency is read only where the receipt says it in words.
 *
 * Symbols are not statements. A dollar sign is printed by Canada, Australia,
 * New Zealand, Singapore, Hong Kong and a dozen more, and reading it as US
 * dollars puts a confidently wrong number in the ledger of everyone else — the
 * failure a phone in Canada found. The symbol carries no country, so it is not
 * asked for one; when nothing states a currency, the caller's own is used and
 * the screen lets the user change it.
 */

/** Card last-4 as printed: masks, then four digits. Never the full number. */
const CARD_LAST4 = /(?:[*x#•]{2,}\s*|ending\s+(?:in\s+)?|xxxx\s*)(\d{4})\b/i;

/**
 * Real OCR engines emit a receipt's label column and amount column as separate
 * lines: `TAX` and `0.85` arrive apart, not as `TAX 0.85`.
 *
 * This was found by running ML Kit against a known receipt on a device — the
 * fixture text the rules were written against had them on one line, and the
 * rules silently missed every labelled amount as a result. Fixture text cannot
 * tell you how an engine splits a page.
 *
 * Kept as the name the tests and the table use; the pairing itself lives in
 * receipt-layout.ts, with the rest of reading a receipt as a page.
 */
export function mergeColumns(lines: readonly OcrLine[]): OcrLine[] {
  return joinRows(lines);
}

export interface ReceiptOptions {
  /**
   * What the user records in. Used to read an ambiguous symbol — never to
   * override one the receipt states outright.
   */
  readonly defaultCurrency?: Currency;
  /**
   * When the receipt was captured. Needed only to place a date printed without
   * a year, such as an order ticket's `September 12`; left out, such a date is
   * not read at all rather than given a year by guesswork.
   */
  readonly now?: number;
}

export function extractReceipt(
  ocr: OcrResult,
  options: ReceiptOptions = {},
): CandidateTransaction {
  const lines = layOut(ocr.lines).filter((line) => line.text.trim() !== '');

  const total = findTotal(lines);
  const candidate: {
    -readonly [K in keyof CandidateTransaction]: CandidateTransaction[K];
  } = {};

  if (total) candidate.total = total;

  const tax = findTax(lines);
  if (tax) candidate.tax = tax;

  const tip = findLabelled(lines, TIP_LABEL, 0.8);
  if (tip) candidate.tip = tip;

  const currency = findCurrency(lines, options.defaultCurrency);
  if (currency) candidate.currency = currency;

  const occurredAt = findDate(lines, options.now);
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

/**
 * Tax, added up: a Canadian receipt prints provincial and federal tax on two
 * lines, and the first alone was a third of the answer. A line that also says
 * "total" restates the others and is not counted again.
 */
function findTax(lines: readonly OcrLine[]): Candidate<MinorUnits> | undefined {
  const found = lines.filter(
    (line) =>
      TAX_LABEL.test(line.text) && !TOTAL_WORD.test(line.text) && amountsIn(line.text).length > 0,
  );
  if (found.length === 0) return undefined;
  return {
    value: sumMinor(found.map((line) => amountsIn(line.text).at(-1) as MinorUnits)),
    confidence: found.length === 1 ? 0.8 : 0.75,
    evidence: found.map((line) => line.text.trim()).join(' + '),
  };
}

function sumMinor(amounts: readonly MinorUnits[]): MinorUnits {
  return amounts.reduce((sum, amount) => sum + amount, 0) as MinorUnits;
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
    const whole = (match[1] ?? '').replace(/[,\s]/g, '');
    const fraction = (match[2] ?? '').replace(',', '.');

    try {
      // Parsed through the money helpers so the no-floats rule holds here too.
      found.push(parseAmount(`${whole}${fraction}`, CurrencySchema.parse('USD')));
    } catch {
      // A malformed amount is skipped, never guessed at.
    }
  }

  return found;
}

function findCurrency(
  lines: readonly OcrLine[],
  fallback: Currency | undefined,
): Candidate<Currency> | undefined {

  // A three-letter code is a statement: "SUMME EUR 6,00". Read only where an
  // amount shares the line, so an address on "CHF-strasse" or a product code is
  // not mistaken for the currency.
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

  // A country printed against the dollar sign is a statement too: `CA$11.86`
  // says Canada in a way a bare `$` never does. `C$` is left alone, because
  // Canada prints it and so does Nicaragua.
  for (const line of lines) {
    const prefix = DOLLAR_PREFIX.exec(line.text)?.[1];
    const code = prefix === undefined ? undefined : PREFIX_CURRENCY[prefix];
    if (code !== undefined) {
      return { value: CurrencySchema.parse(code), confidence: 0.75, evidence: line.text.trim() };
    }
  }

  // Nothing stated it. The caller's own currency, at a confidence that says
  // the receipt did not say so — which is what makes the screen show it as
  // something to check rather than something read.
  return fallback === undefined
    ? undefined
    : { value: fallback, confidence: 0.3, evidence: 'not printed — your default' };
}

/** ISO codes common enough to appear on a receipt. */
const CODE_IN_LINE = /\b(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|CZK)\b/i;
const AMOUNT_ON_LINE = /\d+[.,]\d{2}\b/;

/** A country written against the dollar sign, directly before a price. */
const DOLLAR_PREFIX = /\b(CA|US|AU|NZ|A)\$\s*\d/;
const PREFIX_CURRENCY: Readonly<Record<string, string>> = {
  CA: 'CAD',
  US: 'USD',
  AU: 'AUD',
  A: 'AUD',
  NZ: 'NZD',
};

const DATE_PATTERNS: readonly { readonly pattern: RegExp; readonly order: 'dmy' | 'mdy' | 'ymd' }[] =
  [
    { pattern: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, order: 'ymd' },
    { pattern: /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/, order: 'mdy' },
    { pattern: /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2})\b/, order: 'mdy' },
  ];

/** A line that says what its date is: `DATE 11/1/2026 4:43 PM`. */
const DATE_LABEL = /\b(?:date|dated|datum|fecha)\b/i;

/** `4:43 PM`, `16:43`, `5:43:01 p.m.` — a time of day. */
const TIME =
  /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?:\s*([ap])\.?\s*m\b\.?)?(?![\d:])/i;

/** How recent the likelier of two readings must be to settle an ambiguous date. */
const RECENT_MS = 45 * 86_400_000;

/**
 * The receipt date, and the time when one is printed beside it.
 *
 * A line labelled as the date wins over the first date found: an invoice
 * prints a service history, and a payment slip its own timestamp, and both
 * are dates too.
 *
 * Day/month order is the known weakness: 03/04/2026 is March 4th in the US and
 * April 3rd almost everywhere else. When the receipt cannot say, the capture
 * can: a receipt photographed on 2 November that reads as either 1 November or
 * 11 January is almost certainly the first. Only when both readings are
 * plausible is the date flagged for the user to check.
 */
function findDate(
  lines: readonly OcrLine[],
  now: number | undefined,
): Candidate<Timestamp> | undefined {
  const labelled = lines.findIndex(
    (line) => DATE_LABEL.test(line.text) && readDate(line.text, now) !== undefined,
  );
  const order = labelled === -1 ? [...lines.keys()] : [labelled, ...lines.keys()];

  for (const index of order) {
    const line = lines[index];
    if (line === undefined) continue;
    const date = readDate(line.text, now);
    if (!date) continue;

    // The time sits on the date's line, or on a line of its own just after it.
    const own = readTime(line.text);
    const next = own === undefined ? readTime(onlyTime(lines[index + 1]?.text)) : undefined;
    const time = own ?? next;

    const at = new Date(date.value);
    if (time) at.setHours(time.hours, time.minutes, 0, 0);

    return {
      value: at.getTime() as Timestamp,
      confidence: date.confidence,
      evidence:
        next === undefined
          ? line.text.trim()
          : `${line.text.trim()} ${lines[index + 1]?.text.trim() ?? ''}`,
    };
  }
  return undefined;
}

function readDate(
  text: string,
  now: number | undefined,
): { readonly value: Timestamp; readonly confidence: number } | undefined {
  for (const { pattern, order } of DATE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const [a, b, c] = [match[1], match[2], match[3]].map(Number) as [number, number, number];

    if (order === 'ymd') {
      const date = calendarDate(a, b, c);
      if (date !== undefined) return { value: date, confidence: 0.85 };
      continue;
    }

    const year = c < 100 ? 2000 + c : c;
    const monthFirst = calendarDate(year, a, b);
    const dayFirst = a === b ? undefined : calendarDate(year, b, a);

    if (monthFirst === undefined && dayFirst === undefined) continue;
    if (monthFirst === undefined || dayFirst === undefined) {
      return { value: (monthFirst ?? dayFirst) as Timestamp, confidence: 0.85 };
    }
    return settle(monthFirst, dayFirst, now);
  }

  return readNamedDate(text, now);
}

/**
 * Two readings of one date, both real days. The capture time settles it when
 * one reading is in the future — a receipt records something that already
 * happened — or when one is recent and the other is not. Otherwise
 * month-first, flagged for the user.
 */
function settle(
  monthFirst: Timestamp,
  dayFirst: Timestamp,
  now: number | undefined,
): { readonly value: Timestamp; readonly confidence: number } {
  const flagged = { value: monthFirst, confidence: 0.55 };
  if (now === undefined) return flagged;

  const past = [monthFirst, dayFirst].filter((value) => value <= now + DAY_MS);
  if (past.length === 1) return { value: past[0] as Timestamp, confidence: 0.8 };
  if (past.length === 0) return flagged;

  const [recent, older] = monthFirst >= dayFirst ? [monthFirst, dayFirst] : [dayFirst, monthFirst];
  if (now - recent <= RECENT_MS && now - older > RECENT_MS) {
    return { value: recent, confidence: 0.8 };
  }
  return flagged;
}

/** Noon on a real calendar day, or undefined: `new Date` rolls 31 April into May. */
function calendarDate(year: number, month: number, day: number): Timestamp | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(year, month - 1, day, 12);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return date.getTime() as Timestamp;
}

function readTime(text: string | undefined): { hours: number; minutes: number } | undefined {
  const match = text === undefined ? null : TIME.exec(text);
  if (!match) return undefined;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const half = match[3]?.toLowerCase();
  if (half !== undefined) {
    if (hours < 1 || hours > 12) return undefined;
    hours = (hours % 12) + (half === 'p' ? 12 : 0);
  }
  return { hours, minutes };
}

/** A line that is a time and nothing else, as engines split `03/14/2026  09:12 AM`. */
function onlyTime(text: string | undefined): string | undefined {
  return text !== undefined && /^\s*[\d:]+\s*(?:[ap]\.?\s*m\.?)?\s*$/i.test(text) ? text : undefined;
}

const DAY_MS = 86_400_000;

const MONTH_NAME =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-z])';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** `September 12`, `Sep. 12th, 2026`. A time straight after is not a day. */
const MONTH_FIRST = new RegExp(
  `\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:,?\\s+(\\d{4})\\b)?`,
  'i',
);
/** `12 September 2026`, `12 Sep`. */
const DAY_FIRST = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME}\\.?(?:,?\\s+(\\d{4})\\b)?`,
  'i',
);

/**
 * Above the 0.7 below which the confirm screen warns that day and month may be
 * swapped — a named month cannot be — and below a date that printed its year.
 */
const YEARLESS_CONFIDENCE = 0.75;

/**
 * A date written with the month's name: `September 12, 2026`, `12 Sep 2026`,
 * and the year-less `September 12` an order ticket prints.
 *
 * A year-less date is placed in the most recent year that does not put it in
 * the future, since a receipt records something that already happened. That
 * takes `now`; without it the date is not read, rather than given a year by
 * guesswork.
 */
function readNamedDate(
  text: string,
  now: number | undefined,
): { readonly value: Timestamp; readonly confidence: number } | undefined {
  const monthFirst = MONTH_FIRST.exec(text);
  const dayFirst = monthFirst === null ? DAY_FIRST.exec(text) : null;

  const monthName = monthFirst?.[1] ?? dayFirst?.[2];
  const dayText = monthFirst?.[2] ?? dayFirst?.[1];
  const yearText = monthFirst?.[3] ?? dayFirst?.[3];
  if (monthName === undefined || dayText === undefined) return undefined;

  const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  const day = Number(dayText);
  const printed = yearText === undefined ? undefined : Number(yearText);
  const printedYear =
    printed !== undefined && printed >= 1990 && printed <= 2100 ? printed : undefined;

  let year: number;
  if (printedYear !== undefined) {
    year = printedYear;
  } else {
    if (now === undefined) return undefined;
    year = new Date(now).getFullYear();
    // A day's grace, for a receipt printed a timezone ahead of the phone.
    if (new Date(year, month, day, 12).getTime() > now + DAY_MS) year -= 1;
  }

  const date = new Date(year, month, day, 12);
  // `new Date` rolls February 30th into March. A date that moved never existed.
  if (month === -1 || date.getMonth() !== month || date.getDate() !== day) return undefined;

  return {
    value: date.getTime() as Timestamp,
    confidence: printedYear === undefined ? YEARLESS_CONFIDENCE : 0.9,
  };
}

const NOT_A_MERCHANT =
  /^\s*(?:receipt|invoice|order|table|server|cashier|welcome|thank\s*you|customer\s*copy|merchant\s*copy|(?:new|returning)\s*customer|customer|guest|pick\s*-?\s*up|dine\s*-?\s*in|take\s*-?\s*out|to\s*go|delivery|\d[\d\s\-()+.]*|.{0,2})\s*$/i;

/**
 * A field the till prints, not a name: `Store#: 40832`, `Disposable items: No`,
 * `Order #1234`. A label and a colon, or a number sign before digits. Real
 * receipts had both at the top, where the name was expected, and each was
 * filed as the merchant.
 */
const FIELD_LINE = /^[^:]{1,30}:\s*\S|#\s*:?\s*\d/;

/**
 * The shop naming itself in the sign-off. Order tickets print the customer at
 * the top and the business only here, so this is read first: the header of
 * such a receipt is a person, and a user's own name filed as the merchant is a
 * privacy problem as well as a wrong answer.
 */
const SIGN_OFF =
  /\b(?:thank\s*you\s*for\s*(?:ordering|shopping|visiting|dining|choosing)(?:\s+(?:from|at|with))?|order(?:ed|ing)\s+from)\b\s*(.*?)[\s.!]*$/i;

/** "Thank you for shopping with us" names nobody. */
const NOT_A_NAME = /^(?:us|me|we|our\b.*|you\b.*)?$/i;

/**
 * The merchant name: the sign-off when a receipt has one, then the first
 * substantial line at the top. Receipts put the shop name in the header, above
 * the address and the phone number, which is why that looks only at the first
 * few lines.
 */
function findMerchant(lines: readonly OcrLine[]): Candidate<string> | undefined {
  for (const [index, line] of lines.entries()) {
    const signOff = SIGN_OFF.exec(line.text);
    if (!signOff) continue;

    // The name often wraps onto the line below the thanks.
    const named = signOff[1]?.trim() ?? '';
    const next = lines[index + 1]?.text.trim() ?? '';
    const name = named === '' ? next : named;

    if (NOT_A_NAME.test(name) || NOT_A_MERCHANT.test(name)) continue;
    if (name.length > 40 || !/[a-z]/i.test(name) || amountsIn(name).length > 0) continue;

    const evidence = named === '' ? `${line.text.trim()} ${name}` : line.text.trim();
    return { value: name, confidence: 0.75, evidence };
  }

  const anchored = aboveTheAddress(lines);
  if (anchored) return anchored;

  for (const line of lines.slice(0, 5)) {
    const text = line.text.trim();
    if (NOT_A_MERCHANT.test(text)) continue;
    if (FIELD_LINE.test(text)) continue;
    if (amountsIn(text).length > 0) continue;
    // A line that is mostly digits is an address or a phone number.
    if ((text.replace(/\D/g, '').length / text.length) > 0.4) continue;

    return { value: text, confidence: 0.6, evidence: text };
  }
  return undefined;
}

/** A street line: a number, then a name ending in what kind of street it is. */
const STREET =
  /^\s*\d{1,6}[a-z]?\s+.*\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|way|lane|ln|highway|hwy|place|pl|court|ct|crescent|cres|parkway|pkwy|square|sq|plaza|strasse|straße|rue|via|calle)\b\.?/i;
/** A North American phone number, the other line every shop header prints. */
const PHONE = /^\s*(?:tel[:.\s]*)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\s*$/i;
const PAGE_NUMBER = /^\s*page\s+\d+\s*(?:of\s*\d+)?\s*$/i;

/**
 * The name printed over the address.
 *
 * A shop's header is its name, then its street, then its phone number. Found
 * by the address rather than by being first, because on a photo the first
 * line read is whatever else was in frame — a car's dashboard, the edge of a
 * card slip — and on a printed invoice it can be "Page 1 of 1".
 */
function aboveTheAddress(lines: readonly OcrLine[]): Candidate<string> | undefined {
  const address = lines.findIndex((line) => STREET.test(line.text) || PHONE.test(line.text));
  if (address <= 0) return undefined;
  const anchor = lines[address]?.box;

  for (let index = address - 1; index >= Math.max(0, address - 4); index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const text = line.text.trim();

    // On a photo, the name stands over the address, not beside it.
    const box = line.box;
    if (anchor && box && (box.x > anchor.x + anchor.width || box.x + box.width < anchor.x)) {
      continue;
    }
    if (STREET.test(text) || PHONE.test(text) || PAGE_NUMBER.test(text)) continue;
    if (NOT_A_MERCHANT.test(text) || FIELD_LINE.test(text) || amountsIn(text).length > 0) continue;
    if (text.replace(/\D/g, '').length / text.length > 0.4) continue;

    return {
      value: text,
      confidence: 0.8,
      evidence: `${text} / ${lines[address]?.text.trim() ?? ''}`,
    };
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
