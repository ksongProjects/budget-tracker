import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CurrencySchema } from '@budget/schema';
import type { Currency } from '@budget/schema';
import { MIN_TOUCH_TARGET, colors, radius, spacing, text } from './theme';

/**
 * Picking a currency, without a list of 180 of them.
 *
 * A row of the ones most people mean, and a box for everyone else — a scrolling
 * picker of every ISO code makes the common case slower to serve the rare one.
 * Anything three letters long is accepted, because this app has no business
 * telling someone their currency does not exist.
 */

/** Common enough to be worth a tap. Not a claim about which currencies matter. */
export const SUGGESTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'] as const;

export interface CurrencyPickerProps {
  readonly value: Currency;
  readonly onChange: (currency: Currency) => void;
  /** Shown above the row. */
  readonly label?: string;
}

export function CurrencyPicker({ value, onChange, label }: CurrencyPickerProps): ReactNode {
  const [other, setOther] = useState('');
  const listed = SUGGESTED_CURRENCIES.some((code) => code === value);

  return (
    <View style={styles.block}>
      {label !== undefined && <Text style={text.muted}>{label}</Text>}

      <View style={styles.row}>
        {SUGGESTED_CURRENCIES.map((code) => {
          const selected = code === value;
          return (
            <Pressable
              key={code}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[styles.chip, selected && styles.chipSelected]}
              onPress={() => {
                setOther('');
                onChange(CurrencySchema.parse(code));
              }}
            >
              <Text style={selected ? styles.chipTextSelected : styles.chipText}>{code}</Text>
            </Pressable>
          );
        })}
      </View>

      <TextInput
        value={other === '' && !listed ? value : other}
        onChangeText={(next) => {
          const code = next.toUpperCase().slice(0, 3);
          setOther(code);
          // Applied only once it is a whole code, so the value never spends a
          // keystroke as "US".
          const parsed = CurrencySchema.safeParse(code);
          if (parsed.success) onChange(parsed.data);
        }}
        placeholder="Another code, e.g. CHF"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={3}
        accessibilityLabel="Another currency code"
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontWeight: '600' },
  chipTextSelected: { color: colors.accentText, fontWeight: '700' },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
  },
});
