import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import type { CaptureId, MinorUnits, Timestamp } from '@budget/schema';
import { parseSpokenRecords } from '@budget/extract';
import type { StructuredCandidate } from '@budget/extract';
import { draftItems, fromModel, toNewRecord } from './records';

const USD = CurrencySchema.parse('USD');
const NOW = Date.UTC(2026, 2, 18, 12);
const DAY = 86_400_000;

const read = (said: string) => parseSpokenRecords(said, { defaultCurrency: USD, now: NOW });

describe('what a spoken record stores', () => {
  it('keeps the things the speaker named', () => {
    const [record] = read('coffee 4.50 and a muffin 3 at Blue Bottle');
    expect(record && draftItems(record).map((item) => [item.name, item.totalMinor])).toEqual([
      ['coffee', 450],
      ['muffin', 300],
    ]);
  });

  it('keeps one named thing', () => {
    const [record] = read('twelve bucks on coffee at Blue Bottle');
    expect(record && draftItems(record).map((item) => item.name)).toEqual(['coffee']);
  });

  it('stores nothing for an item that only stands in for the whole', () => {
    const [record] = read('spent $4.50 at Blue Bottle');
    expect(record && draftItems(record)).toEqual([]);
  });

  it('becomes a confirmed voice record, dated the day that was said', () => {
    const [record] = read('forty euros at the hardware shop yesterday');
    if (!record) throw new Error('no record');

    expect(toNewRecord(record, 'c' as CaptureId, NOW as Timestamp)).toMatchObject({
      source: 'voice',
      date: NOW - DAY,
      merchant: 'the hardware shop',
      amountMinor: 4000,
      currency: 'EUR',
      confirmed: true,
    });
  });

  it('is dated when it was heard when no day was said', () => {
    const [record] = read('$5 at Blue Bottle');
    if (!record) throw new Error('no record');
    expect(toNewRecord(record, 'c' as CaptureId, NOW as Timestamp).date).toBe(NOW);
  });
});

describe('a model reading', () => {
  const model = (over: Partial<StructuredCandidate>): StructuredCandidate => ({
    engine: 'gemini-nano',
    durationMs: 10,
    ...over,
  });

  it('is ignored when it is only the rules again', () => {
    const [rules] = read('twelve bucks on coffee at Blue Bottle');
    expect(fromModel(model({ engine: 'rules' }), rules)).toBe(rules);
  });

  it('wins where it read something, and keeps the rules for the rest', () => {
    const [rules] = read('twelve fifty on coffee at blue bottle yesterday');
    const merged = fromModel(
      model({
        total: { value: 1250 as MinorUnits, confidence: 0.9, evidence: 'twelve fifty' },
        currency: { value: USD, confidence: 0.4, evidence: 'assumed' },
      }),
      rules,
    );

    expect(merged?.total).toBe(1250);
    expect(merged?.merchant?.value).toBe('blue bottle');
    expect(merged?.occurredAt?.value).toBe(NOW - DAY);
    expect(merged?.items.map((item) => [item.name, item.amount.value])).toEqual([['coffee', 1250]]);
  });

  it('brings its own items when it read them', () => {
    const merged = fromModel(
      model({
        total: { value: 750 as MinorUnits, confidence: 0.9, evidence: '7.50' },
        currency: { value: USD, confidence: 0.9, evidence: '$' },
        lineItems: [
          {
            value: { description: 'Latte', amount: 450 as MinorUnits },
            confidence: 0.8,
            evidence: 'latte 4.50',
          },
          {
            value: { description: 'Muffin', amount: 300 as MinorUnits },
            confidence: 0.8,
            evidence: 'muffin 3',
          },
        ],
      }),
      undefined,
    );

    expect(merged?.items.map((item) => item.name)).toEqual(['Latte', 'Muffin']);
  });

  it('changes nothing when it read no total', () => {
    const [rules] = read('$5 at Blue Bottle');
    expect(fromModel(model({}), rules)).toBe(rules);
  });
});
