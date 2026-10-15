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

/** One thing bought, as it was said. */
export interface SpokenItem {
  /** What was bought, or the merchant when the sentence did not say. */
  readonly name: string;
  readonly amount: NonNullable<CandidateTransaction['total']>;
}

/**
 * One record out of a recording: everything said about one merchant.
 *
 * `total` is the sum of the items, because a speaker naming three prices has
 * not named a fourth; the user sees both before saving and can change either.
 */
export interface SpokenRecord {
  readonly merchant?: NonNullable<CandidateTransaction['merchant']>;
  readonly occurredAt?: NonNullable<CandidateTransaction['occurredAt']>;
  readonly currency: NonNullable<CandidateTransaction['currency']>;
  readonly items: readonly SpokenItem[];
  readonly total: MinorUnits;
  /** The words this record was read from. */
  readonly said: string;
}

/**
 * Words a sentence is joined with. Kept as separators rather than dropped, so a
 * split that turns out to be wrong can be undone without losing the text —
 * "Barnes and Noble" has to come back as it was said.
 */
const JOINS = /(\s*(?:,|;|\.(?=\s|$)|\band then\b|\bthen\b|\bplus\b|\balso\b|\band\b)\s*)/i;

/** Words that carry no item: how people talk around the thing they bought. */
const FILLER = new Set([
  'i',
  'we',
  'spent',
  'spend',
  'paid',
  'pay',
  'bought',
  'got',
  'had',
  'grabbed',
  'and',
  'then',
  'also',
  'plus',
  'a',
  'an',
  'the',
  'some',
  'just',
  'about',
  'around',
  'like',
  'um',
  'uh',
  'so',
  'on',
  'for',
  'last',
  'this',
  'it',
  'was',
]);

type Merchant = NonNullable<CandidateTransaction['merchant']>;
type Day = NonNullable<CandidateTransaction['occurredAt']>;
type CurrencyCandidate = NonNullable<CandidateTransaction['currency']>;

/**
 * "Coffee 4.50 and a muffin 3 at Blue Bottle, and 40 on gas at Shell" — as the
 * records it describes.
 *
 * The sentence is cut where it joins two clauses that *each* name an amount;
 * a join with an amount on only one side is part of a name or a description
 * ("fish and chips", "Barnes and Noble") and stays whole. Each clause is then
 * read with the same rules as a single spend.
 *
 * Clauses are grouped by merchant. One with no merchant belongs to the next
 * merchant named — people say what they bought before where — or, at the end
 * of the sentence, to the last one. A sentence that names no merchant at all is
 * one record. A day said anywhere applies to every record that does not name
 * its own, because "yesterday" at the front of a list is about the whole list.
 */
export function parseSpokenRecords(
  transcript: string,
  options: UtteranceOptions = {},
): SpokenRecord[] {
  const text = transcript.trim();
  if (text === '') return [];

  const now = options.now ?? Date.now();
  const clauses = splitClauses(text).map((said) => ({
    said,
    found: findAmount(said, options.defaultCurrency),
    merchant: findMerchant(said),
    day: findDay(said, now),
  }));

  if (!clauses.some((clause) => clause.found !== undefined)) return [];

  // Who each clause was paid to: its own merchant, else the next one named,
  // else the last one before it.
  const merchants = clauses.map(
    (clause, index): Merchant | undefined =>
      clause.merchant ??
      clauses.slice(index + 1).find((later) => later.merchant)?.merchant ??
      clauses
        .slice(0, index)
        .reverse()
        .find((earlier) => earlier.merchant)?.merchant,
  );

  const anyDay = clauses.find((clause) => clause.day)?.day;

  interface Group {
    merchant?: Merchant;
    day?: Day;
    currency?: CurrencyCandidate;
    items: SpokenItem[];
    said: string[];
  }

  const groups = new Map<string, Group>();

  for (const [index, clause] of clauses.entries()) {
    const merchant = merchants[index];
    const key = merchant === undefined ? '' : merchant.value.toLowerCase();

    let group = groups.get(key);
    if (!group) {
      group = { ...(merchant === undefined ? {} : { merchant }), items: [], said: [] };
      groups.set(key, group);
    }

    // A clause with no price still says something — the merchant, the day —
    // and its words belong with the record it describes.
    group.said.push(clause.said);
    if (group.day === undefined && clause.day !== undefined) group.day = clause.day;
    if (clause.found === undefined) continue;

    group.items.push({
      name:
        findItem(clause.said, clause.found.total.evidence, clause.merchant?.evidence) ??
        merchant?.value ??
        'Spend',
      amount: clause.found.total,
    });

    // A currency someone actually named beats one an earlier clause assumed.
    if (group.currency === undefined || group.currency.evidence === 'assumed') {
      group.currency = clause.found.currency;
    }
  }

  const records: SpokenRecord[] = [];
  for (const group of groups.values()) {
    if (group.currency === undefined || group.items.length === 0) continue;

    const occurredAt = group.day ?? anyDay;
    records.push({
      ...(group.merchant === undefined ? {} : { merchant: group.merchant }),
      ...(occurredAt === undefined ? {} : { occurredAt }),
      currency: group.currency,
      items: group.items,
      total: group.items.reduce((sum, item) => sum + item.amount.value, 0) as MinorUnits,
      said: group.said.join(', '),
    });
  }

  return records;
}

