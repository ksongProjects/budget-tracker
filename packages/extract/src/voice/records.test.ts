import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import { parseSpokenRecords, parseUtterance } from './utterance.js';
import { UTTERANCES } from './utterances.js';

const USD = CurrencySchema.parse('USD');
const NOW = Date.UTC(2026, 2, 18, 12); // A Wednesday.
const DAY = 86_400_000;

const read = (said: string) => parseSpokenRecords(said, { defaultCurrency: USD, now: NOW });

const shape = (said: string) =>
  read(said).map((record) => ({
    merchant: record.merchant?.value,
    items: record.items.map((item) => [item.name, item.amount.value]),
    total: record.total,
  }));

describe('one spend, said once', () => {
  // The single-spend set is the floor: splitting must not change one of them.
  it.each(UTTERANCES.filter((u) => u.expect.amountMinor !== undefined))(
    'reads "$said" as the same one record',
    ({ said }) => {
      const single = parseUtterance(said, { defaultCurrency: USD, now: NOW });
      const records = read(said);

      expect(records).toHaveLength(1);
      expect(records[0]?.total).toBe(single.total?.value);
      expect(records[0]?.currency.value).toBe(single.currency?.value);
      expect(records[0]?.merchant?.value).toBe(single.merchant?.value);
      expect(records[0]?.occurredAt?.value).toBe(single.occurredAt?.value);
    },
  );

  it('names the item that was bought', () => {
    expect(shape('twelve bucks on coffee at Blue Bottle')).toEqual([
      { merchant: 'Blue Bottle', items: [['coffee', 1200]], total: 1200 },
    ]);
    expect(shape('three quid on a sandwich')[0]?.items).toEqual([['sandwich', 300]]);
    expect(shape('980 yen for ramen')[0]?.items).toEqual([['ramen', 980]]);
  });

  it('falls back to the merchant when nothing bought was named', () => {
    expect(shape('spent $4.50 at Blue Bottle')[0]?.items).toEqual([['Blue Bottle', 450]]);
  });

  it('finds nothing in a sentence with no amount', () => {
    expect(read('coffee at Blue Bottle')).toEqual([]);
    expect(read('')).toEqual([]);
  });
});

describe('several things in one recording', () => {
  it('groups items by merchant', () => {
    expect(shape('coffee 4.50 and a muffin 3 at Blue Bottle, and 40 on gas at Shell')).toEqual([
      {
        merchant: 'Blue Bottle',
        items: [
          ['coffee', 450],
          ['muffin', 300],
        ],
        total: 750,
      },
      { merchant: 'Shell', items: [['gas', 4000]], total: 4000 },
    ]);
  });

  it('gives a trailing item to the merchant before it', () => {
    expect(shape('coffee 4.50 at Blue Bottle and a muffin 3')).toEqual([
      {
        merchant: 'Blue Bottle',
        items: [
          ['coffee', 450],
          ['muffin', 300],
        ],
        total: 750,
      },
    ]);
  });

  it('keeps everything together when no merchant is named', () => {
    expect(shape('5 on coffee and 12 on lunch')).toEqual([
      {
        merchant: undefined,
        items: [
          ['coffee', 500],
          ['lunch', 1200],
        ],
        total: 1700,
      },
    ]);
  });

  it('does not split a name or a description that has "and" in it', () => {
    expect(shape('25 at Barnes and Noble')).toEqual([
      { merchant: 'Barnes and Noble', items: [['Barnes and Noble', 2500]], total: 2500 },
    ]);
    expect(shape('fish and chips 12 at the pub')[0]?.items).toEqual([['fish and chips', 1200]]);
  });

  it('merges the same merchant said twice', () => {
    const records = read('4 on coffee at Blue Bottle, 40 on gas at Shell, 3 on a cookie at blue bottle');
    expect(records.map((record) => record.items.length)).toEqual([2, 1]);
  });

  it('applies a day said once to the whole list', () => {
    const records = read('yesterday 4 on coffee at Blue Bottle and 40 on gas at Shell');
    expect(records.map((record) => record.occurredAt?.value)).toEqual([NOW - DAY, NOW - DAY]);
  });

  it('keeps a day said about one record to that record', () => {
    const records = read('40 on gas at Shell on Monday, and 4 on coffee at Blue Bottle today');
    expect(records.map((record) => record.occurredAt?.evidence)).toEqual(['monday', 'today']);
  });
});
