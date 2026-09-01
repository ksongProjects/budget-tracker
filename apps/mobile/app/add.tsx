import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { CurrencySchema, now, uuidv7 } from '@budget/schema';
import type { Category, CategoryId, MinorUnits } from '@budget/schema';
import { useLedger, useQuery } from '../src/db/provider';
import { useDefaultCurrency } from '../src/profile/context';
import {
  clearAmount,
  displayAmount,
  emptyAmount,
  fromMinorUnits,
  isEmpty,
  pressBackspace,
  pressDigit,
  toMinorUnits,
} from '../src/lib/amount-entry';
import {
  AmountHeader,
  Chip,
  FormError,
  Keypad,
  PrimaryButton,
  ScrollingChipRow,
  TextField,
} from '../src/ui/form';
import { colors, spacing } from '../src/ui/theme';

/**
 * Amount first: the keypad is the screen. Everything else is optional, because
 * the thing that must not be lost is the number, and asking for a category
 * before an amount is how a capture gets abandoned halfway.
 */
export default function AddScreen(): ReactNode {
  const ledger = useLedger();
  const router = useRouter();

  // Voice hands the amount over as minor units rather than as text, so the
  // keypad starts in the same state it would have reached by being typed —
  // editable, backspaceable, and not a string to be re-parsed.
  // The currency the user chose to record in, rather than a constant: someone
  // who set up the app in euros should not have to change it on every spend.
  const DEFAULT_CURRENCY = useDefaultCurrency();

  const spoken = useLocalSearchParams<{ amountMinor?: string; currency?: string; note?: string }>();
  const spokenCurrency =
    spoken.currency === undefined
      ? DEFAULT_CURRENCY
      : (CurrencySchema.safeParse(spoken.currency).data ?? DEFAULT_CURRENCY);

  const [amount, setAmount] = useState(() =>
    spoken.amountMinor === undefined
      ? emptyAmount(DEFAULT_CURRENCY)
      : fromMinorUnits(Number(spoken.amountMinor) as MinorUnits, spokenCurrency),
  );
  const [note, setNote] = useState(spoken.note ?? '');
  const [categoryId, setCategoryId] = useState<CategoryId | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: categories } = useQuery((l) => l.categories.list(), []);

  const save = async (): Promise<void> => {
    const minor = toMinorUnits(amount);
    if (minor === null || saving) return;

    setSaving(true);
    setError(null);

    try {
      const captureId = uuidv7();
      const at = now();

      // Manual entry still records a Capture: provenance is per CONTEXT.md, and
      // a transaction with no capture would be invisible to Merge's identity
      // matching later.
      await ledger.driver.run(
        `INSERT INTO captures (capture_id, kind, captured_at, rev, updated_at, origin_device)
         VALUES (?, 'manual', ?, 1, ?, ?)`,
        [captureId, at, at, ledger.deviceId],
      );

      await ledger.transactions.create({
        captureId: captureId as never,
        accountId: null,
        merchantId: null,
        categoryId,
        amountMinor: minor,
        currency: amount.currency,
        occurredAt: at,
        postedAt: null,
        note: note.trim() === '' ? null : note.trim(),
        source: 'manual',
        // Typed by hand, so there is nothing to confirm: the user is the source.
        confirmedAt: at,
        fxOriginalMinor: null,
        fxOriginalCurrency: null,
        fxRate: null,
        reconciled: false,
      });

      router.back();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <View style={styles.screen}>
      <AmountHeader
        amount={displayAmount(amount)}
        currency={amount.currency}
        onCurrencyChange={(currency) => {
          // Only the currency changes: the digits already typed are the same
          // number in whichever currency the user meant them to be.
          setAmount((current) => ({ ...current, currency }));
        }}
      />

      <TextField label="What was it?" value={note} onChangeText={setNote} placeholder="Optional" />

      <CategoryPicker
        categories={categories ?? []}
        selected={categoryId}
        onSelect={setCategoryId}
      />

      <FormError message={error} />

      <View style={styles.keypadDock}>
        <Keypad
          onPress={(key) => {
            if (key === 'clear') setAmount(clearAmount);
            else if (key === 'back') setAmount(pressBackspace);
            else setAmount((current) => pressDigit(current, key));
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
    </View>
  );
}

function CategoryPicker({
  categories,
  selected,
  onSelect,
}: {
  categories: readonly Category[];
  selected: CategoryId | null;
  onSelect: (id: CategoryId | null) => void;
}): ReactNode {
  if (categories.length === 0) return null;

  return (
    <ScrollingChipRow>
      {categories.map((category) => (
        <Chip
          key={category.id}
          label={category.name}
          selected={category.id === selected}
          onPress={() => {
            onSelect(category.id === selected ? null : category.id);
          }}
        />
      ))}
    </ScrollingChipRow>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: spacing.md, gap: spacing.md },
  // The keypad and the one action it feeds sit together at the bottom, within
  // reach of a thumb, on every screen that has them.
  keypadDock: { marginTop: 'auto', gap: spacing.md },
});
