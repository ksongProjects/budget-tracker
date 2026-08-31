// Must come first: Hermes has no Web Crypto, and @budget/schema's uuidv7 uses
// crypto.getRandomValues. Without this the database cannot even be opened.
// Keeping the polyfill here rather than in the package leaves the package
// platform-agnostic — the app supplies what its runtime lacks.
import 'react-native-get-random-values';
import { Link, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { LedgerProvider, useLedgerState } from '../src/db/provider';
import { registerAutoBackupTask, useAutoBackup } from '../src/backup/auto';
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

  // Mounted at the root, not on the backup screen: a backup that only happens
  // while the user is looking at the backup screen is not an automatic backup.
  useAutoBackup(state.status === 'ready' ? state.ledger : undefined);

  useEffect(() => {
    void registerAutoBackupTask().catch((cause: unknown) => {
      // The OS schedule is the second chance, not the mechanism. Losing it is
      // not worth a message on a screen the user came to for something else.
      console.warn('could not register the backup schedule', cause);
    });
  }, []);

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
      <Stack.Screen
        name="index"
        options={{
          title: 'Ledger',
          // Backup and Export are otherwise unreachable without a deep link,
          // and a backup nobody can find is a backup nobody sets up.
          headerRight: () => (
            <View style={styles.headerLinks}>
              <HeaderLink href="/export" label="Export" />
              <HeaderLink href="/backup" label="Backup" />
            </View>
          ),
        }}
      />
      <Stack.Screen name="add" options={{ title: 'New spend', presentation: 'modal' }} />
      <Stack.Screen name="summary" options={{ title: 'Summary' }} />
      <Stack.Screen name="transaction/[id]" options={{ title: 'Spend' }} />
      <Stack.Screen name="capture" options={{ title: 'Photograph receipt' }} />
      <Stack.Screen name="voice" options={{ title: 'Say a spend' }} />
      <Stack.Screen name="confirm/[captureId]" options={{ title: 'Check the details' }} />
      <Stack.Screen name="backup" options={{ title: 'Backup' }} />
      <Stack.Screen name="export" options={{ title: 'Export' }} />
      <Stack.Screen name="assist" options={{ title: 'Reading receipts' }} />
      <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics' }} />
      <Stack.Screen name="perf" options={{ title: 'Benchmarks' }} />
    </Stack>
  );
}

function HeaderLink({ href, label }: { href: '/export' | '/backup'; label: string }): ReactNode {
  return (
    <Link href={href} asChild>
      <Pressable hitSlop={8}>
        <Text style={styles.headerLink}>{label}</Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  headerLinks: { flexDirection: 'row', gap: spacing.md },
  headerLink: { color: colors.accent, fontSize: 15, fontWeight: '600' },
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
