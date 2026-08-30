import type { Currency, MinorUnits, Transaction } from '@budget/schema';
import { dayLabel, localDayKey } from '@budget/report';

// Re-exported so the screens keep importing their date helpers from one place,
// even though the helpers themselves now live where the web app can use them
// too — a day boundary that differed between the two would put the same spend
// on different days.
export { dayLabel, localDayKey, localMonthKey, monthLabel } from '@budget/report';

/**
 * Turns a page of transactions into the day sections the ledger list renders.
 *
 * Grouping is by *local* day: a coffee bought at 11pm belongs to that evening in
 * the user's head, whatever UTC says.
 */

export interface DaySection {
  /** Local calendar day, `YYYY-MM-DD`. Stable key for the list. */
  readonly dayKey: string;
  readonly label: string;
  /**
   * Sum of the confirmed items in this day, or null when the day mixes
   * currencies — adding those would produce a number that means nothing.
   */
  readonly totalMinor: MinorUnits | null;
  readonly currency: Currency | null;
  /** Confirmed rows only; unconfirmed ones are shown but never counted. */
  readonly pendingCount: number;
  /** `2026-03` when this day opens a month in the list, else null. */
  readonly startsMonth: string | null;
  readonly items: readonly Transaction[];
}

/**
 * Group a newest-first page of transactions into day sections.
 *
 * Input order is preserved rather than re-sorted: the repository already
 * ordered by `occurred_at DESC` using its index, and re-sorting here would
 * quietly disagree with the cursor the next page is fetched from.
 */
export function groupByDay(
  transactions: readonly Transaction[],
  now: number = Date.now(),
): DaySection[] {
  const sections: DaySection[] = [];
  let current: Transaction[] = [];
  let currentKey: string | null = null;
  let lastMonth: string | null = null;

  const flush = (): void => {
    if (currentKey === null || current.length === 0) return;

    const month = currentKey.slice(0, 7);
    const startsMonth = month === lastMonth ? null : month;
    lastMonth = month;

    sections.push(buildSection(currentKey, current, startsMonth, now));
    current = [];
  };

  for (const transaction of transactions) {
    const key = localDayKey(transaction.occurredAt);
    if (key !== currentKey) {
      flush();
      currentKey = key;
    }
    current.push(transaction);
  }
  flush();

  return sections;
}

function buildSection(
  dayKey: string,
  items: Transaction[],
  startsMonth: string | null,
  now: number,
): DaySection {
  const confirmed = items.filter((item) => item.confirmedAt !== null);
  const currencies = new Set(confirmed.map((item) => item.currency));

  // One currency or nothing to add: any other case would need conversion, and
  // guessing a rate to fill a header is worse than showing no number.
  const single = currencies.size === 1 ? [...currencies][0] ?? null : null;
  const total =
    single === null
      ? null
      : (confirmed.reduce((sum, item) => sum + item.amountMinor, 0) as MinorUnits);

  return {
    dayKey,
    label: dayLabel(dayKey, now),
    totalMinor: total,
    currency: single,
    pendingCount: items.length - confirmed.length,
    startsMonth,
    items,
  };
}
