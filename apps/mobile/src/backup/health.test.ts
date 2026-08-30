import { describe, expect, it } from 'vitest';
import { backupHealth } from './health';
import type { BackupFacts } from './health';

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const DAY = 86_400_000;

/**
 * Overrides may say `lastUploadAt: undefined` to mean "there isn't one", which
 * with exactOptionalPropertyTypes is a different thing from the property being
 * present. Undefined entries are dropped rather than assigned.
 */
type Overrides = { [K in keyof BackupFacts]?: BackupFacts[K] | undefined };

const facts = (over: Overrides = {}): BackupFacts => {
  const base: Overrides = {
    isSetUp: true,
    lastBackupAt: NOW - 3_600_000,
    cloudConfigured: true,
    cloudSignedIn: true,
    lastUploadAt: NOW - 3_600_000,
    ...over,
  };

  return Object.fromEntries(
    Object.entries(base).filter(([, value]) => value !== undefined),
  ) as unknown as BackupFacts;
};

describe('backup health', () => {
  it('is urgent before any backup exists', () => {
    const verdict = backupHealth(facts({ isSetUp: false, lastBackupAt: undefined }), NOW);

    expect(verdict.health).toBe('urgent');
    expect(verdict.message).toContain('No backups yet');
  });

  it('is urgent when the last backup is over a week old', () => {
    const verdict = backupHealth(facts({ lastBackupAt: NOW - 9 * DAY }), NOW);

    expect(verdict.health).toBe('urgent');
    expect(verdict.message).toContain('9 days');
  });

  it('says a failing connector is failing, even with a recent upload', () => {
    // The dangerous state is believing there are cloud backups. It outranks
    // staleness precisely because everything else looks fine.
    const verdict = backupHealth(facts({ lastError: 'Network request failed' }), NOW);

    expect(verdict.health).toBe('attention');
    expect(verdict.message).toContain('not reaching Google Drive');
  });

  it('notices a connected Drive that has never received anything', () => {
    const verdict = backupHealth(facts({ lastUploadAt: undefined }), NOW);

    expect(verdict.health).toBe('attention');
  });

  it('notices a Drive copy that has fallen behind', () => {
    const verdict = backupHealth(facts({ lastUploadAt: NOW - 3 * DAY }), NOW);

    expect(verdict.health).toBe('attention');
    expect(verdict.message).toContain('3 days');
  });

  it('nudges towards Drive when the build supports it and the user has not connected', () => {
    const verdict = backupHealth(facts({ cloudSignedIn: false, lastUploadAt: undefined }), NOW);

    expect(verdict.health).toBe('attention');
    expect(verdict.message).toContain('survive');
  });

  it('is quiet when local and cloud are both current', () => {
    expect(backupHealth(facts(), NOW).health).toBe('ok');
  });

  it('does not nag about Drive in a build that has no client id', () => {
    // Nothing the user can do about it, so saying it every day is noise.
    const verdict = backupHealth(
      facts({ cloudConfigured: false, cloudSignedIn: false, lastUploadAt: undefined }),
      NOW,
    );

    expect(verdict.health).toBe('ok');
  });
});
