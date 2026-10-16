import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { AudioModule } from 'expo-audio';
import { now } from '@budget/schema';
import type { CaptureId, Currency, Timestamp } from '@budget/schema';
import { createCapture } from '@budget/db';
import { parseSpokenRecords } from '@budget/extract';
import type { SpokenRecord } from '@budget/extract';
import { formatAmount } from '../src/voice/deps';
import { runAssist } from '../src/llm/assist';
import { useLedger } from '../src/db/provider';
import { draftItems, fromModel, toNewRecord } from '../src/voice/records';
import { toParams } from '../src/lib/handoff';
import { toDay } from '../src/lib/day';
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
import { ItemList } from '../src/ui/record-items';
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
 *
 * One recording can be several records: "coffee and a muffin at Blue Bottle,
 * and gas at Shell" is two, grouped by who was paid. One record goes to the add
 * form to be checked like any other spend; several are shown here, each with
 * its items, and saved together.
 */
export default function VoiceScreen(): ReactNode {
  const router = useRouter();
  const ledger = useLedger();

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
  const [records, setRecords] = useState<readonly SpokenRecord[]>([]);
  const [left, setLeft] = useState<ReadonlySet<number>>(new Set());
  const [heard, setHeard] = useState<{ captureId: CaptureId; at: Timestamp } | undefined>(
    undefined,
  );
  const [saving, setSaving] = useState(false);
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
    setRecords([]);
    setLeft(new Set());
    setHeard(undefined);

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
        const started = Date.now();
        const spoken = await whisperEngine.transcribe(recorded.uri);
        setTranscript(spoken.text);

        const at = now();
        const ruled = parseSpokenRecords(spoken.text, { defaultCurrency, now: at });

        // One record: through the tier router as before, so a phone with an
        // on-device model reads it with that. Several: the rules' split stands,
        // because a model reads one spend per call and would merge them back.
        let read = ruled;
        let engine = 'rules';
        if (ruled.length <= 1) {
          const model = await runAssist({ text: spoken.text, kind: 'utterance', defaultCurrency });
          const one = fromModel(model, ruled[0]);
          read = one === undefined ? [] : [one];
          engine = model.engine;
        }

        setRecords(read);
        if (read.length === 0) return;

        // The capture is the recording, minted when it was heard, with the
        // reading that came out of it — so a wrong number in the ledger can be
        // traced back to the words and the engine that produced it.
        const captureId = await ledger.driver.transaction(async () => {
          const id = await createCapture(ledger, 'voice', at);
          await ledger.extractions.record({
            captureId: id,
            tier: 3,
            engine: `${spoken.engine}+${engine}`,
            candidate: { transcript: spoken.text, records: read },
            durationMs: Date.now() - started,
          });
          return id;
        });
        setHeard({ captureId, at });
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

  const kept = records.filter((_, index) => !left.has(index));

  /**
   * One record: handed to the normal add form rather than written directly.
   * A spoken amount is candidate data, and the place to accept it is the
   * screen that already exists for accepting things.
   */
  const useIt = (): void => {
    const only = records[0];
    if (only === undefined || heard === undefined) return;

    router.push({
      pathname: '/add',
      params: toParams({
        amountMinor: only.total,
        currency: only.currency.value,
        ...(only.merchant === undefined ? {} : { merchant: only.merchant.value }),
        date: only.occurredAt?.value ?? heard.at,
        items: draftItems(only),
        source: 'voice',
        captureId: heard.captureId,
      }),
    });
  };

  /** Several: each shown above with its items, saved together or not at all. */
  const saveAll = async (): Promise<void> => {
    if (heard === undefined || kept.length === 0 || saving) return;

    setSaving(true);
    setError(null);
    try {
      await ledger.records.writeAll(
        kept.map((spoken) => toNewRecord(spoken, heard.captureId, heard.at)),
      );
      router.dismissAll();
      router.replace('/');
    } catch (cause) {
      setError(describe(cause));
      setSaving(false);
    }
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
            Say what you spent — &ldquo;twelve bucks on coffee at Blue Bottle&rdquo;. Several
            things at once work too: &ldquo;coffee 4.50 and a muffin 3 at Blue Bottle, and 40
            on gas at Shell&rdquo;.
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

          {records.map((spoken, index) => (
            <SpokenCard
              key={`${String(index)}-${spoken.said}`}
              record={spoken}
              defaultCurrency={defaultCurrency}
              heardAt={heard?.at}
              {...(records.length > 1
                ? {
                    left: left.has(index),
                    onToggle: () => {
                      setLeft((was) => {
                        const next = new Set(was);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      });
                    },
                  }
                : {})}
            />
          ))}

          {transcript !== undefined && records.length === 0 && (
            <FormWarning message="No amount in that. Try naming one — “four fifty at Blue Bottle”." />
          )}

          {records.length === 1 && heard !== undefined && (
            <SecondaryButton label="Use this" onPress={useIt} />
          )}

          {records.length > 1 && heard !== undefined && (
            <PrimaryButton
              label={
                kept.length === 1 ? 'Save this record' : `Save these ${String(kept.length)} records`
              }
              busyLabel="Saving…"
              busy={saving}
              disabled={kept.length === 0}
              onPress={() => void saveAll()}
            />
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

/**
 * One record out of a recording: how much, who, when, and what.
 *
 * A currency nobody said is the user's own default, and says so — a wrong one
 * should be a visible wrong one.
 */
function SpokenCard({
  record,
  defaultCurrency,
  heardAt,
  left,
  onToggle,
}: {
  record: SpokenRecord;
  defaultCurrency: Currency;
  heardAt: Timestamp | undefined;
  left?: boolean;
  onToggle?: () => void;
}): ReactNode {
  const currency = record.currency.value;
  const assumed = record.currency.evidence === 'assumed';

  return (
    <Card>
      <View style={left === true ? styles.left : undefined}>
        <AmountHeader
          amount={formatAmount(record.total, currency)}
          currency={currency}
          note={
            assumed && currency === defaultCurrency
              ? 'Your default — you did not name a currency.'
              : `You said: ${record.currency.evidence}`
          }
        />
        <Text style={text.body}>
          {record.merchant === undefined ? 'No merchant said' : `at ${record.merchant.value}`}
        </Text>
        <Text style={text.muted}>
          {record.occurredAt === undefined
            ? `on ${heardAt === undefined ? 'today' : toDay(heardAt)}`
            : `on ${toDay(record.occurredAt.value)} — you said “${record.occurredAt.evidence}”`}
        </Text>
        <ItemList
          items={record.items.map((item) => ({
            kind: 'item' as const,
            name: item.name,
            quantity: null,
            totalMinor: item.amount.value,
          }))}
          currency={currency}
          total={record.total}
        />
      </View>
      {onToggle !== undefined && (
        <QuietButton label={left === true ? 'Put this back' : 'Leave this out'} onPress={onToggle} />
      )}
    </Card>
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  left: { opacity: 0.4 },
});
