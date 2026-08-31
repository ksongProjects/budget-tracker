import { CurrencySchema, minorUnitExponent, parseAmount } from '@budget/schema';
import type { Currency, MinorUnits, Timestamp } from '@budget/schema';
import type { CandidateTransaction } from '../types.js';

/**
 * Turning "twelve bucks on coffee at Blue Bottle" into a candidate.
 *
 * The MVP fallback for Tier 3 (docs/extraction.md): rules first, so a spoken
 * spend becomes a transaction without a model in the loop, on a device with no
 * network. Phase 9 will route the same transcript through an on-device LLM;
 * this stays as the floor, because a model that is unavailable, slow or wrong
 * still leaves the user with something.
 *
 * Everything here is a *candidate*. Nothing is confirmed, every field carries
 * the words it came from, and a sentence this cannot read produces no fields
 * rather than invented ones — a wrong amount the user has to notice is worse
 * than an empty form they have to fill.
 */

/** How a spoken amount can be written once a transcriber has had a go at it. */
const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  dollar: 'USD',
  dollars: 'USD',
  buck: 'USD',
  bucks: 'USD',
  usd: 'USD',
  pound: 'GBP',
  pounds: 'GBP',
  quid: 'GBP',
  gbp: 'GBP',
  euro: 'EUR',
  euros: 'EUR',
  eur: 'EUR',
  yen: 'JPY',
  jpy: 'JPY',
};

const SYMBOLS: Readonly<Record<string, string>> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
};

const UNITS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Words that introduce the thing bought, rather than the place. */
const ITEM_MARKERS = ['on', 'for'];
/** Words that introduce the merchant. */
const PLACE_MARKERS = ['at', 'from', 'in'];

export interface UtteranceOptions {
  /** Used when the words name no currency. */
  readonly defaultCurrency?: Currency;
  /** "Yesterday" is relative to this. */
  readonly now?: number;
}

const DAY = 86_400_000;

