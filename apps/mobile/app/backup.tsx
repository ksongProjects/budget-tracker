import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { formatRecoveryKey, generateRecoveryKey, parseRecoveryKey } from '@budget/crypto';
import { useLedger } from '../src/db/provider';
import { createNativeSodiumBackend } from '../src/crypto/backend';
import { hasKeyMaterial, loadOrCreateKeyMaterial } from '../src/backup/keys';
import {
  KEEP_BACKUPS,
  createBackup,
  deriveArchiveSecret,
  listBackups,
  readBackupFile,
  restoreBackup,
} from '../src/backup/service';
import { MIN_INTERVAL_HOURS } from '../src/backup/auto';
import { signIn, signOut } from '../src/cloud/auth';
import { cloudStatus, downloadRemote, listRemote, uploadNewestBackup } from '../src/cloud/sync';
import type { CloudStatus } from '../src/cloud/sync';
import type { RemoteArchive } from '@budget/backup';
import { MIN_TOUCH_TARGET, colors, radius, spacing, text } from '../src/ui/theme';

type Stage =
  | 'loading'
  | 'idle'
  | 'password'
  | 'recovery-shown'
  | 'recovery-verify'
  | 'done'
  | 'restore';

/**
 * Enabling backup, which is also the recovery-key ceremony.
 *
 * There is no server and no operator. Losing both the password and the recovery
 * key means the backups are unreadable by anyone, forever — so the key is shown
 * once and the user has to type part of it back before the flow completes.
 * Making that skippable would turn "recovery key" into decoration.
 *
 * Restore is reachable from the very first screen, before any setup. The device
 * that needs it most is a new one that has never had this app on it: offering
 * restore only after setup would put it behind the door it is meant to open.
 */
