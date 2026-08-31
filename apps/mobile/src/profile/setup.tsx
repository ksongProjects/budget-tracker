import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CurrencySchema } from '@budget/schema';
import type { Currency } from '@budget/schema';
import { looksLikeEmail } from '@budget/db';
import { CurrencyPicker } from '../ui/currency';
import { MIN_TOUCH_TARGET, colors, radius, spacing, text } from '../ui/theme';
import { useProfileState } from './context';

/**
 * The first screen, once.
 *
 * Not a sign-up: there is no server to sign up to, nothing is verified, and
 * nothing leaves the phone. What it collects is the three things the rest of
 * the app cannot sensibly guess — what to call you, where to send an export if
 * you ever ask for one, and which currency the keypad should open in.
 *
 * It says all of that plainly, because a form that looks like a registration
 * makes a promise about accounts that this app does not keep.
 */
export function ProfileSetup(): ReactNode {
  const { save } = useProfileState();
  // This screen renders outside the navigator — it is what stands in for it —
  // so nothing else is holding it clear of the status bar and the gesture area.
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currency, setCurrency] = useState<Currency>(CurrencySchema.parse('USD'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailLooksWrong = email.trim() !== '' && !looksLikeEmail(email);
  const ready = name.trim() !== '' && !emailLooksWrong && !saving;

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError(null);

    try {
      await save({ displayName: name, email, defaultCurrency: currency });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={text.title}>TXNS</Text>
        <Text style={text.body}>
          A spending tracker that keeps your records on this phone. There is no account and no
          server — this is just what to call you.
        </Text>

        <View style={styles.field}>
          <Text style={text.muted}>Your name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Name"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="words"
            accessibilityLabel="Your name"
            style={styles.input}
          />
          <Text style={text.faint}>Goes on exports and reports. Nothing else.</Text>
        </View>

        <View style={styles.field}>
          <Text style={text.muted}>Email (optional)</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            accessibilityLabel="Email address"
            style={styles.input}
          />
          <Text style={emailLooksWrong ? styles.warn : text.faint}>
            {emailLooksWrong
              ? 'That does not look like an email address.'
              : 'Only used to fill in the To field when you mail yourself an export. No mail is sent by this app.'}
          </Text>
        </View>

        <View style={styles.field}>
          <CurrencyPicker value={currency} onChange={setCurrency} label="Record spending in" />
          <Text style={text.faint}>
            You can record a spend in any currency; this is the one the keypad opens in.
          </Text>
        </View>

        {error !== null && (
          <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error}>
            {error}
          </Text>
        )}

        <Pressable
          accessibilityRole="button"
          style={[styles.primary, !ready && styles.disabled]}
          disabled={!ready}
          onPress={() => void submit()}
        >
          <Text style={styles.primaryText}>{saving ? 'Setting up…' : 'Start tracking'}</Text>
        </Pressable>

        <Text style={text.faint}>
          Everything you record stays on this device. You can change any of this later.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg, gap: spacing.lg },
  field: { gap: spacing.xs },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
  },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: spacing.sm,
  },
  primaryText: { color: colors.accentText, fontWeight: '700', fontSize: 16 },
  disabled: { opacity: 0.5 },
  warn: { color: colors.pending, fontSize: 12 },
  error: { color: colors.danger },
});
