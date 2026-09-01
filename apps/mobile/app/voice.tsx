import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
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
import { useDefaultCurrency } from '../src/profile/context';
import {
  AmountHeader,
  Card,
  FormError,
  FormWarning,
  PrimaryButton,
  QuietButton,
  SecondaryButton,
} from '../src/ui/form';
import { colors, spacing, text } from '../src/ui/theme';

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

  // The currency this ledger records in. A spoken "twelve fifty" names no
  // currency, and reading it as dollars on a phone set up in euros was a real
  // bug: the number was right, the currency was invented, and nothing on screen
  // said so.
  const defaultCurrency = useDefaultCurrency();

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
        setCandidate(
          await runAssist({ text: spoken.text, kind: 'utterance', defaultCurrency }),
        );
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

  const heard = candidate?.currency;
  // Only the transcript can name a currency. Where it did not, this is the
  // user's own — shown as theirs, so a wrong one is a visible wrong one.
  const currency = heard?.value ?? defaultCurrency;

  const useIt = (): void => {
    if (candidate?.total === undefined) return;

    // Handed to the normal add form rather than written directly: a spoken
    // amount is candidate data, and the place to accept it is the screen that
    // already exists for accepting things.
    router.push({
      pathname: '/add',
      params: {
        amountMinor: String(candidate.total.value),
        currency,
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
          <PrimaryButton
            label="Download the speech model"
            busyLabel={
              progress === undefined
                ? 'Downloading…'
                : `Downloading ${String(Math.floor(progress * 100))}%…`
            }
            busy={busy}
            onPress={() => void fetchModel()}
          />
        </>
      )}

      {ready === true && (
        <>
          <Text style={text.muted}>
            Say what you spent — &ldquo;twelve bucks on coffee at Blue Bottle&rdquo;.
          </Text>

          {recording ? (
            <PrimaryButton label="Stop and read it" busy={busy} onPress={() => void stopAndRead()} />
          ) : (
            <PrimaryButton
              label="Record"
              busyLabel="Working…"
              busy={busy}
              onPress={() => void record()}
            />
          )}

          {transcript !== undefined && (
            <Card>
              <Text style={text.faint}>Heard</Text>
              <Text style={text.body}>{transcript}</Text>
            </Card>
          )}

          {candidate?.total !== undefined && (
            <Card>
              <AmountHeader
                amount={formatAmount(candidate.total.value, currency)}
                currency={currency}
                note={
                  heard === undefined
                    ? `Your default — you did not name a currency. Change it on the next screen.`
                    : `You said: ${heard.evidence}`
                }
                caption={`read from “${candidate.total.evidence}”`}
              />
              {candidate.merchant !== undefined && (
                <Text style={text.body}>at {candidate.merchant.value}</Text>
              )}
            </Card>
          )}

          {transcript !== undefined && candidate?.total === undefined && (
            <FormWarning message="No amount in that. Try naming one — “four fifty at Blue Bottle”." />
          )}

          {candidate?.total !== undefined && (
            <SecondaryButton label="Use this" onPress={useIt} />
          )}

          <View style={styles.divider} />
          <Text style={text.faint}>
            Speech model on this device: {(modelBytes / 1024 / 1024).toFixed(0)} MB.
          </Text>
          <QuietButton
            label="Delete the model"
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
          />
        </>
      )}

      <FormError message={error} />
    </ScrollView>
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
});
