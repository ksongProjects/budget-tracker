/**
 * Archive names, and the retention policy built on them.
 *
 * The name is the only thing a connector can read without downloading the file
 * — Drive lists names, sizes and dates, and nothing else about an archive is
 * legible to anyone. So the name carries what pruning needs: which device wrote
 * it and when. See [backup-format.md](../../../docs/backup-format.md).
 *
 * Nothing here touches a filesystem or a network. The same policy runs against
 * the phone's own directory and against a listing from Drive.
 */

const PREFIX = 'btbk';
const VERSION = 'v1';
const EXTENSION = '.btbk';

export interface ArchiveName {
  /** First characters of the device id that wrote it. */
  readonly device: string;
  readonly createdAt: number;
}

/**
 * `btbk-v1-<device>-<timestamp>.btbk`.
 *
 * The timestamp is ISO 8601 with `:` and `.` replaced, because those are not
 * safe in filenames on every platform an archive may pass through.
 */
export function archiveName(deviceId: string, createdAt: number): string {
  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  return `${PREFIX}-${VERSION}-${shortDevice(deviceId)}-${stamp}${EXTENSION}`;
}

/** The device id as it appears in a name: short enough to read, long enough to separate devices. */
export function shortDevice(deviceId: string): string {
  return deviceId.slice(0, 4);
}

/**
 * Read a name back, or `undefined` if it is not one of ours.
 *
 * Undefined is not a failure: an unrecognised file in the same folder belongs to
 * someone else, and retention must leave it alone rather than guess.
 */
export function parseArchiveName(name: string): ArchiveName | undefined {
  if (!name.endsWith(EXTENSION)) return undefined;

  const body = name.slice(0, -EXTENSION.length);
  const parts = body.split('-');

  // btbk | v1 | device | YYYY | MM | DDTHH | mm | ss | mmmZ
  if (parts.length !== 9) return undefined;
  const [prefix, version, device, year, month, dayHour, minute, second, milli] = parts;
  if (prefix !== PREFIX || version !== VERSION || device === undefined) return undefined;

  const iso = `${String(year)}-${String(month)}-${String(dayHour)}:${String(minute)}:${String(second)}.${String(milli)}`;
  const createdAt = Date.parse(iso);
  if (Number.isNaN(createdAt)) return undefined;

  return { device, createdAt };
}

export interface RetentionPolicy {
  /** Newest archives kept per device, whatever their age. */
  readonly keepPerDevice: number;
  /**
   * Also keep the newest archive of each of the last N calendar months, per
   * device. A daily backup habit otherwise leaves nothing older than a week —
   * and the mistake a user needs to undo is often older than that.
   */
  readonly keepMonths: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { keepPerDevice: 10, keepMonths: 3 };

export interface RetentionCandidate {
  readonly name: string;
  /** Used when the name does not carry one, e.g. a listing that reports its own date. */
  readonly createdAt?: number;
}

export interface RetentionPlan<T extends RetentionCandidate> {
  readonly keep: readonly T[];
  readonly prune: readonly T[];
}

/**
 * Decide what to delete.
 *
 * Per device, because archives from a phone and a laptop are not substitutes
 * for one another: pruning globally would let a chatty device push a quiet
 * one's only backup off the end.
 *
 * Anything whose name cannot be parsed is kept. Deleting a file we do not
 * understand, in a folder that holds the user's only copy of their data, is not
 * a risk worth taking to save a few megabytes.
 */
export function planRetention<T extends RetentionCandidate>(
  candidates: readonly T[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: number = Date.now(),
): RetentionPlan<T> {
  const keep: T[] = [];
  const byDevice = new Map<string, { candidate: T; createdAt: number }[]>();

  for (const candidate of candidates) {
    const parsed = parseArchiveName(candidate.name);
    if (parsed === undefined) {
      keep.push(candidate);
      continue;
    }

    const createdAt = candidate.createdAt ?? parsed.createdAt;
    const bucket = byDevice.get(parsed.device);
    if (bucket) bucket.push({ candidate, createdAt });
    else byDevice.set(parsed.device, [{ candidate, createdAt }]);
  }

  const prune: T[] = [];
  const recentMonths = lastMonths(now, policy.keepMonths);

  for (const bucket of byDevice.values()) {
    const newestFirst = [...bucket].sort((a, b) => b.createdAt - a.createdAt);
    const kept = new Set(newestFirst.slice(0, policy.keepPerDevice).map((entry) => entry.candidate));

    for (const month of recentMonths) {
      const newestInMonth = newestFirst.find((entry) => monthKey(entry.createdAt) === month);
      if (newestInMonth) kept.add(newestInMonth.candidate);
    }

    for (const entry of newestFirst) {
      if (kept.has(entry.candidate)) keep.push(entry.candidate);
      else prune.push(entry.candidate);
    }
  }

  return { keep, prune };
}

function monthKey(at: number): string {
  const date = new Date(at);
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function lastMonths(now: number, count: number): string[] {
  const months: string[] = [];
  const date = new Date(now);

  for (let back = 0; back < count; back += 1) {
    months.push(monthKey(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - back, 1)));
  }

  return months;
}
