import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { now, sumAmounts } from '@budget/schema';
import type { CategoryId } from '@budget/schema';
import { createCapture } from '@budget/db';
import { useLedger, useQuery } from '../src/db/provider';
import { useDefaultCurrency } from '../src/profile/context';
import { readHandoff } from '../src/lib/handoff';
import type { HandoffParams } from '../src/lib/handoff';
import { fromDay, toDay } from '../src/lib/day';
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
  FormError,
  Keypad,
  PrimaryButton,
  TextField,
} from '../src/ui/form';
import { CategoryPicker, ItemList } from '../src/ui/record-items';
import { colors, spacing } from '../src/ui/theme';

/**
 * Amount first: the keypad is the screen. Everything else is optional, because
 * the thing that must not be lost is the number, and asking for a category
 * before an amount is how a capture gets abandoned halfway.
 *
 * Still a whole record: who was paid and when sit under the amount, filled in
 * already when a recording said them, so a typed spend and a spoken one land
 * in the ledger with the same four things — date, merchant, items, total.
 */
export default function AddScreen(): ReactNode {
  const ledger = useLedger();
  const router = useRouter();

  // The currency the user chose to record in, rather than a constant: someone
  // who set up the app in euros should not have to change it on every spend.
  const DEFAULT_CURRENCY = useDefaultCurrency();

  // Voice hands the amount over as minor units rather than as text, so the
  // keypad starts in the same state it would have reached by being typed —
  // editable, backspaceable, and not a string to be re-parsed.
  const handed = readHandoff(useLocalSearchParams<HandoffParams>());
  const source = handed.source ?? 'manual';

  const [amount, setAmount] = useState(() =>
    handed.amountMinor === undefined
      ? emptyAmount(handed.currency ?? DEFAULT_CURRENCY)
      : fromMinorUnits(handed.amountMinor, handed.currency ?? DEFAULT_CURRENCY),
  );
  const [merchant, setMerchant] = useState(handed.merchant ?? '');
  const [day, setDay] = useState(() => toDay(handed.date ?? now()));
  const [note, setNote] = useState(handed.note ?? '');
  const [categoryId, setCategoryId] = useState<CategoryId | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: categories } = useQuery((l) => l.categories.list(), []);

  const save = async (): Promise<void> => {
    const minor = toMinorUnits(amount);
    if (minor === null || saving) return;

    // The time of day comes from what was said, or from now: a typed spend is
    // usually being recorded the moment it happened.
    const date = fromDay(day, handed.date ?? now());
    if (date === null) {
      setError(`${day} is not a date. Use YYYY-MM-DD.`);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await ledger.driver.transaction(async () => {
        // A recording minted its capture when it was read, so this record
        // points at the same one its extraction does. A typed spend mints its
        // own: provenance is per CONTEXT.md, and a transaction with no capture
        // would be invisible to Merge's identity matching later.
        const captureId = handed.captureId ?? (await createCapture(ledger, source));

        await ledger.records.writeWithin({
          captureId,
          source,
          date,
          merchant,
          items: handed.items ?? [],
          amountMinor: minor,
          currency: amount.currency,
          categoryId,
          note,
          // Typed or checked here, so there is nothing left to confirm: the
          // user is the source.
          confirmed: true,
        });
      });

      // Back to the ledger, not one screen back: arriving from "Say it" would
      // otherwise land on the voice screen, still showing the reading that was
      // just saved, with no sign that it had been.
      router.dismissAll();
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <AmountHeader
        amount={displayAmount(amount)}
        currency={amount.currency}
        onCurrencyChange={(currency) => {
          // Only the currency changes: the digits already typed are the same
          // number in whichever currency the user meant them to be.
          setAmount((current) => ({ ...current, currency }));
        }}
      />

      <TextField
        label="Merchant"
        value={merchant}
        onChangeText={setMerchant}
        placeholder="Who was paid? Optional"
      />

      <TextField
        label="When"
        value={day}
        onChangeText={setDay}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
      />

      {handed.items !== undefined && handed.items.length > 0 ? (
        <ItemList
          items={handed.items}
          currency={amount.currency}
          total={toMinorUnits(amount) ?? sumAmounts(handed.items.map((item) => item.totalMinor))}
          title="What you said you bought"
        />
      ) : (
        <TextField label="What was it?" value={note} onChangeText={setNote} placeholder="Optional" />
      )}

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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // flexGrow, so the dock can still sit at the bottom when the fields are few.
  content: { flexGrow: 1, padding: spacing.md, gap: spacing.md },
  // The keypad and the one action it feeds sit together at the bottom, within
  // reach of a thumb, on every screen that has them.
  keypadDock: { marginTop: 'auto', gap: spacing.md },
});
