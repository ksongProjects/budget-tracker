import { describe, expect, it } from 'vitest';
import { archiveName, parseArchiveName, planRetention, shortDevice } from './naming.js';

const DEVICE = '01a0f3c2-aaaa-bbbb-cccc-ddddeeeeffff';

describe('archive names', () => {
  it('round-trips the device and the time', () => {
    const at = Date.UTC(2026, 7, 30, 18, 49, 41, 726);
    const name = archiveName(DEVICE, at);

    expect(name).toBe('btbk-v1-01a0-2026-08-30T18-49-41-726Z.btbk');
    expect(parseArchiveName(name)).toEqual({ device: '01a0', createdAt: at });
  });

  it('refuses names that are not ours', () => {
    // Not a failure — someone else's file in the same folder. Retention leans on
    // this to leave unknown files alone.
    expect(parseArchiveName('notes.txt')).toBeUndefined();
    expect(parseArchiveName('btbk-v2-01a0-2026-08-30T18-49-41-726Z.btbk')).toBeUndefined();
    expect(parseArchiveName('btbk-v1-01a0-nonsense.btbk')).toBeUndefined();
    expect(parseArchiveName('btbk-v1-01a0-2026-13-40T99-99-99-999Z.btbk')).toBeUndefined();
  });

  it('keeps a partial file out of the archive namespace', () => {
    expect(parseArchiveName('btbk-v1-01a0-2026-08-30T18-49-41-726Z.btbk.partial')).toBeUndefined();
  });

  it('shortens a device id the same way everywhere', () => {
    expect(shortDevice(DEVICE)).toBe('01a0');
  });
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

/** `daysAgo` back from NOW, so cases read as "a week old" rather than as epochs. */
function named(device: string, daysAgo: number): { name: string } {
  return { name: archiveName(device, NOW - daysAgo * DAY) };
}

describe('retention', () => {
  const policy = { keepPerDevice: 3, keepMonths: 3 };

  it('keeps everything while under the cap', () => {
    const archives = [named('aaaa', 0), named('aaaa', 1)];
    const plan = planRetention(archives, policy, NOW);

    expect(plan.prune).toEqual([]);
    expect(plan.keep).toHaveLength(2);
  });

  it('drops the oldest past the cap', () => {
    const archives = [named('aaaa', 0), named('aaaa', 1), named('aaaa', 2), named('aaaa', 3)];
    const plan = planRetention(archives, policy, NOW);

    expect(plan.prune).toEqual([archives[3]]);
  });

  it('counts each device separately', () => {
    // A phone that backs up hourly must not push a laptop's only archive out.
    const archives = [
      named('aaaa', 0),
      named('aaaa', 1),
      named('aaaa', 2),
      named('aaaa', 3),
      named('bbbb', 10),
    ];

    const plan = planRetention(archives, policy, NOW);

    expect(plan.prune).toEqual([archives[3]]);
    expect(plan.keep).toContain(archives[4]);
  });

  it('keeps the newest archive of each recent month beyond the cap', () => {
    // Four this month plus one from each of the two months before. The cap
    // alone would delete all three older ones; the monthly rule saves the
    // newest of each month, which is what a mistake noticed late needs.
    const archives = [
      named('aaaa', 0),
      named('aaaa', 1),
      named('aaaa', 2),
      named('aaaa', 3),
      named('aaaa', 35),
      named('aaaa', 36),
      named('aaaa', 65),
    ];

    const plan = planRetention(archives, policy, NOW);

    expect(plan.keep).toContain(archives[4]);
    expect(plan.keep).toContain(archives[6]);
    // The second July archive is neither in the newest three nor its month's newest.
    expect(plan.prune).toContain(archives[5]);
    expect(plan.prune).toContain(archives[3]);
  });

  it('drops archives older than the monthly window', () => {
    const archives = [
      named('aaaa', 0),
      named('aaaa', 1),
      named('aaaa', 2),
      named('aaaa', 3),
      named('aaaa', 200),
    ];

    const plan = planRetention(archives, policy, NOW);

    // The 200-day-old one falls outside both the cap and the three-month
    // window, and the four-day-old one is not its month's newest.
    expect(plan.prune).toHaveLength(2);
    expect(plan.prune).toContain(archives[4]);
    expect(plan.prune).toContain(archives[3]);
  });

  it('never deletes a file it cannot read the name of', () => {
    const archives = [
      { name: 'something-else.bin' },
      named('aaaa', 0),
      named('aaaa', 1),
      named('aaaa', 2),
      named('aaaa', 3),
    ];

    const plan = planRetention(archives, policy, NOW);

    expect(plan.keep).toContain(archives[0]);
    expect(plan.prune).toEqual([archives[4]]);
  });

  it('prefers the timestamp a listing reports over the one in the name', () => {
    // Drive reports createdTime; a name could have been written by a device
    // with a wrong clock, and the server's view is the one both sides share.
    const stale = { name: archiveName('aaaa', NOW - 400 * DAY), createdAt: NOW };
    const plan = planRetention([stale, named('aaaa', 1), named('aaaa', 2)], policy, NOW);

    expect(plan.prune).toEqual([]);
  });
});
