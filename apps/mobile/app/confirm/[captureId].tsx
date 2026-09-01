import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { now, sumAmounts } from '@budget/schema';
import type { CaptureId } from '@budget/schema';
import { buildReceiptTable, extractReceipt, fillTable, renderTable } from '@budget/extract';
import type { CandidateTransaction, ReceiptTable } from '@budget/extract';
import { assistOffer, runAssist, textToSend } from '../../src/llm/assist';
import type { AssistOffer } from '../../src/llm/assist';
import { useLedger } from '../../src/db/provider';
import { useDefaultCurrency } from '../../src/profile/context';
import { documentPath } from '../../src/capture/documents';
import { loadOcrEngine } from '../../src/capture/ocr';
import { toDrafts, toEditable } from '../../src/capture/table-edit';
import type { EditableRow } from '../../src/capture/table-edit';
import { fromDay, toDay } from '../../src/lib/day';
import {
  clearAmount,
  displayAmount,
  emptyAmount,
  fromMinorUnits,
  isEmpty,
  pressBackspace,
  pressDigit,
  toMinorUnits,
} from '../../src/lib/amount-entry';
import {
  AmountHeader,
  Card,
  FormError,
  Keypad,
  PrimaryButton,
  QuietButton,
  SecondaryButton,
  TextField,
} from '../../src/ui/form';
import { ReceiptTableEditor } from '../../src/ui/receipt-table';
import { colors, radius, spacing, text } from '../../src/ui/theme';

type Status = 'reading' | 'ready' | 'no-engine';

const EMPTY_TABLE: ReceiptTable = { header: [], rows: [], engine: '' };

/**
 * Extraction proposes; the user disposes. Nothing here writes to the ledger
 * until Save, and the row is written already confirmed because the user just
 * looked at the numbers and agreed to them.
 *
 * The receipt is shown as the table it was printed as — every row the rules
 * found, editable where it is wrong, with the unpriced ones marked. That is a
 * different promise from the old screen, which showed a total and hid the rest:
 * a misread line is now visible before it reaches the ledger rather than after.
 */
