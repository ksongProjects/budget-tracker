// Must come first: Hermes has no Web Crypto, and @budget/schema's uuidv7 uses
// crypto.getRandomValues. Without this the database cannot even be opened.
// Keeping the polyfill here rather than in the package leaves the package
// platform-agnostic — the app supplies what its runtime lacks.
import 'react-native-get-random-values';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { LedgerProvider, useLedgerState } from '../src/db/provider';
import { colors, spacing, text } from '../src/ui/theme';

export default function RootLayout(): ReactNode {
  return (
    <LedgerProvider>
      <StatusBar style="light" />
      <LedgerGate />
    </LedgerProvider>
  );
}

/**
 * Holds the app back until the database is open and migrated. Startup is local
 * work only, so this is normally a single frame — but a failed migration must
 * be visible rather than leaving screens to query a database that is not there.
 */
function LedgerGate(): ReactNode {
  const state = useLedgerState();

  if (state.status === 'opening') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (state.status === 'failed') {
    return (
      <View style={styles.center}>
        <Text style={[text.heading, styles.errorTitle]}>Could not open your ledger</Text>
        <Text style={[text.muted, styles.errorBody]}>{state.error.message}</Text>
        <Text style={[text.faint, styles.errorBody]}>
          Your data is still on this device. Reopening the app is safe to try.
        </Text>
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTitleStyle: { color: colors.text },
        headerTintColor: colors.accent,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Ledger' }} />
      <Stack.Screen name="add" options={{ title: 'New spend', presentation: 'modal' }} />
      <Stack.Screen name="summary" options={{ title: 'Summary' }} />
      <Stack.Screen name="transaction/[id]" options={{ title: 'Spend' }} />
      <Stack.Screen name="capture" options={{ title: 'Photograph receipt' }} />
      <Stack.Screen name="confirm/[captureId]" options={{ title: 'Check the details' }} />
      <Stack.Screen name="backup" options={{ title: 'Backup' }} />
      <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics' }} />
      <Stack.Screen name="perf" options={{ title: 'Benchmarks' }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: spacing.lg,
  },
  errorTitle: { marginBottom: spacing.sm, textAlign: 'center' },
  errorBody: { marginTop: spacing.sm, textAlign: 'center' },
});
