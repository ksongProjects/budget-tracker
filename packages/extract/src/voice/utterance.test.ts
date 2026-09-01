import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import { parseUtterance } from './utterance.js';
import { UTTERANCES } from './utterances.js';

const USD = CurrencySchema.parse('USD');
const EUR = CurrencySchema.parse('EUR');
const NOW = Date.UTC(2026, 2, 18, 12); // A Wednesday.
const DAY = 86_400_000;

describe('the fixture utterance set', () => {
  it.each(UTTERANCES)('parses "$said"', ({ said, expect: wanted }) => {
    const candidate = parseUtterance(said, { defaultCurrency: USD, now: NOW });

    if (wanted.amountMinor === undefined) {
      // Nothing readable means no fields, not a zero: a zero would import as a
      // real transaction of no value.
      expect(candidate.total).toBeUndefined();
    } else {
      expect(candidate.total?.value).toBe(wanted.amountMinor);
    }

    if (wanted.currency !== undefined) {
      expect(candidate.currency?.value).toBe(wanted.currency);
    }

    if (wanted.merchant !== undefined) {
      expect(candidate.merchant?.value).toBe(wanted.merchant);
    }

    if (wanted.daysAgo !== undefined) {
      expect(candidate.occurredAt?.value).toBe(NOW - wanted.daysAgo * DAY);
    }
  });
});

describe('amounts', () => {
  const read = (said: string) => parseUtterance(said, { defaultCurrency: USD, now: NOW });

  it('trusts digits over the same number in words', () => {
    expect(read('12 dollars').total?.value).toBe(1200);
  });

  it('reads a spelled-out number', () => {
    expect(read('twelve dollars at Blue Bottle').total?.value).toBe(1200);
  });

  it('reads a compound spelled-out number', () => {
    expect(read('twenty five dollars').total?.value).toBe(2500);
  });

  it('respects a currency with no minor unit', () => {
    expect(read('980 yen').total?.value).toBe(980);
  });

  it('says it is less sure when nobody named a currency', () => {
    const named = read('$12 at Blue Bottle');
    const bare = read('12 at Blue Bottle');

    expect(named.total?.confidence).toBeGreaterThan(bare.total?.confidence ?? 1);
    expect(bare.currency?.evidence).toBe('assumed');
  });

  it('keeps the words it read the amount from', () => {
    expect(read('spent $4.50 at Blue Bottle').total?.evidence).toContain('4.50');
  });

  it('finds nothing in a sentence with no amount', () => {
    expect(read('coffee at Blue Bottle').total).toBeUndefined();
  });
});

describe('merchants', () => {
  const read = (said: string) => parseUtterance(said, { defaultCurrency: USD, now: NOW });

  it('takes the phrase after "at"', () => {
    expect(read('$4.50 at Blue Bottle').merchant?.value).toBe('Blue Bottle');
  });

  it('takes the phrase after "from"', () => {
    expect(read('$9 from the corner shop').merchant?.value).toBe('the corner shop');
  });

  it('stops before a day word', () => {
    // "at the hardware shop yesterday" — the day is not part of the name.
    expect(read('40 euros at the hardware shop yesterday').merchant?.value).toBe(
      'the hardware shop',
    );
  });

  it('does not mistake what was bought for where it was bought', () => {
    expect(read('twelve bucks on coffee').merchant).toBeUndefined();
  });

  it('drops trailing punctuation a transcriber left behind', () => {
    expect(read('$8 at Tartine.').merchant?.value).toBe('Tartine');
  });
});

describe('when it happened', () => {
  const read = (said: string) => parseUtterance(said, { defaultCurrency: USD, now: NOW });

  it('reads yesterday', () => {
    expect(read('$4 at Blue Bottle yesterday').occurredAt?.value).toBe(NOW - DAY);
  });

  it('reads a weekday as the one just gone', () => {
    // Said on a Wednesday: Friday means five days back, not two days forward.
    // A spend is something that already happened.
    expect(read('$30 at the market on Friday').occurredAt?.value).toBe(NOW - 5 * DAY);
  });

  it('reads the same weekday as a week ago', () => {
    // Nobody says "on Wednesday" about this morning.
    expect(read('$30 at the market on Wednesday').occurredAt?.value).toBe(NOW - 7 * DAY);
  });

  it('says nothing when the sentence does not', () => {
    expect(read('$4 at Blue Bottle').occurredAt).toBeUndefined();
  });
});

describe('nothing to read', () => {
  it('returns an empty candidate for silence', () => {
    expect(parseUtterance('', { defaultCurrency: USD })).toEqual({});
  });

  it('returns an empty candidate for a sentence about nothing', () => {
    expect(parseUtterance('remind me to call the bank', { defaultCurrency: USD }).total)
      .toBeUndefined();
  });
});

/**
 * The ledger's own currency, when the sentence names none.
 *
 * A spoken "twelve fifty" says nothing about which currency, and reading it as
 * dollars on a phone set up in euros is a wrong number that looks like a right
 * one. The voice screen shipped exactly that bug by never passing the default
 * down; this pins the layer underneath it.
 */
describe('the currency nobody said', () => {
  it('falls back to the currency the caller records in, not to dollars', () => {
    const candidate = parseUtterance('twelve fifty at Tartine', {
      defaultCurrency: EUR,
      now: NOW,
    });

    expect(candidate.currency?.value).toBe('EUR');
    // Assumed, not heard — the screen shows it as the user's own default.
    expect(candidate.currency?.confidence).toBeLessThan(0.5);
  });

  it('still prefers a currency the sentence does name', () => {
    const candidate = parseUtterance('twelve dollars at Tartine', {
      defaultCurrency: EUR,
      now: NOW,
    });

    expect(candidate.currency?.value).toBe('USD');
    expect(candidate.currency?.confidence).toBeGreaterThan(0.9);
  });
});