export function parseUtterance(
  transcript: string,
  options: UtteranceOptions = {},
): CandidateTransaction {
  const text = transcript.trim();
  if (text === '') return {};

  const amount = findAmount(text, options.defaultCurrency);
  const merchant = findMerchant(text);
  const occurredAt = findDay(text, options.now ?? Date.now());

  return {
    ...(amount === undefined ? {} : { total: amount.total, currency: amount.currency }),
    ...(merchant === undefined ? {} : { merchant }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

interface AmountFound {
  readonly total: NonNullable<CandidateTransaction['total']>;
  readonly currency: NonNullable<CandidateTransaction['currency']>;
}

/**
 * The amount, and the currency if the speaker named one.
 *
 * Digits are trusted over words: a transcriber writes "$12.50" when it hears
 * it, and reaching for the spelled-out reading of a number that is already a
 * number is how "twelve fifty" and "12.50" end up disagreeing.
 */
function findAmount(text: string, fallback: Currency | undefined): AmountFound | undefined {
  const digits =
    /(?:([$£€¥])\s*)?(\d+(?:[.,]\d{1,2})?)\s*(dollars?|bucks?|pounds?|quid|euros?|yen|usd|gbp|eur|jpy)?/i.exec(
      text,
    );

  if (digits?.[2] !== undefined) {
    const currency = currencyFrom(digits[1], digits[3], fallback);
    const value = Number(digits[2].replace(',', '.'));

    return {
      total: {
        value: scale(value, currency),
        confidence: digits[1] === undefined && digits[3] === undefined ? 0.7 : 0.95,
        evidence: digits[0].trim(),
      },
      currency: currencyCandidate(digits[1], digits[3], fallback),
    };
  }

  const spelled = spelledAmount(text);
  if (spelled === undefined) return undefined;

  const currency = currencyFrom(undefined, spelled.unit, fallback);

  return {
    total: {
      value: scale(spelled.value, currency),
      confidence: spelled.unit === undefined ? 0.6 : 0.85,
      evidence: spelled.evidence,
    },
    currency: currencyCandidate(undefined, spelled.unit, fallback),
  };
}

interface SpelledAmount {
  readonly value: number;
  readonly unit: string | undefined;
  readonly evidence: string;
}

/**
 * A number said in words: "twelve", "twenty five", "a hundred and ten".
 *
 * Stops at two words plus a unit, which covers everything a person says about a
 * coffee. Anyone dictating "one thousand two hundred and forty three" is typing
 * it instead.
 */
function spelledAmount(text: string): SpelledAmount | undefined {
  const words = text.toLowerCase().split(/[^a-z]+/).filter((word) => word !== '');

  for (const [index, word] of words.entries()) {
    const tens = TENS[word];
    const unit = UNITS[word];

    if (tens === undefined && unit === undefined) continue;

    let value = tens ?? unit ?? 0;
    let consumed = 1;

    // "twenty five" — a tens word may be followed by a unit.
    if (tens !== undefined) {
      const next = words[index + 1];
      const nextUnit = next === undefined ? undefined : UNITS[next];
      if (nextUnit !== undefined && nextUnit < 10) {
        value += nextUnit;
        consumed = 2;
      }
    }

    const after = words[index + consumed];
    const currencyWord = after === undefined ? undefined : CURRENCY_WORDS[after];

    return {
      value,
      unit: currencyWord === undefined ? undefined : after,
      evidence: words.slice(index, index + consumed + (currencyWord === undefined ? 0 : 1)).join(' '),
    };
  }

  return undefined;
}

function currencyFrom(
  symbol: string | undefined,
  word: string | undefined,
  fallback: Currency | undefined,
): Currency {
  const code =
    (symbol === undefined ? undefined : SYMBOLS[symbol]) ??
    (word === undefined ? undefined : CURRENCY_WORDS[word.toLowerCase()]);

  if (code !== undefined) {
    const parsed = CurrencySchema.safeParse(code);
    if (parsed.success) return parsed.data;
  }

  return fallback ?? CurrencySchema.parse('USD');
}

function currencyCandidate(
  symbol: string | undefined,
  word: string | undefined,
  fallback: Currency | undefined,
): NonNullable<CandidateTransaction['currency']> {
  const spoken = symbol ?? word;
  const currency = currencyFrom(symbol, word, fallback);

  return {
    value: currency,
    // A named currency is stated; an assumed one is the device's default and
    // deserves to be visibly weaker.
    confidence: spoken === undefined ? 0.4 : 0.95,
    evidence: spoken ?? 'assumed',
  };
}

function scale(value: number, currency: Currency): MinorUnits {
  // Through the schema, which owns how a decimal becomes minor units and how
  // many of them a currency has. Doing the arithmetic here would be a second,
  // less tested answer to a question that already has one.
  return parseAmount(value.toFixed(minorUnitExponent(currency)), currency);
}

/**
 * The merchant, from "at Blue Bottle" or "from Shell".
 *
 * Capitalisation is not available — a transcriber's is unreliable and this may
 * be reading its output — so the marker word is what identifies the place, and
 * the phrase runs to the end or to the next marker.
 */
function findMerchant(text: string): NonNullable<CandidateTransaction['merchant']> | undefined {
  const words = text.split(/\s+/);

  for (const [index, word] of words.entries()) {
    if (!PLACE_MARKERS.includes(clean(word).toLowerCase())) continue;

    const rest: string[] = [];
    for (const following of words.slice(index + 1)) {
      const bare = clean(following).toLowerCase();
      if (ITEM_MARKERS.includes(bare) || PLACE_MARKERS.includes(bare)) break;
      if (RELATIVE_DAYS[bare] !== undefined || bare === 'last' || bare === 'this') break;

      // A number after the name is the price, not part of it: "at Tartine,
      // eighteen fifty". This does cost the branch number in "at Safeway 0421",
      // which a receipt would keep — but in a spoken sentence the amount is far
      // likelier, and a merchant is easier to correct than an amount.
      if (/^\d/.test(bare) || UNITS[bare] !== undefined || TENS[bare] !== undefined) break;
      if (CURRENCY_WORDS[bare] !== undefined) break;

      rest.push(clean(following));
    }

    const name = rest.join(' ').trim();
    if (name === '') continue;

    return { value: name, confidence: 0.8, evidence: `${word} ${name}` };
  }

  return undefined;
}

const RELATIVE_DAYS: Readonly<Record<string, number>> = {
  today: 0,
  tonight: 0,
  yesterday: 1,
};

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/**
 * When it happened, if the words say.
 *
 * Only backwards: "on Friday" said on a Wednesday means the Friday just gone,
 * because a spend is something that already happened. Reading it forwards would
 * date a coffee two days into the future.
 */
function findDay(
  text: string,
  now: number,
): NonNullable<CandidateTransaction['occurredAt']> | undefined {
  const words = text.toLowerCase().split(/[^a-z]+/).filter((word) => word !== '');

  for (const [index, word] of words.entries()) {
    const relative = RELATIVE_DAYS[word];
    if (relative !== undefined) {
      return {
        value: (now - relative * DAY) as Timestamp,
        confidence: 0.9,
        evidence: word,
      };
    }

    const weekday = WEEKDAYS.indexOf(word);
    if (weekday === -1) continue;

    const today = new Date(now).getDay();
    // Same weekday means a week ago, not today: nobody says "on Wednesday"
    // about this morning.
    const back = (today - weekday + 7) % 7 || 7;
    const previous = words[index - 1];

    return {
      value: (now - back * DAY) as Timestamp,
      confidence: 0.7,
      evidence: previous === 'last' ? `last ${word}` : word,
    };
  }

  return undefined;
}

function clean(word: string): string {
  return word.replace(/^[^\w$£€¥]+|[^\w]+$/g, '');
}
