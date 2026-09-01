import { describe, expect, it } from 'vitest';
import type { Timestamp } from '@budget/schema';
import { fromDay, toDay } from './day';

const at = (iso: string): Timestamp => new Date(iso).getTime() as Timestamp;

describe('toDay', () => {
  it('reads the day the user was standing in the shop, in their own time zone', () => {
    const local = new Date(2026, 2, 14, 9, 12);

    expect(toDay(local.getTime() as Timestamp)).toBe('2026-03-14');
  });
});

describe('fromDay', () => {
  it('keeps the time of day when the day did not change', () => {
    const original = new Date(2026, 2, 14, 9, 12).getTime() as Timestamp;

    expect(fromDay('2026-03-14', original)).toBe(original);
  });

  it('lands at midday when the day changes, clear of any boundary', () => {
    const original = new Date(2026, 2, 14, 9, 12).getTime() as Timestamp;
    const moved = fromDay('2026-04-03', original);

    expect(moved).not.toBeNull();
    const date = new Date(moved ?? 0);
    expect([date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()]).toEqual([
      2026, 4, 3, 12,
    ]);
  });

  it('refuses a day that does not exist rather than rolling it over', () => {
    const original = at('2026-03-14T09:12:00Z');

    expect(fromDay('2026-02-30', original)).toBeNull();
    expect(fromDay('2026-04-31', original)).toBeNull();
    expect(fromDay('2026-13-01', original)).toBeNull();
  });

  it('refuses anything that is not an ISO day', () => {
    const original = at('2026-03-14T09:12:00Z');

    expect(fromDay('14/03/2026', original)).toBeNull();
    expect(fromDay('', original)).toBeNull();
    expect(fromDay('2026-3-4', original)).toBeNull();
  });

  it('round-trips a day the user typed', () => {
    const original = at('2026-03-14T09:12:00Z');
    const moved = fromDay('2027-01-02', original);

    expect(moved === null ? null : toDay(moved)).toBe('2027-01-02');
  });
});
