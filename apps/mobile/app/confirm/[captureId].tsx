import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CurrencySchema, formatAmount, now } from '@budget/schema';
import type { CaptureId } from '@budget/schema';
import { extractReceipt } from '@budget/extract';
import type { CandidateTransaction, StructuredCandidate } from '@budget/extract';
import { assistOffer, runAssist, textToSend } from '../../src/llm/assist';
import type { AssistOffer } from '../../src/llm/assist';
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

  // The OCR text, kept because Tier 3 reads text rather than pixels — and
  // because the user has to be shown exactly what would be sent.
  const [receiptText, setReceiptText] = useState('');
  const [offer, setOffer] = useState<AssistOffer | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const [detail, setDetail] = useState<StructuredCandidate | undefined>(undefined);

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
        setReceiptText(result.lines.map((line) => line.text).join('\n'));

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

  useEffect(() => {
    void assistOffer().then(setOffer);
  }, []);

  /**
   * Read the breakdown — either on the phone, or, with a tap, off it.
   *
   * An on-device model runs straight away because nothing leaves. A remote one
   * gets a screen first, showing the exact text, and the permission it produces
   * is checked against that text inside the adapter.
   */
  const assist = async (approvedText?: string): Promise<void> => {
    setAssisting(true);
    setAsking(false);
    setError(null);

    try {
      const structured = await runAssist({
        text: receiptText,
        kind: 'receipt',
        defaultCurrency: amount.currency,
        ...(approvedText === undefined ? {} : { approvedText }),
      });

      setDetail(structured);

      // The model's total wins only if it read one; the keypad already holds
      // what the rules found, and silently replacing a number the user has
      // looked at would be the wrong kind of helpful.
      if (structured.total !== undefined && structured.total.value !== toMinorUnits(amount)) {
        setAmount(fromMinorUnits(structured.total.value, structured.currency?.value ?? amount.currency));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAssisting(false);
    }
  };

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

      {status === 'ready' && offer?.available === true && detail === undefined && !asking && (
        <Pressable accessibilityRole="button"
          style={styles.secondaryButton}
          disabled={assisting}
          onPress={() => {
            // A remote reading is a decision, so it gets a screen. A local one
            // is not, so it does not.
            if (offer.remote) setAsking(true);
            else void assist();
          }}
        >
          <Text style={styles.secondaryText}>{assisting ? 'Reading…' : offer.label}</Text>
        </Pressable>
      )}

      {asking && (
        <View style={styles.consent}>
          <Text style={text.heading}>Send this text?</Text>
          <Text style={text.body}>
            This is everything that would leave your phone, using your own API key. The photo stays
            here, and so does your ledger.
          </Text>
          <ScrollView style={styles.consentText} nestedScrollEnabled>
            <Text style={styles.monospace}>{textToSend(receiptText)}</Text>
          </ScrollView>
          <Text style={text.faint}>
            Card and account numbers are masked above. This permission covers this one capture.
          </Text>
          <View style={styles.consentButtons}>
            <Pressable accessibilityRole="button"
              style={styles.secondaryButton}
              onPress={() => {
                setAsking(false);
              }}
            >
              <Text style={styles.secondaryText}>Not this time</Text>
            </Pressable>
            <Pressable accessibilityRole="button"
              style={styles.sendButton}
              onPress={() => void assist(textToSend(receiptText))}
            >
              <Text style={styles.saveButtonText}>Send this text</Text>
            </Pressable>
          </View>
        </View>
      )}

      {detail?.lineItems !== undefined && (
        <View style={styles.breakdown}>
          <Text style={text.heading}>What was bought</Text>
          {detail.lineItems.map((item) => (
            <View key={`${item.value.description}-${String(item.value.amount)}`} style={styles.itemRow}>
              <Text style={item.confidence < 0.5 ? styles.warn : text.body} numberOfLines={1}>
                {item.value.description}
              </Text>
              <Text style={text.body}>
                {formatAmount(item.value.amount, detail.currency?.value ?? amount.currency)}
              </Text>
            </View>
          ))}

          {detail.reconciliation !== undefined && !detail.reconciliation.balanced && (
            <Text style={styles.warn}>
              These items come to{' '}
              {formatAmount(detail.reconciliation.itemisedTotal, detail.currency?.value ?? amount.currency)}
              , not the total above. A discount or a missed line — worth a look before saving.
            </Text>
          )}

          <Text style={text.faint}>Read by {detail.engine}.</Text>
        </View>
      )}

      {status === 'ready' && offer?.available === false && (
        <Pressable accessibilityRole="button"
          onPress={() => {
            router.push('/assist');
          }}
        >
          <Text style={text.faint}>
            No model on this phone, so there is no item-by-item breakdown. What that means →
          </Text>
        </Pressable>
      )}

      {error !== null && <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.error}
        >
          {error}
        </Text>}

      <View style={styles.keypad}>
        {KEYPAD.map((row) => (
          <View key={row.join()} style={styles.keypadRow}>
            {row.map((key) => (
              <Pressable accessibilityRole="button"
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

      <Pressable accessibilityRole="button"
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
  secondaryButton: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryText: { color: colors.text, fontWeight: '600' },
  sendButton: {
    flex: 1,
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  consent: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  // Tall enough to read, short enough that the buttons stay on screen: the
  // decision and what it covers belong in one view.
  consentText: { maxHeight: 200, backgroundColor: colors.surfaceRaised, borderRadius: radius.sm },
  monospace: { color: colors.text, fontFamily: 'monospace', fontSize: 12, padding: spacing.sm },
  consentButtons: { flexDirection: 'row', gap: spacing.sm },
  breakdown: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  warn: { color: colors.pending, fontSize: 12, textAlign: 'center' },
  error: { color: colors.danger },
});
