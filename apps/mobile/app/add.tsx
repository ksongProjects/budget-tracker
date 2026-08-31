import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CurrencySchema, now, uuidv7 } from '@budget/schema';
import type { Category, CategoryId, MinorUnits } from '@budget/schema';
import { useLedger, useQuery } from '../src/db/provider';
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
import { colors, radius, spacing, text } from '../src/ui/theme';

const DEFAULT_CURRENCY = CurrencySchema.parse('USD');

const KEYPAD = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['clear', '0', 'back'],
] as const;

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
      <View style={styles.amountBlock}>
        <Text style={styles.amountText}>{displayAmount(amount)}</Text>
        <Text style={text.faint}>{amount.currency}</Text>
      </View>

      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="What was it?"
        placeholderTextColor={colors.textFaint}
        style={styles.noteInput}
        returnKeyType="done"
      />

      <CategoryPicker
        categories={categories ?? []}
        selected={categoryId}
        onSelect={setCategoryId}
      />

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
                  if (key === 'clear') setAmount(clearAmount);
                  else if (key === 'back') setAmount(pressBackspace);
                  else setAmount((current) => pressDigit(current, Number(key)));
                }}
              >
                <Text style={styles.keyText}>
                  {key === 'back' ? '⌫' : key === 'clear' ? 'C' : key}
                </Text>
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
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}
    >
      {categories.map((category) => {
        const active = category.id === selected;
        return (
          <Pressable accessibilityRole="button"
            key={category.id}
            onPress={() => {
              onSelect(active ? null : category.id);
            }}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{category.name}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: spacing.md },
  amountBlock: { alignItems: 'center', paddingVertical: spacing.lg },
  amountText: {
    color: colors.text,
    fontSize: 56,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  noteInput: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  chips: { gap: spacing.sm, paddingVertical: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 14 },
  chipTextActive: { color: colors.accentText, fontWeight: '600' },
  keypad: { marginTop: 'auto', gap: spacing.sm },
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
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  saveButtonDisabled: { opacity: 0.4 },
  saveButtonText: { color: colors.accentText, fontSize: 16, fontWeight: '600' },
  error: { color: colors.danger, marginTop: spacing.sm },
});
