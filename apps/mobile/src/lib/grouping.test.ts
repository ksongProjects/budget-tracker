import { describe, expect, it } from 'vitest';
import { CurrencySchema, uuidv7 } from '@budget/schema';
import type { Currency, MinorUnits, Timestamp, Transaction } from '@budget/schema';
import { dayLabel, groupByDay, localDayKey, localMonthKey, monthLabel } from './grouping';

const USD = CurrencySchema.parse('USD');
const EUR = CurrencySchema.parse('EUR');

/** Local midday on a given local calendar date, so tests do not straddle a day boundary. */
const localNoon = (year: number, month: number, day: number): number =>
  new Date(year, month - 1, day, 12, 0, 0).getTime();

const txn = (over: {
  occurredAt: number;
  amountMinor?: number;
  confirmed?: boolean;
  currency?: Currency;
}): Transaction =>
  ({
    id: uuidv7(),
    captureId: null,
    accountId: null,
    merchantId: null,
    categoryId: null,
    amountMinor: (over.amountMinor ?? 100) as MinorUnits,
    currency: over.currency ?? USD,
    occurredAt: over.occurredAt as Timestamp,
    postedAt: null,
    note: null,
    source: 'manual',
    confirmedAt: (over.confirmed ?? true) ? (1 as Timestamp) : null,
    fxOriginalMinor: null,
    fxOriginalCurrency: null,
    fxRate: null,
    reconciled: false,
    rev: 1,
    updatedAt: 1 as Timestamp,
    deletedAt: null,
    originDevice: 'device-a',
  }) as Transaction;

describe('day and month keys', () => {
  it('keys by local calendar day', () => {
    expect(localDayKey(localNoon(2026, 3, 14))).toBe('2026-03-14');
    expect(localMonthKey(localNoon(2026, 3, 14))).toBe('2026-03');
  });

  it('keeps a late-evening spend on that evening, not the next UTC day', () => {
    const lateEvening = new Date(2026, 2, 14, 23, 30, 0).getTime();
    expect(localDayKey(lateEvening)).toBe('2026-03-14');
  });

  it('pads single-digit months and days', () => {
    expect(localDayKey(localNoon(2026, 1, 5))).toBe('2026-01-05');
  });
});

describe('labels', () => {
  const now = localNoon(2026, 3, 14);

  it('names today and yesterday', () => {
    expect(dayLabel('2026-03-14', now)).toBe('Today');
    expect(dayLabel('2026-03-13', now)).toBe('Yesterday');
  });

  it('uses the weekday within the past week', () => {
    // 2026-03-11 is a Wednesday.
    expect(dayLabel('2026-03-11', now)).toBe('Wednesday');
  });

  it('uses a date beyond a week', () => {
    expect(dayLabel('2026-02-20', now)).toBe('Feb 20');
  });

  it('includes the year for another year', () => {
    expect(dayLabel('2025-12-25', now)).toBe('Dec 25, 2025');
  });

  it('spells out month headers', () => {
    expect(monthLabel('2026-03')).toBe('March 2026');
    expect(monthLabel('2025-12')).toBe('December 2025');
  });
});

describe('groupByDay', () => {
  const now = localNoon(2026, 3, 14);

  it('groups consecutive transactions of the same day', () => {
    const sections = groupByDay(
      [
        txn({ occurredAt: localNoon(2026, 3, 14), amountMinor: 100 }),
        txn({ occurredAt: localNoon(2026, 3, 14), amountMinor: 250 }),
        txn({ occurredAt: localNoon(2026, 3, 13), amountMinor: 500 }),
      ],
      now,
    );

    expect(sections).toHaveLength(2);
    expect(sections[0]?.label).toBe('Today');
    expect(sections[0]?.items).toHaveLength(2);
    expect(sections[0]?.totalMinor).toBe(350);
    expect(sections[1]?.label).toBe('Yesterday');
  });

  it('preserves the order the repository returned', () => {
    const sections = groupByDay(
      [
        txn({ occurredAt: localNoon(2026, 3, 14), amountMinor: 100 }),
        txn({ occurredAt: localNoon(2026, 3, 14), amountMinor: 250 }),
      ],
      now,
    );
    expect(sections[0]?.items.map((i) => i.amountMinor)).toEqual([100, 250]);
  });

  it('excludes unconfirmed rows from the day total but still shows them', () => {
    const sections = groupByDay(
      [
        txn({ occurredAt: localNoon(2026, 3, 14), amountMinor: 100 }),
        txn({ occurredAt: localNoon(2026, 3, 14), amountMinor: 9999, confirmed: false }),
      ],
      now,
    );

    expect(sections[0]?.items).toHaveLength(2);
    expect(sections[0]?.totalMinor).toBe(100);
    expect(sections[0]?.pendingCount).toBe(1);
  });

  it('refuses to total a day that mixes currencies', () => {
    const sections = groupByDay(
      [
        txn({ occurredAt: localNoon(2026, 3, 14), amountMinor: 100, currency: USD }),
        txn({ occurredAt: localNoon(2026, 3, 14), amountMinor: 200, currency: EUR }),
      ],
      now,
    );

    // Adding these would produce a number that means nothing.
    expect(sections[0]?.totalMinor).toBeNull();
    expect(sections[0]?.currency).toBeNull();
    expect(sections[0]?.items).toHaveLength(2);
  });

  it('marks the first day of each month for a header', () => {
    const sections = groupByDay(
      [
        txn({ occurredAt: localNoon(2026, 3, 14) }),
        txn({ occurredAt: localNoon(2026, 3, 1) }),
        txn({ occurredAt: localNoon(2026, 2, 27) }),
      ],
      now,
    );

    expect(sections[0]?.startsMonth).toBe('2026-03');
    expect(sections[1]?.startsMonth).toBeNull();
    expect(sections[2]?.startsMonth).toBe('2026-02');
  });

  it('returns nothing for no transactions', () => {
    expect(groupByDay([], now)).toEqual([]);
  });

  it('gives every section a distinct key, which the list depends on', () => {
    const sections = groupByDay(
      [
        txn({ occurredAt: localNoon(2026, 3, 14) }),
        txn({ occurredAt: localNoon(2026, 3, 13) }),
        txn({ occurredAt: localNoon(2026, 3, 12) }),
      ],
      now,
    );
    const keys = sections.map((s) => s.dayKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('totals a day with no confirmed rows as zero, not null', () => {
    const sections = groupByDay(
      [txn({ occurredAt: localNoon(2026, 3, 14), confirmed: false })],
      now,
    );
    // No currencies present means nothing to disagree about, so the day reads 0.
    expect(sections[0]?.totalMinor).toBeNull();
    expect(sections[0]?.pendingCount).toBe(1);
  });
});
