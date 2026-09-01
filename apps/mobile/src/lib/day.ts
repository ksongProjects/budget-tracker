import type { Timestamp } from '@budget/schema';

/**
 * A calendar day as a user types it: `YYYY-MM-DD`.
 *
 * A date on a receipt is the one field a user is most likely to have to fix —
 * `03/04` is March in the US and April everywhere else, and the rules say so
 * with a low confidence rather than a guess. Typing it needs no picker and no
 * native module; it needs a format that cannot be read two ways, which is what
 * ISO is for.
 *
 * Days are held in local time. The receipt says the 14th because that is the
 * day the person was standing in the shop, and re-reading it in UTC moves it
 * for everyone west of Greenwich.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toDay(at: Timestamp): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/**
 * Midday local time on the day typed, or null while it is not yet a date.
 *
 * Midday, not midnight: a timestamp on the boundary lands on the day before in
 * any code that shifts it by an hour, and a spend that moves to the previous
 * day when the clocks change is a bug users report as lost money.
 */
export function fromDay(typed: string, at: Timestamp): Timestamp | null {
  const match = ISO_DAY.exec(typed.trim());
  if (!match) return null;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const existing = new Date(at);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);

  // A day that does not exist — the 31st of a 30-day month — rolls over in the
  // Date constructor. Rolling over silently would file a spend in the wrong
  // month, so it is rejected instead.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;

  // Keep the time of day when only the day changed, so a receipt read at 09:12
  // does not become midday because the user corrected the month.
  if (toDay(at) !== typed.trim()) return date.getTime() as Timestamp;
  return existing.getTime() as Timestamp;
}
