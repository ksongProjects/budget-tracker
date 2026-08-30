/**
 * How safe the user's data actually is, said plainly.
 *
 * ADR 0011 asks the app to protect the user from themselves here: with no
 * server, nobody else notices that backups stopped. The failure this guards
 * against is not "no backups" — it is **believing** there are backups. A
 * connector that is configured and failing is worse than one that was never set
 * up, so a stale or broken cloud reads louder than an absent one.
 */

export type BackupHealth = 'ok' | 'attention' | 'urgent';

export interface BackupFacts {
  readonly isSetUp: boolean;
  readonly lastBackupAt?: number;
  readonly cloudConfigured: boolean;
  readonly cloudSignedIn: boolean;
  readonly lastUploadAt?: number;
  readonly lastError?: string;
}

export interface BackupVerdict {
  readonly health: BackupHealth;
  /** Shown on the nudge. One line, no jargon, no blame. */
  readonly message: string;
}

const DAY = 86_400_000;

/** A backup older than this is stale enough to mention. */
export const STALE_BACKUP_DAYS = 7;

/** A cloud copy this far behind the local one has effectively stopped working. */
export const STALE_UPLOAD_DAYS = 2;

export function backupHealth(facts: BackupFacts, now: number = Date.now()): BackupVerdict {
  if (!facts.isSetUp || facts.lastBackupAt === undefined) {
    return {
      health: 'urgent',
      message: 'No backups yet. If this phone is lost, so is everything in it.',
    };
  }

  const backupAge = now - facts.lastBackupAt;
  if (backupAge > STALE_BACKUP_DAYS * DAY) {
    return {
      health: 'urgent',
      message: `Last backup was ${describeAge(backupAge)} ago.`,
    };
  }

  // A failure that the user has not been told about is the dangerous state, so
  // it outranks staleness even when the last upload was recent.
  if (facts.cloudSignedIn && facts.lastError !== undefined) {
    return { health: 'attention', message: 'Backups are not reaching Google Drive.' };
  }

  if (facts.cloudSignedIn) {
    const uploadAge = facts.lastUploadAt === undefined ? undefined : now - facts.lastUploadAt;

    if (uploadAge === undefined) {
      return { health: 'attention', message: 'Nothing has been uploaded to Drive yet.' };
    }
    if (uploadAge > STALE_UPLOAD_DAYS * DAY) {
      return {
        health: 'attention',
        message: `Drive has nothing newer than ${describeAge(uploadAge)} ago.`,
      };
    }

    return { health: 'ok', message: 'Backed up here and on Drive.' };
  }

  if (facts.cloudConfigured) {
    return {
      health: 'attention',
      message: 'Backups stay on this phone. Connect Drive so they survive it.',
    };
  }

  return { health: 'ok', message: 'Backed up on this device.' };
}

function describeAge(age: number): string {
  const days = Math.floor(age / DAY);
  if (days >= 1) return days === 1 ? 'a day' : `${String(days)} days`;

  const hours = Math.floor(age / 3_600_000);
  if (hours >= 1) return hours === 1 ? 'an hour' : `${String(hours)} hours`;

  return 'minutes';
}
