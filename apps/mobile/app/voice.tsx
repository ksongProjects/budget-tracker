import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { AudioModule } from 'expo-audio';
import { formatAmount } from '../src/voice/deps';
import { runAssist } from '../src/llm/assist';
import type { CandidateTransaction } from '@budget/extract';
import {
  DEFAULT_MODEL,
  deleteModel,
  downloadModel,
  isModelPresent,
  modelSizeBytes,
} from '../src/voice/model';
import { whisperEngine } from '../src/voice/whisper';
import { discardRecording, startRecording, stopRecording } from '../src/voice/recorder';
import { colors, radius, spacing, text } from '../src/ui/theme';

/**
 * Speaking a spend.
 *
 * Recording, transcription and reading all happen on the device. The one thing
 * that needs a network is fetching the model, once, and the screen says so
 * before asking — after that, voice works in airplane mode, which is most of
 * why it was worth doing this way.
 *
 * The transcript is always shown. When the reading is wrong, seeing the words
 * it read is the difference between correcting a number and distrusting the
 * feature.
 */
export default function VoiceScreen(): ReactNode {
  const router = useRouter();

  const [recording, setRecording] = useState(false);
  const [ready, setReady] = useState<boolean | undefined>(undefined);
  const [modelBytes, setModelBytes] = useState(0);
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState<string | undefined>(undefined);
  const [candidate, setCandidate] = useState<CandidateTransaction | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  const refresh = async (): Promise<void> => {
    setReady(await isModelPresent());
    setModelBytes(await modelSizeBytes());
  };

  const fetchModel = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setProgress(0);

    try {
      await downloadModel(DEFAULT_MODEL, ({ received, total }) => {
        setProgress(total === 0 ? 0 : received / total);
      });
      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setProgress(undefined);
      setBusy(false);
    }
  };

  const record = async (): Promise<void> => {
    setError(null);
    setTranscript(undefined);
    setCandidate(undefined);

    try {
      const granted = await AudioModule.requestRecordingPermissionsAsync();
      if (!granted.granted) {
        setError('Recording needs permission to use the microphone.');
        return;
      }

      startRecording();
      setRecording(true);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const stopAndRead = async (): Promise<void> => {
    setBusy(true);
    setRecording(false);
    setError(null);

    try {
      const recorded = await stopRecording();

      try {
        const spoken = await whisperEngine.transcribe(recorded.uri);
        setTranscript(spoken.text);

        // Through the tier router rather than straight to the rules: on a
        // phone with an on-device model the same transcript gets read by it,
        // and on every other phone this is the rules, exactly as before.
        setCandidate(await runAssist({ text: spoken.text, kind: 'utterance' }));
      } finally {
        // The words are kept for the user to check; the audio is not. Nothing
        // else in the app holds a recording of someone's voice, and a
        // transcript that is already on screen makes the file dead weight.
        await discardRecording(recorded);
      }
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const useIt = (): void => {
    if (candidate?.total === undefined) return;

    // Handed to the normal add form rather than written directly: a spoken
    // amount is candidate data, and the place to accept it is the screen that
    // already exists for accepting things.
    router.push({
      pathname: '/add',
      params: {
        amountMinor: String(candidate.total.value),
        currency: candidate.currency?.value ?? 'USD',
        note: candidate.merchant?.value ?? transcript ?? '',
      },
    });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {ready === false && (
        <>
          <Text style={text.body}>
            Speaking a spend needs a speech model on this device — about{' '}
            {String(DEFAULT_MODEL.megabytes)} MB, downloaded once.
          </Text>
          <Text style={text.muted}>
            The model comes to your phone. Nothing you say is ever sent anywhere: once it is
            here, this works with no network at all.
          </Text>
          <Pressable style={styles.primary} onPress={() => void fetchModel()} disabled={busy}>
            <Text style={styles.primaryText}>
              {progress === undefined
                ? 'Download the speech model'
                : `Downloading ${String(Math.floor(progress * 100))}%…`}
            </Text>
          </Pressable>
        </>
      )}

      {ready === true && (
        <>
          <Text style={text.muted}>
            Say what you spent — &ldquo;twelve bucks on coffee at Blue Bottle&rdquo;.
          </Text>

          {recording ? (
            <Pressable style={styles.primary} onPress={() => void stopAndRead()} disabled={busy}>
              <Text style={styles.primaryText}>Stop and read it</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.primary} onPress={() => void record()} disabled={busy}>
              <Text style={styles.primaryText}>{busy ? 'Working…' : 'Record'}</Text>
            </Pressable>
          )}

          {transcript !== undefined && (
            <View style={styles.card}>
              <Text style={text.faint}>Heard</Text>
              <Text style={text.body}>{transcript}</Text>
            </View>
          )}

          {candidate?.total !== undefined && (
            <View style={styles.card}>
              <Text style={text.heading}>
                {formatAmount(candidate.total.value, candidate.currency?.value ?? ('USD' as never))}{' '}
                {candidate.currency?.value ?? 'USD'}
              </Text>
              {candidate.merchant !== undefined && (
                <Text style={text.body}>at {candidate.merchant.value}</Text>
              )}
              <Text style={text.faint}>read from &ldquo;{candidate.total.evidence}&rdquo;</Text>
            </View>
          )}

          {transcript !== undefined && candidate?.total === undefined && (
            <Text style={styles.warn}>
              No amount in that. Try naming one — &ldquo;four fifty at Blue Bottle&rdquo;.
            </Text>
          )}

          {candidate?.total !== undefined && (
            <Pressable style={styles.secondary} onPress={useIt}>
              <Text style={styles.secondaryText}>Use this</Text>
            </Pressable>
          )}

          <View style={styles.divider} />
          <Text style={text.faint}>
            Speech model on this device: {(modelBytes / 1024 / 1024).toFixed(0)} MB.
          </Text>
          <Pressable
            style={styles.quiet}
            onPress={() => {
              Alert.alert(
                'Delete the speech model?',
                'Voice stops working until it is downloaded again. Nothing else changes.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                      void deleteModel().then(refresh);
                    },
                  },
                ],
              );
            }}
          >
            <Text style={styles.quietText}>Delete the model</Text>
          </Pressable>
        </>
      )}

      {error !== null && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
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
  quiet: { paddingVertical: spacing.sm, alignItems: 'center' },
  quietText: { color: colors.textMuted },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  warn: { color: colors.pending },
  error: { color: colors.danger },
});
