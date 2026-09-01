import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { KeyboardTypeOptions } from 'react-native';
import type { Currency } from '@budget/schema';
import { CurrencyField } from './currency-field';
import { MIN_TOUCH_TARGET, colors, radius, spacing, text } from './theme';

/**
 * The parts every screen that takes an input is built from.
 *
 * Four screens record a spend — typed, spoken, photographed, imported — and
 * each had grown its own buttons, its own card, its own idea of how big an
 * amount is and which of them deserved a 44pt touch target. The differences
 * were invisible one screen at a time and obvious moving between them, which is
 * exactly how a user meets them.
 *
 * So: one primary action, one secondary, one card, one field, one keypad, one
 * way to say something went wrong. A screen that needs something different is
 * making a claim, and it has to make it here where every screen can see it.
 */

export function Card({ children }: { children: ReactNode }): ReactNode {
  return <View style={styles.card}>{children}</View>;
}

/**
 * A labelled input. The label is not optional.
 *
 * A bare box with placeholder text loses its label the moment anything is typed
 * into it, and the screens that did that were the ones where a user had to
 * remember what they had answered.
 */
export function Field({
  label,
  hint,
  warning,
  children,
}: {
  label: string;
  hint?: string | undefined;
  warning?: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <View style={styles.field}>
      <Text style={text.faint}>{label}</Text>
      {children}
      {hint !== undefined && <Text style={text.faint}>{hint}</Text>}
      {warning !== undefined && <FormWarning message={warning} />}
    </View>
  );
}

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (next: string) => void;
  readonly placeholder?: string;
  readonly hint?: string | undefined;
  readonly warning?: string | undefined;
  readonly keyboardType?: KeyboardTypeOptions;
  readonly autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  readonly onBlur?: () => void;
  /** A password, a passphrase, an API key: masked, never autocorrected. */
  readonly secure?: boolean;
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  warning,
  keyboardType,
  autoCapitalize,
  onBlur,
  secure = false,
}: TextFieldProps): ReactNode {
  return (
    <Field label={label} hint={hint} warning={warning}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? ''}
        placeholderTextColor={colors.textFaint}
        style={styles.input}
        returnKeyType="done"
        secureTextEntry={secure}
        autoCorrect={!secure}
        accessibilityLabel={label}
        {...(keyboardType === undefined ? {} : { keyboardType })}
        {...(autoCapitalize === undefined ? {} : { autoCapitalize })}
        {...(onBlur === undefined ? {} : { onBlur })}
      />
    </Field>
  );
}

/**
 * The amount, at the top of every screen that records one, at one size.
 *
 * The currency lives under it rather than beside it because it is changed
 * rarely and read constantly — and it is the same control everywhere, so
 * "tap the code to change it" is learned once.
 */
export function AmountHeader({
  amount,
  currency,
  onCurrencyChange,
  note,
  caption,
  captionWarns = false,
}: {
  /** Already formatted — the keypad and the ledger format differently. */
  amount: string;
  currency: Currency;
  onCurrencyChange?: ((next: Currency) => void) | undefined;
  /** Where this currency came from, shown under the code. */
  note?: string | undefined;
  /** Where the number came from: the evidence line under a read amount. */
  caption?: string | undefined;
  captionWarns?: boolean;
}): ReactNode {
  return (
    <View style={styles.amountBlock}>
      <Text style={styles.amountText}>{amount}</Text>

      {onCurrencyChange === undefined ? (
        <>
          <Text style={text.faint}>{currency}</Text>
          {note !== undefined && <Text style={text.faint}>{note}</Text>}
        </>
      ) : (
        <CurrencyField value={currency} onChange={onCurrencyChange} note={note} />
      )}

      {caption !== undefined && (
        <Text style={captionWarns ? styles.warn : text.faint} numberOfLines={2}>
          {caption}
        </Text>
      )}
    </View>
  );
}

/**
 * The number pad.
 *
 * One key set, one set of labels. Two screens had drifted to different ones —
 * `C` on the photo screen, `clear` on the typed one — which is the kind of
 * difference nobody decides on and everybody notices.
 */
const KEYPAD = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['clear', '0', 'back'],
] as const;

export type KeypadKey = 'clear' | 'back' | number;

