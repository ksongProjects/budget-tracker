import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { formatRecoveryKey, generateRecoveryKey, parseRecoveryKey } from '@budget/crypto';
import { deriveKek, KDF_PARAMS } from '@budget/crypto';
import { useLedger } from '../src/db/provider';
import { createNativeSodiumBackend } from '../src/crypto/backend';
import { hasKeyMaterial, loadOrCreateKeyMaterial } from '../src/backup/keys';
import { createBackup, listBackups, readBackupFile, restoreBackup } from '../src/backup/service';
import { colors, radius, spacing, text } from '../src/ui/theme';

type Stage = 'loading' | 'idle' | 'password' | 'recovery-shown' | 'recovery-verify' | 'done';

/**
 * Enabling backup, which is also the recovery-key ceremony.
 *
 * There is no server and no operator. Losing both the password and the recovery
 * key means the backups are unreadable by anyone, forever — so the key is shown
 * once and the user has to type part of it back before the flow completes.
 * Making that skippable would turn "recovery key" into decoration.
 */
export default function BackupScreen(): ReactNode {
  const ledger = useLedger();

  const [stage, setStage] = useState<Stage>('loading');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState<Uint8Array | null>(null);
  const [typedBack, setTypedBack] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const printed = recoveryKey ? formatRecoveryKey(recoveryKey) : '';

  // Backup being set up is a fact about the device, not about this screen's
  // lifetime. Without this, reopening the screen offers to set up again and
  // would mint a second recovery key against the same master key.
  useEffect(() => {
    let cancelled = false;
    void hasKeyMaterial().then((exists) => {
      if (!cancelled) setStage(exists ? 'done' : 'idle');
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      setError(cause instanceof Error ? cause.message : String(cause));
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
      const result = await createBackup(ledger, password, recoveryKey);
      setStatus(
        `Backed up ${(result.bytes / 1024).toFixed(1)} KB at ${new Date(result.createdAt).toLocaleTimeString()}.`,
      );
      setStage('done');
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const backUpAgain = async (): Promise<void> => {
    if (password.length === 0) {
      setError('Enter your backup password.');
      return;
    }

    setBusy(true);
    setError(null);
    setStatus('Backing up…');
    try {
      // No recovery key needed: the stored wrap carries the recovery path
      // forward from the ceremony.
      const result = await createBackup(ledger, password);
      setStatus(`Backed up ${(result.bytes / 1024).toFixed(1)} KB.`);
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const restoreLatest = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus('Restoring…');

    try {
      const backups = await listBackups();
      const latest = backups[0];
      if (!latest) {
        setError('There are no backups on this device yet.');
        setStatus(null);
        return;
      }

      const sodium = await createNativeSodiumBackend();
      const { salt } = await loadOrCreateKeyMaterial(sodium);

      const parsed = parseRecoveryKey(typedBack);
      const secret =
        parsed ?? deriveKek(sodium, password, salt, KDF_PARAMS);

      const bytes = await readBackupFile(latest.path);
      const result = await restoreBackup(ledger, bytes, secret, sodium);

      const inserted = Object.values(result.merged).reduce((sum, s) => sum + s.inserted, 0);
      const kept = Object.values(result.merged).reduce((sum, s) => sum + s.kept, 0);

      setStatus(
        `Restored a backup from ${new Date(result.createdAt).toLocaleString()}: ` +
          `${String(inserted)} rows added, ${String(kept)} already current, ` +
          `${String(result.documents)} photos.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus(null);
    } finally {
      setBusy(false);
    }
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
          <Pressable style={styles.primary} onPress={begin}>
            <Text style={styles.primaryText}>Set up backup</Text>
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
          <Pressable style={styles.primary} onPress={() => void mintRecoveryKey()} disabled={busy}>
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
          <Pressable
            style={styles.secondary}
            onPress={() => void Clipboard.setStringAsync(printed)}
          >
            <Text style={styles.secondaryText}>Copy to clipboard</Text>
          </Pressable>
          <Pressable
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
            The last five characters of your recovery key, to confirm you really have it.
          </Text>
          <TextInput
            value={typedBack}
            onChangeText={setTypedBack}
            placeholder="Last group"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="characters"
            style={styles.input}
          />
          <Pressable style={styles.primary} onPress={() => void verifyAndBackUp()} disabled={busy}>
            <Text style={styles.primaryText}>{busy ? 'Backing up…' : 'Confirm and back up'}</Text>
          </Pressable>
          <Pressable
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
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Backup password"
            placeholderTextColor={colors.textFaint}
            secureTextEntry
            style={styles.input}
          />
          <Pressable style={styles.primary} onPress={() => void backUpAgain()} disabled={busy}>
            <Text style={styles.primaryText}>{busy ? 'Working…' : 'Back up now'}</Text>
          </Pressable>
          <Pressable
            style={styles.secondary}
            onPress={() => {
              Alert.alert(
                'Restore the latest backup?',
                'Your current ledger is kept — restoring merges the backup into it and never removes newer entries.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Restore', onPress: () => void restoreLatest() },
                ],
              );
            }}
            disabled={busy}
          >
            <Text style={styles.secondaryText}>Restore latest backup</Text>
          </Pressable>
        </>
      )}

      {status !== null && <Text style={styles.status}>{status}</Text>}
      {error !== null && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
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
  warn: { color: colors.pending },
  status: { color: colors.text },
  error: { color: colors.danger },
});
