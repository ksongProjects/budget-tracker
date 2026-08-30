import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CurrencySchema, now } from '@budget/schema';
import type { CaptureId } from '@budget/schema';
import { extractReceipt } from '@budget/extract';
import type { CandidateTransaction } from '@budget/extract';
import { useLedger } from '../../src/db/provider';
import { documentPath } from '../../src/capture/documents';
import { loadOcrEngine } from '../../src/capture/ocr';
import {
  displayAmount,
  emptyAmount,
  fromMinorUnits,
  isEmpty,
  pressBackspace,
  pressDigit,
  toMinorUnits,
} from '../../src/lib/amount-entry';
import { colors, radius, spacing, text } from '../../src/ui/theme';

const DEFAULT_CURRENCY = CurrencySchema.parse('USD');

const KEYPAD = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['C', '0', 'back'],
] as const;

type Status = 'reading' | 'ready' | 'no-engine';

/**
 * Extraction proposes; the user disposes. Nothing here writes to the ledger
 * until Save, and the row is written already confirmed because the user just
 * looked at the number and agreed to it.
 *
 * Low-confidence fields are marked rather than hidden — the user needs to know
 * which numbers to actually check.
 */
export default function ConfirmScreen(): ReactNode {
  const { captureId } = useLocalSearchParams<{ captureId: string }>();
  const ledger = useLedger();
  const router = useRouter();

  const [status, setStatus] = useState<Status>('reading');
  const [candidate, setCandidate] = useState<CandidateTransaction>({});
  const [photoUri, setPhotoUri] = useState<string | undefined>(undefined);
  const [amount, setAmount] = useState(() => emptyAmount(DEFAULT_CURRENCY));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Read through a function: TypeScript keeps property narrowing across an
    // await, so a bare flag looks constant to it after the first check.
    const controller = new AbortController();
    const cancelled = (): boolean => controller.signal.aborted;

    const read = async (): Promise<void> => {
      const path = await documentPath(ledger.driver, captureId as CaptureId);
      if (cancelled()) return;
      setPhotoUri(path);

      const engine = loadOcrEngine();

      if (!engine || path === undefined) {
        // No OCR on this build. A photo plus a typed total is still a complete
        // transaction, so the screen stays useful.
        setStatus('no-engine');
        return;
      }

      try {
        const result = await engine.recognize(path);
        if (cancelled()) return;

        const proposed = extractReceipt(result);
        setCandidate(proposed);

        if (proposed.total) {
          setAmount(fromMinorUnits(proposed.total.value, proposed.currency?.value ?? DEFAULT_CURRENCY));
        }
        if (proposed.merchant) {
          setNote(proposed.merchant.value);
        }
        setStatus('ready');
      } catch {
        if (!cancelled()) setStatus('no-engine');
      }
    };

    void read();
    return () => {
      controller.abort();
    };
  }, [captureId, ledger.driver]);

  const save = async (): Promise<void> => {
    const minor = toMinorUnits(amount);
    if (minor === null || saving) return;

    setSaving(true);
    setError(null);

    try {
      const merchantName = note.trim();
      const merchantId = merchantName === '' ? null : await ledger.merchants.resolve(merchantName);

      await ledger.transactions.create({
        captureId: captureId as CaptureId,
        accountId: null,
        merchantId,
        categoryId: null,
        amountMinor: minor,
        currency: amount.currency,
        occurredAt: candidate.occurredAt?.value ?? now(),
        postedAt: null,
        note: merchantName === '' ? null : merchantName,
        source: 'photo',
        // The user just read this number and agreed to it.
        confirmedAt: now(),
        fxOriginalMinor: null,
        fxOriginalCurrency: null,
        fxRate: null,
        reconciled: false,
      });

      router.dismissAll();
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {photoUri !== undefined && (
        <Image source={{ uri: photoUri }} style={styles.preview} resizeMode="contain" />
      )}

      {status === 'reading' && <Text style={text.muted}>Reading the receipt…</Text>}

      {status === 'no-engine' && (
        <Text style={text.faint}>
          No text recognition on this build — type the total below. The photo is saved either way.
        </Text>
      )}

      <View style={styles.amountBlock}>
        <Text style={styles.amountText}>{displayAmount(amount)}</Text>
        <Text style={text.faint}>{amount.currency}</Text>
        {candidate.total && (
          <Confidence
            label={
              candidate.total.confidence < 0.5
                ? 'Guessed from the largest amount — check this'
                : 'Read from the receipt'
            }
            confidence={candidate.total.confidence}
            evidence={candidate.total.evidence}
          />
        )}
      </View>

      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="Merchant"
        placeholderTextColor={colors.textFaint}
        style={styles.input}
      />

      {candidate.occurredAt && candidate.occurredAt.confidence < 0.7 && (
        <Text style={styles.warn}>
          The date on this receipt is ambiguous ({candidate.occurredAt.evidence}). Check it before
          saving.
        </Text>
      )}

      {candidate.cardLast4 && (
        <Text style={text.faint}>Card ending {candidate.cardLast4.value}</Text>
      )}

      {error !== null && <Text style={styles.error}>{error}</Text>}

      <View style={styles.keypad}>
        {KEYPAD.map((row) => (
          <View key={row.join()} style={styles.keypadRow}>
            {row.map((key) => (
              <Pressable
                key={key}
                style={styles.key}
                accessibilityLabel={key}
                onPress={() => {
                  if (key === 'C') setAmount((c) => ({ ...c, minor: 0 }));
                  else if (key === 'back') setAmount(pressBackspace);
                  else setAmount((c) => pressDigit(c, Number(key)));
                }}
              >
                <Text style={styles.keyText}>{key === 'back' ? '⌫' : key}</Text>
              </Pressable>
            ))}
          </View>
        ))}
      </View>

      <Pressable
        onPress={() => void save()}
        disabled={isEmpty(amount) || saving}
        style={[styles.saveButton, (isEmpty(amount) || saving) && styles.saveButtonDisabled]}
      >
        <Text style={styles.saveButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
      </Pressable>
    </ScrollView>
  );
}

function Confidence({
  label,
  confidence,
  evidence,
}: {
  label: string;
  confidence: number;
  evidence: string;
}): ReactNode {
  const low = confidence < 0.5;
  return (
    <View style={styles.confidence}>
      <Text style={low ? styles.warn : text.faint}>{label}</Text>
      <Text style={text.faint} numberOfLines={1}>
        {evidence}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  preview: {
    width: '100%',
    height: 220,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  amountBlock: { alignItems: 'center', gap: spacing.xs },
  amountText: {
    color: colors.text,
    fontSize: 48,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  confidence: { alignItems: 'center', gap: 2 },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  keypad: { gap: spacing.sm },
  keypadRow: { flexDirection: 'row', gap: spacing.sm },
  key: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
  },
  keyText: { color: colors.text, fontSize: 24, fontWeight: '500' },
  saveButton: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  saveButtonDisabled: { opacity: 0.4 },
  saveButtonText: { color: colors.accentText, fontSize: 16, fontWeight: '600' },
  warn: { color: colors.pending, fontSize: 12, textAlign: 'center' },
  error: { color: colors.danger },
});