export default function BackupScreen(): ReactNode {
  const ledger = useLedger();

  const [stage, setStage] = useState<Stage>('loading');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState<Uint8Array | null>(null);
  const [typedBack, setTypedBack] = useState('');
  const [restoreSecret, setRestoreSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<{ count: number; newest?: number }>({ count: 0 });
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [remote, setRemote] = useState<RemoteArchive[]>([]);

  const printed = recoveryKey ? formatRecoveryKey(recoveryKey) : '';

  // Backup being set up is a fact about the device, not about this screen's
  // lifetime. Without this, reopening the screen offers to set up again and
  // would mint a second recovery key against the same master key.
  const refresh = useCallback(async (): Promise<void> => {
    const [isSetUp, backups, status] = await Promise.all([
      hasKeyMaterial(),
      listBackups(),
      cloudStatus(),
    ]);
    setExisting({ count: backups.length, ...(backups[0] ? { newest: backups[0].createdAt } : {}) });
    setCloud(status);
    setStage(isSetUp ? 'done' : 'idle');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const begin = (): void => {
    setError(null);
    setStatus(null);
    setStage('password');
  };

  const mintRecoveryKey = async (): Promise<void> => {
    if (password.length < 8) {
      setError('Use at least 8 characters. This password protects every backup.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const sodium = await createNativeSodiumBackend();
      await loadOrCreateKeyMaterial(sodium);
      setRecoveryKey(generateRecoveryKey(sodium));
      setStage('recovery-shown');
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  /** The user types the last group back, so a key nobody recorded cannot slip through. */
  const expectedGroup = printed.split('-').at(-1) ?? '';

  const verifyAndBackUp = async (): Promise<void> => {
    if (typedBack.trim().toUpperCase() !== expectedGroup) {
      setError('That does not match the last group of your recovery key.');
      return;
    }
    if (!recoveryKey) return;

    setBusy(true);
    setError(null);
    setStatus('Writing your first backup…');

    try {
      const result = await createBackup(ledger, { password, recoveryKey });
      setStatus(
        `Backed up ${formatSize(result.bytes)} at ${new Date(result.createdAt).toLocaleTimeString()}.`,
      );
      setPassword('');
      setRecoveryKey(null);
      setTypedBack('');
      await refresh();
    } catch (cause) {
      setError(describe(cause));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const backUpAgain = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus('Backing up…');
    try {
      // No password and no recovery key: the stored wraps carry both paths
      // forward from the ceremony, which is what lets this run unattended too.
      const result = await createBackup(ledger);
      setStatus(
        `Backed up ${formatSize(result.bytes)}.` +
          (result.pruned === 0 ? '' : ` Removed ${String(result.pruned)} older.`),
      );
      await refresh();
    } catch (cause) {
      setError(describe(cause));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const connectDrive = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const connected = await signIn();
      setStatus(connected ? 'Connected to Google Drive.' : 'Not connected.');
      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const disconnectDrive = async (): Promise<void> => {
    setBusy(true);
    try {
      await signOut();
      setStatus('Disconnected. Your archives on Drive were left alone.');
      setRemote([]);
      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const uploadNow = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus('Uploading…');
    try {
      const outcome = await uploadNewestBackup(undefined, (sent, total) => {
        setStatus(`Uploading ${String(Math.floor((sent / total) * 100))}%…`);
      });

      setStatus(
        outcome.skipped === 'already-there'
          ? 'Drive already has the newest backup.'
          : outcome.uploaded === undefined
            ? 'Nothing to upload yet.'
            : `Uploaded ${formatSize(outcome.uploaded.size)}.` +
              (outcome.pruned === 0 ? '' : ` Removed ${String(outcome.pruned)} older from Drive.`),
      );
      await refresh();
    } catch (cause) {
      setError(describe(cause));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const loadRemote = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setRemote(await listRemote());
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const runRestore = async (source: 'latest' | 'file' | { readonly remoteId: string }): Promise<void> => {
    if (restoreSecret.trim().length === 0) {
      setError('Enter your backup password, or your recovery key.');
      return;
    }

    setBusy(true);
    setError(null);
    setStatus('Restoring…');

    try {
      const bytes =
        typeof source === 'object'
          ? await downloadRemote(source.remoteId)
          : source === 'file'
            ? await pickArchive()
            : await readLatestArchive();
      if (!bytes) {
        setStatus(null);
        return;
      }

      const sodium = await createNativeSodiumBackend();

      // A recovery key is recognisable by its shape; anything else is a
      // password, stretched with the salt the archive itself carries.
      const parsed = parseRecoveryKey(restoreSecret);
      const secret = parsed ?? (await deriveArchiveSecret(bytes, restoreSecret, sodium));

      const startedAt = Date.now();
      const result = await restoreBackup(ledger, bytes, secret, sodium);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

      const total = (field: 'inserted' | 'updated' | 'kept'): number =>
        Object.values(result.merged).reduce((sum, stats) => sum + stats[field], 0);

      setStatus(
        `Restored a backup from ${new Date(result.createdAt).toLocaleString()} in ${seconds}s: ` +
          `${String(total('inserted'))} rows added, ${String(total('updated'))} updated, ` +
          `${String(total('kept'))} already current, ${String(result.documents)} photos.`,
      );
      setRestoreSecret('');
      await refresh();
    } catch (cause) {
      setError(describeRestoreFailure(cause));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const readLatestArchive = async (): Promise<Uint8Array | undefined> => {
    const latest = (await listBackups())[0];
    if (!latest) {
      setError('There are no backups on this device. Choose a backup file instead.');
      return undefined;
    }
    return readBackupFile(latest.path);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {stage === 'loading' && <Text style={text.muted}>Checking…</Text>}

      {stage === 'idle' && (
        <>
          <Text style={text.body}>
            Backups are the only copy of your data. There is no server and no account —
            if you lose your phone without a backup, the ledger is gone.
          </Text>
          <Pressable accessibilityRole="button" style={styles.primary} onPress={begin}>
            <Text style={styles.primaryText}>Set up backup</Text>
          </Pressable>
          <Pressable accessibilityRole="button"
            style={styles.secondary}
            onPress={() => {
              setStage('restore');
              setError(null);
              setStatus(null);
            }}
          >
            <Text style={styles.secondaryText}>I already have a backup</Text>
          </Pressable>
        </>
      )}

      {stage === 'password' && (
        <>
          <Text style={text.heading}>Choose a backup password</Text>
          <Text style={text.muted}>
            This password encrypts every backup. It never leaves this device.
          </Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Backup password"
            placeholderTextColor={colors.textFaint}
            secureTextEntry
            style={styles.input}
          />
          <Pressable accessibilityRole="button" style={styles.primary} onPress={() => void mintRecoveryKey()} disabled={busy}>
            <Text style={styles.primaryText}>{busy ? 'Working…' : 'Continue'}</Text>
          </Pressable>
        </>
      )}

      {stage === 'recovery-shown' && (
        <>
          <Text style={text.heading}>Save your recovery key</Text>
          <View style={styles.keyBox}>
            <Text style={styles.keyText}>{printed}</Text>
          </View>
          <Text style={styles.warn}>
            This is shown once. If you forget your password and lose this key, your backups
            cannot be opened by you, by us, or by anyone. There is no reset.
          </Text>
          <Pressable accessibilityRole="button"
            style={styles.secondary}
            onPress={() => void Clipboard.setStringAsync(printed)}
          >
            <Text style={styles.secondaryText}>Copy to clipboard</Text>
          </Pressable>
          <Pressable accessibilityRole="button"
            style={styles.primary}
            onPress={() => {
              setStage('recovery-verify');
              setTypedBack('');
              setError(null);
            }}
          >
            <Text style={styles.primaryText}>I have saved it</Text>
          </Pressable>
        </>
      )}

      {stage === 'recovery-verify' && (
        <>
          <Text style={text.heading}>Type the last group back</Text>
          <Text style={text.muted}>
            The last group of your recovery key — the {String(expectedGroup.length)} characters
            after the final dash — to confirm you really have it.
          </Text>
          <TextInput
            value={typedBack}
            onChangeText={setTypedBack}
            placeholder="Last group"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="characters"
            style={styles.input}
          />
          <Pressable accessibilityRole="button" style={styles.primary} onPress={() => void verifyAndBackUp()} disabled={busy}>
            <Text style={styles.primaryText}>{busy ? 'Backing up…' : 'Confirm and back up'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button"
            style={styles.secondary}
            onPress={() => {
              setStage('recovery-shown');
              setError(null);
            }}
          >
            <Text style={styles.secondaryText}>Show the key again</Text>
          </Pressable>
        </>
      )}

      {stage === 'done' && (
        <>
          <Text style={text.heading}>Backup is on</Text>
          <Text style={text.muted}>
            {existing.newest === undefined
              ? 'No archive has been written yet.'
              : `Last backup ${new Date(existing.newest).toLocaleString()} — ` +
                `${String(existing.count)} kept on this device, newest ${String(KEEP_BACKUPS)} are.`}
          </Text>
          <Text style={text.faint}>
            A backup is written when you leave the app, at most once every{' '}
            {String(MIN_INTERVAL_HOURS)} hours and only when something changed. Neither your
            password nor your recovery key is needed for it.
          </Text>
          <Pressable accessibilityRole="button" style={styles.primary} onPress={() => void backUpAgain()} disabled={busy}>
            <Text style={styles.primaryText}>{busy ? 'Working…' : 'Back up now'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button"
            style={styles.secondary}
            onPress={() => {
              setStage('restore');
              setError(null);
              setStatus(null);
            }}
            disabled={busy}
          >
            <Text style={styles.secondaryText}>Restore a backup</Text>
          </Pressable>

          <View style={styles.divider} />
          <Text style={text.heading}>Google Drive</Text>
          {cloud?.configured !== true ? (
            <Text style={text.muted}>
              This build has no Google client id, so backups stay on this device. They are
              still real backups — copy one off with the share sheet or a cable.
            </Text>
          ) : cloud.signedIn ? (
            <>
              <Text style={text.muted}>
                {cloud.lastUploadAt === undefined
                  ? 'Nothing has been uploaded yet.'
                  : `Last upload ${new Date(cloud.lastUploadAt).toLocaleString()}.`}
              </Text>
              {cloud.lastError !== undefined && (
                <Text style={styles.warn}>Last attempt failed: {cloud.lastError}</Text>
              )}
              <Text style={text.faint}>
                Drive holds encrypted archives in a private folder. Google cannot read them,
                and cannot help you open them if you lose both your password and your
                recovery key.
              </Text>
              <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => void uploadNow()} disabled={busy}>
                <Text style={styles.secondaryText}>Upload the newest backup</Text>
              </Pressable>
              <Pressable accessibilityRole="button" style={styles.quiet} onPress={() => void disconnectDrive()} disabled={busy}>
                <Text style={styles.quietText}>Disconnect Drive</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={text.muted}>
                Backups on this device do not survive this device. Connecting Drive uploads
                each new archive, still encrypted, to a folder only this app can see.
              </Text>
              <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => void connectDrive()} disabled={busy}>
                <Text style={styles.secondaryText}>Connect Google Drive</Text>
              </Pressable>
            </>
          )}
        </>
      )}

      {stage === 'restore' && (
        <>
          <Text style={text.heading}>Restore a backup</Text>
          <Text style={text.muted}>
            Your current entries are kept. Restoring merges the backup into this ledger and
            never removes anything newer.
          </Text>
          <TextInput
            value={restoreSecret}
            onChangeText={setRestoreSecret}
            placeholder="Backup password or recovery key"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Pressable accessibilityRole="button"
            style={styles.primary}
            onPress={() => void runRestore('file')}
            disabled={busy}
          >
            <Text style={styles.primaryText}>{busy ? 'Restoring…' : 'Choose a backup file'}</Text>
          </Pressable>
          {existing.count > 0 && (
            <Pressable accessibilityRole="button"
              style={styles.secondary}
              onPress={() => {
                Alert.alert(
                  'Restore the latest backup on this device?',
                  'Your current ledger is kept — restoring merges the backup into it.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Restore', onPress: () => void runRestore('latest') },
                  ],
                );
              }}
              disabled={busy}
            >
              <Text style={styles.secondaryText}>Use the latest backup on this device</Text>
            </Pressable>
          )}
          {cloud?.signedIn === true && (
            <>
              <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => void loadRemote()} disabled={busy}>
                <Text style={styles.secondaryText}>
                  {remote.length === 0 ? 'Look on Google Drive' : 'Refresh the Drive list'}
                </Text>
              </Pressable>
              {remote.map((archive) => (
                <Pressable accessibilityRole="button"
                  key={archive.id}
                  style={styles.remoteRow}
                  disabled={busy}
                  onPress={() => {
                    Alert.alert(
                      'Restore this backup from Drive?',
                      'Your current ledger is kept — restoring merges the backup into it.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Restore',
                          onPress: () => void runRestore({ remoteId: archive.id }),
                        },
                      ],
                    );
                  }}
                >
                  <Text style={text.body}>{new Date(archive.createdAt).toLocaleString()}</Text>
                  <Text style={text.faint}>{formatSize(archive.size)}</Text>
                </Pressable>
              ))}
            </>
          )}

          <Pressable accessibilityRole="button" style={styles.quiet} onPress={() => void refresh()} disabled={busy}>
            <Text style={styles.quietText}>Back</Text>
          </Pressable>
        </>
      )}

      {status !== null && <Text style={styles.status}>{status}</Text>}
      {error !== null && <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.error}
        >
          {error}
        </Text>}
    </ScrollView>
  );
}

/** Read a `.btbk` the user points at — a backup from an old phone, off cloud storage or a cable. */
async function pickArchive(): Promise<Uint8Array | undefined> {
  const picked = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    // Android has no MIME type for our archive; the extension is checked on read.
    type: '*/*',
  });

  const file = picked.assets?.[0];
  if (picked.canceled || !file) return undefined;

  return readBackupFile(file.uri);
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A wrong password and a corrupt file both surface as a failed unwrap, and the
 * first is overwhelmingly the likelier. Saying so beats making the user suspect
 * the file that holds everything they have.
 */
function describeRestoreFailure(cause: unknown): string {
  const message = describe(cause);
  return /unwrap|decrypt|authentic/i.test(message)
    ? 'That password or recovery key did not open this backup. Check it and try again.'
    : message;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  keyBox: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  keyText: {
    color: colors.text,
    fontSize: 18,
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  primary: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  primaryText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
  secondary: {
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryText: { color: colors.text, fontWeight: '600' },
  quiet: {
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    // Small print, full-size target: the text is quiet, the control is not.
    minHeight: MIN_TOUCH_TARGET,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  remoteRow: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: spacing.md,
    gap: spacing.xs,
  },
  quietText: { color: colors.textMuted },
  warn: { color: colors.pending },
  status: { color: colors.text },
  error: { color: colors.danger },
});
