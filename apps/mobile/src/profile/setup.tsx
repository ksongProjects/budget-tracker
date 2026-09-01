import { useState } from 'react';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CurrencySchema } from '@budget/schema';
import type { Currency } from '@budget/schema';
import { FormError, PrimaryButton } from '../ui/form';
import { colors, spacing, text } from '../ui/theme';
import { ProfileFields, emailLooksWrong } from './fields';
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

  const ready = name.trim() !== '' && !emailLooksWrong(email);

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

        <ProfileFields
          name={name}
          onName={setName}
          email={email}
          onEmail={setEmail}
          currency={currency}
          onCurrency={setCurrency}
        />

        <FormError message={error} />

        <PrimaryButton
          label="Start tracking"
          busyLabel="Setting up…"
          busy={saving}
          disabled={!ready}
          onPress={() => void submit()}
        />

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
});
