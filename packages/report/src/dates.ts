/**
 * Calendar helpers, in the user's own timezone.
 *
 * Shared because a day boundary that differs between the phone and the browser
 * would put the same spend on two different days, and the totals underneath it
 * would disagree for reasons no user could ever diagnose.
 */

export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function localMonthKey(timestamp: number): string {
  return localDayKey(timestamp).slice(0, 7);
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Day labels people actually use. "Today" and "Yesterday" beat a date, and
 * within the last week the weekday name is easier to place than a number.
 */
export function dayLabel(dayKey: string, now: number): string {
  const today = localDayKey(now);
  if (dayKey === today) return 'Today';

  const yesterday = localDayKey(now - 86_400_000);
  if (dayKey === yesterday) return 'Yesterday';

  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);

  const daysAgo = Math.floor((new Date(now).setHours(0, 0, 0, 0) - date.getTime()) / 86_400_000);
  if (daysAgo > 0 && daysAgo < 7) {
    return WEEKDAY[date.getDay()] ?? dayKey;
  }

  const monthName = MONTH[date.getMonth()] ?? '';
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear
    ? `${monthName} ${String(date.getDate())}`
    : `${monthName} ${String(date.getDate())}, ${String(date.getFullYear())}`;
}

export function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  const full = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${full[(month ?? 1) - 1] ?? ''} ${String(year ?? '')}`;
}