/** Cut at joins with an amount on both sides; glue everything else back. */
function splitClauses(text: string): string[] {
  const parts = text.split(JOINS);
  const clauses: string[] = [];
  let current = parts[0] ?? '';

  for (let index = 1; index < parts.length; index += 2) {
    const join = parts[index] ?? '';
    const next = parts[index + 1] ?? '';

    if (next.trim() !== '' && hasAmount(current) && hasAmount(next)) {
      clauses.push(current);
      current = next;
    } else {
      current += join + next;
    }
  }

  clauses.push(current);
  return clauses
    .map((clause) => clause.trim().replace(/[\s,;.]+$/, ''))
    .filter((clause) => clause !== '');
}

function hasAmount(text: string): boolean {
  return findAmount(text, undefined) !== undefined;
}

/**
 * What was bought: "coffee" from "twelve bucks on coffee at Blue Bottle".
 *
 * The amount and the place are taken out first, then whatever follows "on" or
 * "for" — or, without one, whatever is left that is not filler, a number or a
 * day. Undefined when nothing is left, so the caller can say so honestly.
 */
function findItem(
  clause: string,
  amountEvidence: string,
  merchantEvidence: string | undefined,
): string | undefined {
  let rest = removeOnce(clause, amountEvidence);
  if (merchantEvidence !== undefined) rest = removeOnce(rest, merchantEvidence);

  const words = rest
    .split(/\s+/)
    .map(clean)
    .filter((word) => word !== '');

  const marker = words.findIndex((word) => ITEM_MARKERS.includes(word.toLowerCase()));
  const from = marker === -1 ? words : words.slice(marker + 1);

  const kept: string[] = [];
  for (const word of from) {
    const bare = word.toLowerCase();
    if (PLACE_MARKERS.includes(bare)) break;
    if (/^[\d$£€¥]/.test(bare)) continue;
    if (UNITS[bare] !== undefined || TENS[bare] !== undefined) continue;
    if (CURRENCY_WORDS[bare] !== undefined) continue;
    if (RELATIVE_DAYS[bare] !== undefined || WEEKDAYS.includes(bare)) continue;
    kept.push(word);
  }

  // Filler only comes off the ends: "a muffin" is a muffin, but "fish and
  // chips" keeps its "and".
  while (kept.length > 0 && FILLER.has((kept[0] ?? '').toLowerCase())) kept.shift();
  while (kept.length > 0 && FILLER.has((kept.at(-1) ?? '').toLowerCase())) kept.pop();

  const name = kept.join(' ').trim();
  return name === '' ? undefined : name;
}

function removeOnce(text: string, part: string): string {
  const at = text.toLowerCase().indexOf(part.toLowerCase());
  return at === -1 ? text : `${text.slice(0, at)} ${text.slice(at + part.length)}`;
}