export default function ConfirmScreen(): ReactNode {
  const { captureId } = useLocalSearchParams<{ captureId: string }>();
  const ledger = useLedger();
  const router = useRouter();

  // The user's own currency, not a constant: a receipt that names none is far
  // more likely to be in the currency they record in than in dollars.
  const DEFAULT_CURRENCY = useDefaultCurrency();

  const [status, setStatus] = useState<Status>('reading');
  const [candidate, setCandidate] = useState<CandidateTransaction>({});
  const [table, setTable] = useState<ReceiptTable>(EMPTY_TABLE);
  const [rows, setRows] = useState<readonly EditableRow[]>([]);
  const [photoUri, setPhotoUri] = useState<string | undefined>(undefined);
  const [amount, setAmount] = useState(() => emptyAmount(DEFAULT_CURRENCY));
  const [merchant, setMerchant] = useState('');
  const [day, setDay] = useState(() => toDay(now()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [offer, setOffer] = useState<AssistOffer | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const [readBy, setReadBy] = useState<string | undefined>(undefined);

  /**
   * What a model would be given: the table, not the raw OCR dump.
   *
   * A rendered table names the rows that have no number, which turns "read this
   * receipt" into "three of these rows are missing a value". It is also exactly
   * what the consent screen shows, because it is the same string.
   */
  const tableText = useMemo(() => renderTable(table, amount.currency), [table, amount.currency]);

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

        const proposed = extractReceipt(result, { defaultCurrency: DEFAULT_CURRENCY });
        const built = buildReceiptTable(result);
        const currency = proposed.currency?.value ?? DEFAULT_CURRENCY;

        setCandidate(proposed);
        setTable(built);
        setRows(toEditable(built, currency));

        if (proposed.total) {
          setAmount(fromMinorUnits(proposed.total.value, currency));
        }
        if (proposed.merchant) {
          setMerchant(proposed.merchant.value);
        }
        if (proposed.occurredAt) {
          setDay(toDay(proposed.occurredAt.value));
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
  }, [captureId, ledger.driver, DEFAULT_CURRENCY]);

  useEffect(() => {
    void assistOffer().then(setOffer);
  }, []);

  /**
   * Fill the gaps — either on the phone, or, with a tap, off it.
   *
   * An on-device model runs straight away because nothing leaves. A remote one
   * gets a screen first, showing the exact text, and the permission it produces
   * is checked against that text inside the adapter.
   *
   * What comes back fills empty rows and adds ones OCR lost. It never overwrites
   * a number the receipt printed — that rule lives in `fillTable`, where it can
   * be tested, rather than in a screen.
   */
  const assist = async (approvedText?: string): Promise<void> => {
    setAssisting(true);
    setAsking(false);
    setError(null);

    try {
      const structured = await runAssist({
        text: tableText,
        kind: 'receipt',
        defaultCurrency: amount.currency,
        ...(approvedText === undefined ? {} : { approvedText }),
      });

      const filled = fillTable(table, structured);
      setTable(filled);
      setRows(mergeEdits(toEditable(filled, amount.currency), rows));
      setReadBy(structured.engine);

      // The model's total wins only if it read one; the keypad already holds
      // what the rules found, and silently replacing a number the user has
      // looked at would be the wrong kind of helpful.
      if (structured.total !== undefined && structured.total.value !== toMinorUnits(amount)) {
        setAmount(
          fromMinorUnits(structured.total.value, structured.currency?.value ?? amount.currency),
        );
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

    const occurredAt = fromDay(day, candidate.occurredAt?.value ?? now());
    if (occurredAt === null) {
      setError(`${day} is not a date. Use YYYY-MM-DD.`);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const merchantName = merchant.trim();
      const merchantId = merchantName === '' ? null : await ledger.merchants.resolve(merchantName);

      const drafts = toDrafts(rows, amount.currency);
      const itemised = sumAmounts(drafts.map((draft) => draft.totalMinor));

      const transaction = await ledger.transactions.create({
        captureId: captureId as CaptureId,
        accountId: null,
        merchantId,
        categoryId: null,
        amountMinor: minor,
        currency: amount.currency,
        occurredAt,
        postedAt: null,
        note: merchantName === '' ? null : merchantName,
        source: 'photo',
        // The user just read these numbers and agreed to them.
        confirmedAt: now(),
        fxOriginalMinor: null,
        fxOriginalCurrency: null,
        fxRate: null,
        // Claimed only when the breakdown actually adds up to what was charged.
        reconciled: drafts.length > 0 && itemised === minor,
      });

      if (drafts.length > 0) {
        await ledger.lineItems.replaceFor(transaction.id, drafts);
      }

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

      <AmountHeader
        amount={displayAmount(amount)}
        currency={amount.currency}
        onCurrencyChange={(currency) => {
          setAmount((current) => ({ ...current, currency }));
        }}
        note={
          candidate.currency === undefined || candidate.currency.confidence < 0.5
            ? 'Your default — this receipt does not say which currency.'
            : `Printed on the receipt: ${candidate.currency.evidence}`
        }
        {...(candidate.total === undefined
          ? {}
          : {
              caption:
                candidate.total.confidence < 0.5
                  ? `Guessed from the largest amount — check this: ${candidate.total.evidence}`
                  : `Read from the receipt: ${candidate.total.evidence}`,
              captionWarns: candidate.total.confidence < 0.5,
            })}
      />

      <TextField
        label="Merchant"
        value={merchant}
        onChangeText={setMerchant}
        placeholder="Who was paid?"
      />

      <TextField
        label="When"
        value={day}
        onChangeText={setDay}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        {...(candidate.occurredAt && candidate.occurredAt.confidence < 0.7
          ? {
              warning: `The date on this receipt is ambiguous (${candidate.occurredAt.evidence}) — day and month could be either way round. Check it before saving.`,
            }
          : {})}
      />

      <ReceiptTableEditor rows={rows} currency={amount.currency} onChange={setRows} />

      {readBy !== undefined && <Text style={text.faint}>Gaps filled by {readBy}.</Text>}

      {candidate.cardLast4 && (
        <Text style={text.faint}>Card ending {candidate.cardLast4.value}</Text>
      )}

      {status === 'ready' && offer?.available === true && readBy === undefined && !asking && (
        <SecondaryButton
          label={offer.label}
          busyLabel="Reading…"
          busy={assisting}
          onPress={() => {
            // A remote reading is a decision, so it gets a screen. A local one
            // is not, so it does not.
            if (offer.remote) setAsking(true);
            else void assist();
          }}
        />
      )}

      {asking && (
        <Card>
          <Text style={text.heading}>Send this text?</Text>
          <Text style={text.body}>
            This is everything that would leave your phone, using your own API key. The photo stays
            here, and so does your ledger.
          </Text>
          <ScrollView style={styles.consentText} nestedScrollEnabled>
            <Text style={styles.monospace}>{textToSend(tableText)}</Text>
          </ScrollView>
          <Text style={text.faint}>
            Card and account numbers are masked above. This permission covers this one capture.
          </Text>
          <View style={styles.consentButtons}>
            <View style={styles.consentButton}>
              <SecondaryButton
                label="Not this time"
                onPress={() => {
                  setAsking(false);
                }}
              />
            </View>
            <View style={styles.consentButton}>
              <PrimaryButton
                label="Send this text"
                onPress={() => void assist(textToSend(tableText))}
              />
            </View>
          </View>
        </Card>
      )}

      {status === 'ready' && offer?.available === false && (
        <QuietButton
          label="No model on this phone, so nothing can fill a row the camera could not read. What that means →"
          onPress={() => {
            router.push('/assist');
          }}
        />
      )}

      <FormError message={error} />

      <View style={styles.keypadDock}>
        <Keypad
          onPress={(key) => {
            if (key === 'clear') setAmount(clearAmount);
            else if (key === 'back') setAmount(pressBackspace);
            else setAmount((c) => pressDigit(c, key));
          }}
        />

        <PrimaryButton
          label="Save"
          busyLabel="Saving…"
          busy={saving}
          disabled={isEmpty(amount)}
          onPress={() => void save()}
        />
      </View>
    </ScrollView>
  );
}

/**
 * Keep what the user has typed when a model's reading arrives.
 *
 * The request takes seconds and the keyboard is not disabled while it runs, so
 * an edit made in the meantime must survive the answer. A row the user has
 * touched — `source: 'user'` — wins outright.
 */
function mergeEdits(
  proposed: readonly EditableRow[],
  edited: readonly EditableRow[],
): EditableRow[] {
  const mine = new Map(edited.filter((row) => row.source === 'user').map((row) => [row.key, row]));
  return proposed.map((row) => mine.get(row.key) ?? row);
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
  // Tall enough to read, short enough that the buttons stay on screen: the
  // decision and what it covers belong in one view.
  consentText: { maxHeight: 200, backgroundColor: colors.surfaceRaised, borderRadius: radius.sm },
  monospace: { color: colors.text, fontFamily: 'monospace', fontSize: 12, padding: spacing.sm },
  consentButtons: { flexDirection: 'row', gap: spacing.sm },
  consentButton: { flex: 1 },
  keypadDock: { gap: spacing.md },
});