export function Keypad({ onPress }: { onPress: (key: KeypadKey) => void }): ReactNode {
  return (
    <View style={styles.keypad}>
      {KEYPAD.map((row) => (
        <View key={row.join()} style={styles.keypadRow}>
          {row.map((key) => (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={key === 'back' ? 'backspace' : key}
              style={styles.key}
              onPress={() => {
                onPress(key === 'clear' || key === 'back' ? key : Number(key));
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
  );
}

export interface ButtonProps {
  readonly label: string;
  /** Shown instead of the label while the action is running. */
  readonly busyLabel?: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly icon?: ReactNode;
}

/** The one action a screen is for. At most one of these is on screen at a time. */
export function PrimaryButton({
  label,
  busyLabel,
  onPress,
  disabled = false,
  busy = false,
  icon,
}: ButtonProps): ReactNode {
  const off = disabled || busy;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      style={[styles.primary, off && styles.off]}
      disabled={off}
      onPress={onPress}
    >
      {icon}
      <Text style={styles.primaryText}>{busy ? (busyLabel ?? label) : label}</Text>
    </Pressable>
  );
}

/** Everything else that is still a decision: preview, cancel, read it again. */
export function SecondaryButton({
  label,
  busyLabel,
  onPress,
  disabled = false,
  busy = false,
  icon,
}: ButtonProps): ReactNode {
  const off = disabled || busy;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      style={[styles.secondary, off && styles.off]}
      disabled={off}
      onPress={onPress}
    >
      {icon}
      <Text style={styles.secondaryText}>{busy ? (busyLabel ?? label) : label}</Text>
    </Pressable>
  );
}

/**
 * An action that destroys something: forget a key, delete a spend.
 *
 * Outlined rather than filled — it is never the thing a screen is for — and in
 * the one colour the app uses for "this does not come back".
 */
export function DangerButton({ label, onPress, disabled = false }: ButtonProps): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={[styles.danger, disabled && styles.off]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={styles.dangerText}>{label}</Text>
    </Pressable>
  );
}

/**
 * Small print, full-size target: the text is quiet, the control is not.
 * Deleting a model, clearing a filter — reversible, rarely wanted, never hidden.
 */
export function QuietButton({ label, onPress }: { label: string; onPress: () => void }): ReactNode {
  return (
    <Pressable accessibilityRole="button" style={styles.quiet} onPress={onPress}>
      <Text style={styles.quietText}>{label}</Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: ReactNode }): ReactNode {
  return <View style={styles.chipRow}>{children}</View>;
}

/** A horizontally scrolling row, for chips that will not fit on a phone. */
export function ScrollingChipRow({ children }: { children: ReactNode }): ReactNode {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // No wrapping inside a horizontal scroller: wrapped children collapse
      // into a single column the moment the row is wider than the screen.
      contentContainerStyle={styles.chipStrip}
    >
      {children}
    </ScrollView>
  );
}

export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.chip, selected && styles.chipSelected]}
      onPress={onPress}
    >
      <Text style={selected ? styles.chipTextSelected : styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Something went wrong, announced.
 *
 * The live region matters: an error that appears below the fold on a scrolling
 * form is one a screen reader user never hears about, and they are the ones
 * least able to go looking for it.
 */
export function FormError({ message }: { message: string | null }): ReactNode {
  if (message === null) return null;

  return (
    <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error}>
      {message}
    </Text>
  );
}

/** Something to check before saving. Not an error — the save is still allowed. */
export function FormWarning({ message }: { message: string }): ReactNode {
  return <Text style={styles.warn}>{message}</Text>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  field: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 2,
  },
  input: { color: colors.text, fontSize: 16, paddingVertical: spacing.xs },
  amountBlock: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.md },
  amountText: {
    color: colors.text,
    fontSize: 48,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
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
  primary: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
  },
  primaryText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
  secondary: {
    flexDirection: 'row',
    gap: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryText: { color: colors.text, fontWeight: '600', fontSize: 16 },
  danger: {
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  dangerText: { color: colors.danger, fontWeight: '600', fontSize: 16 },
  off: { opacity: 0.4 },
  quiet: {
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
  },
  quietText: { color: colors.textMuted },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chipStrip: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.xs },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxWidth: 180,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 13 },
  chipTextSelected: { color: colors.accentText, fontSize: 13, fontWeight: '700' },
  warn: { color: colors.pending, fontSize: 12 },
  error: { color: colors.danger },
});
