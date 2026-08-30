import * as FileSystem from 'expo-file-system/legacy';
import { DEFAULT_RETENTION, planRetention } from '@budget/backup';
import type { CloudConnector, RemoteArchive } from '@budget/backup';
import { listBackups, readBackupFile } from '../backup/service';
import { isDriveConfigured, isSignedIn } from './auth';
import { createDriveConnector } from './drive';

/**
 * Getting archives off the device.
 *
 * A backup that only exists on the phone does not survive the phone. This is
 * the part that makes the durability story true, and it is also the part most
 * likely to be quietly broken — a connector that is configured but failing is
 * worse than none at all, because it feels safe. So every outcome is recorded
 * and shown ([drive-connector.md](../../../../docs/drive-connector.md)).
 */

const STATE_FILE = `${FileSystem.documentDirectory ?? ''}backups/cloud-state.json`;

export interface CloudState {
  /** When an archive was last confirmed stored by the remote. */
  readonly lastUploadAt?: number;
  readonly lastUploadName?: string;
  /** Why the last attempt failed, if it did. Cleared by a success. */
  readonly lastError?: string;
  readonly lastAttemptAt?: number;
}

export interface CloudStatus extends CloudState {
  /** Whether this build has an OAuth client id at all. */
  readonly configured: boolean;
  readonly signedIn: boolean;
}

export async function cloudStatus(): Promise<CloudStatus> {
  const [signedIn, state] = await Promise.all([isSignedIn(), readState()]);
  return { configured: isDriveConfigured(), signedIn, ...state };
}

export interface UploadOutcome {
  readonly uploaded?: RemoteArchive;
  readonly pruned: number;
  readonly skipped?: 'not-configured' | 'not-signed-in' | 'nothing-to-upload' | 'already-there';
}

/**
 * Put the newest local archive in the cloud, then apply retention there.
 *
 * Only the newest: the older ones on this device are its own history, and
 * uploading them would spend the user's data to duplicate what the newest
 * archive already contains in full.
 */
export async function uploadNewestBackup(
  connector: CloudConnector = createDriveConnector(),
  onProgress?: (sent: number, total: number) => void,
): Promise<UploadOutcome> {
  if (!isDriveConfigured()) return { pruned: 0, skipped: 'not-configured' };
  if (!(await isSignedIn())) return { pruned: 0, skipped: 'not-signed-in' };

  const newest = (await listBackups())[0];
  if (newest === undefined) return { pruned: 0, skipped: 'nothing-to-upload' };

  const name = newest.path.split('/').at(-1) ?? '';

  try {
    const remote = await connector.list();

    // Re-uploading an archive that is already up there costs the user megabytes
    // to change nothing: names carry the device and the timestamp, so identity
    // is decidable without downloading anything.
    if (remote.some((archive) => archive.name === name)) {
      const pruned = await pruneRemote(connector, remote);
      await writeState({ lastAttemptAt: Date.now() });
      return { pruned, skipped: 'already-there' };
    }

    const bytes = await readBackupFile(newest.path);
    const uploaded = await connector.upload(name, bytes, (progress) => {
      onProgress?.(progress.sent, progress.total);
    });

    const pruned = await pruneRemote(connector, [...remote, uploaded]);

    await writeState({
      lastUploadAt: Date.now(),
      lastUploadName: uploaded.name,
      lastAttemptAt: Date.now(),
    });

    return { uploaded, pruned };
  } catch (cause) {
    // Recorded rather than swallowed: silence here is how a user ends up
    // believing they have cloud backups they do not have.
    const message = cause instanceof Error ? cause.message : String(cause);
    await writeState({ lastError: message, lastAttemptAt: Date.now() }, { keepUpload: true });
    throw cause;
  }
}

/** Apply the retention policy to what is in the cloud. Returns how many were deleted. */
export async function pruneRemote(
  connector: CloudConnector,
  known?: readonly RemoteArchive[],
): Promise<number> {
  const remote = known ?? (await connector.list());
  const { prune } = planRetention(remote, DEFAULT_RETENTION);

  for (const archive of prune) {
    await connector.remove(archive.id);
  }

  return prune.length;
}

/** Archives in the cloud, newest first. */
export async function listRemote(
  connector: CloudConnector = createDriveConnector(),
): Promise<RemoteArchive[]> {
  const remote = await connector.list();
  return [...remote].sort((a, b) => b.createdAt - a.createdAt);
}

export async function downloadRemote(
  id: string,
  connector: CloudConnector = createDriveConnector(),
): Promise<Uint8Array> {
  return connector.download(id);
}

async function readState(): Promise<CloudState> {
  try {
    const text = await FileSystem.readAsStringAsync(STATE_FILE, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    return JSON.parse(text) as CloudState;
  } catch {
    return {};
  }
}

async function writeState(
  next: CloudState,
  options: { keepUpload?: boolean } = {},
): Promise<void> {
  const previous = options.keepUpload === true ? await readState() : {};
  const merged: CloudState = {
    ...(options.keepUpload === true
      ? {
          ...(previous.lastUploadAt === undefined ? {} : { lastUploadAt: previous.lastUploadAt }),
          ...(previous.lastUploadName === undefined
            ? {}
            : { lastUploadName: previous.lastUploadName }),
        }
      : {}),
    ...next,
  };

  await FileSystem.writeAsStringAsync(STATE_FILE, JSON.stringify(merged), {
    encoding: FileSystem.EncodingType.UTF8,
  });
}
