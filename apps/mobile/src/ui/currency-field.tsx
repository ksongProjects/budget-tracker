import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Currency } from '@budget/schema';
import { CurrencyPicker } from './currency';
import { colors, radius, spacing, text } from './theme';

/**
 * The currency under an amount, and a way to change it.
 *
 * A spend is recorded in the user's own currency unless the receipt says
 * otherwise in words — a `$` says nothing about which country, so it is not
 * read as anything. That makes this control the place a trip abroad gets
 * handled: tap the code, pick another, and only this spend changes.
 *
 * Collapsed by default. The common case is that the currency is already right,
 * and a picker permanently open next to the amount would suggest otherwise
 * every time someone buys a coffee at home.
 */
export interface CurrencyFieldProps {
  readonly value: Currency;
  readonly onChange: (currency: Currency) => void;
  /** Shown when the currency came from somewhere other than the user's default. */
  readonly note?: string | undefined;
}

export function CurrencyField({ value, onChange, note }: CurrencyFieldProps): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.block}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Currency: ${value}. Tap to change.`}
        style={styles.chip}
        onPress={() => {
          setOpen((was) => !was);
        }}
      >
        <Text style={styles.code}>{value}</Text>
        <Text style={text.faint}>{open ? 'done' : 'change'}</Text>
      </Pressable>

      {note !== undefined && !open && <Text style={text.faint}>{note}</Text>}

      {open && (
        <View style={styles.picker}>
          <CurrencyPicker value={value} onChange={onChange} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { alignItems: 'center', gap: spacing.xs, alignSelf: 'stretch' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
  },
  code: { color: colors.textMuted, fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },
  picker: { alignSelf: 'stretch', paddingHorizontal: spacing.md, paddingTop: spacing.sm },
});
