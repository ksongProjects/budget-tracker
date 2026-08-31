import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { forgetApiKey, maskApiKey, readApiKey, saveApiKey } from '../src/llm/key';
import { deviceModel } from '../src/llm/engines';
import { colors, radius, spacing, text } from '../src/ui/theme';

/**
 * Cloud Assist, and the model on this phone.
 *
 * The screen where the app is honest about the one thing that can leave the
 * device. It is off unless a key is here, it never sends without a tap on the
 * capture itself, and what it sends is text with account numbers masked —
 * never the photo, never the audio, never the ledger.
 *
 * The key is the user's own. There is no service of ours in this path, which
 * is why the screen says "your key" rather than "sign in".
 */
export default function AssistScreen(): ReactNode {
  const [stored, setStored] = useState<string | undefined>(undefined);
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const model = deviceModel();

  useEffect(() => {
    void readApiKey().then(setStored);
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setSaved(false);
    try {
      await saveApiKey(entry);
      setStored(await readApiKey());
      setEntry('');
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  const forget = (): void => {
    Alert.alert(
      'Forget this key?',
      'Cloud Assist stops working. Everything else — capture, rules, backups — is unchanged.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: () => {
            void forgetApiKey().then(() => {
              setStored(undefined);
            });
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={text.heading}>On this phone</Text>
        <Text style={text.body}>{model.label}</Text>
        <Text style={text.muted}>{model.capability.reason}</Text>
        <Text style={text.faint}>
          Receipts and voice notes are still read here, by rules that need no model and no network.
          What a model would add is the item-by-item breakdown.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={text.heading}>Cloud Assist</Text>
        <Text style={text.body}>
          Off unless you add a key, and even then it sends nothing until you tap on a specific
          capture and read exactly what would go.
        </Text>
        <Text style={text.muted}>
          What leaves: the extracted text, with card and account numbers masked. What never leaves:
          the photo, the recording, and your ledger.
        </Text>
        <Text style={text.faint}>
          It uses your own API key with your own provider account. This app has no service of its
          own in this path and no key of its own.
        </Text>
      </View>

      {stored === undefined ? (
        <>
          <TextInput
            value={entry}
            onChangeText={setEntry}
            placeholder="Paste your API key"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
          />
          <Pressable
            style={[styles.primary, (busy || entry.trim() === '') && styles.disabled]}
            disabled={busy || entry.trim() === ''}
            onPress={() => void save()}
          >
            <Text style={styles.primaryText}>{busy ? 'Saving…' : 'Save the key'}</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={text.body}>Key on this phone: {maskApiKey(stored)}</Text>
          <Text style={text.faint}>
            Held in the phone&apos;s keystore, alongside your backup keys. It is never written to the
            ledger and never included in a backup.
          </Text>
          <Pressable style={styles.secondary} onPress={forget}>
            <Text style={styles.secondaryText}>Forget this key</Text>
          </Pressable>
        </>
      )}

      {saved && <Text style={text.faint}>Saved.</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.text,
    fontSize: 16,
  },
  primary: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  primaryText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
  disabled: { opacity: 0.5 },
  secondary: {
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryText: { color: colors.danger, fontWeight: '600' },
});
