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
import { ProfileProvider, useProfileState } from '../src/profile/context';
import { ProfileSetup } from '../src/profile/setup';
import { registerAutoBackupTask, useAutoBackup } from '../src/backup/auto';
import { CircleUser, decorative } from '../src/ui/icons';
import { colors, spacing, text } from '../src/ui/theme';

export default function RootLayout(): ReactNode {
  return (
    <LedgerProvider>
      <ProfileProvider>
        <StatusBar style="light" />
        <LedgerGate />
      </ProfileProvider>
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

  return <SetupGate />;
}

/**
 * Nobody sees a ledger before the app knows whose it is.
 *
 * Held here rather than redirected from the first screen: a redirect flashes
 * the screen it is redirecting away from, and the very first thing a new user
 * would see would be an empty list belonging to nobody. The rest of the app —
 * every route, the header, the tabs — appears only once there is a profile.
 */
function SetupGate(): ReactNode {
  const { status, profile } = useProfileState();

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (profile === undefined) {
    return <ProfileSetup />;
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
          // The app's name, on the screen the app is about. Everything else —
          // backup, export, the model settings — lives one tap away behind the
          // avatar, rather than as a row of links that grows every phase.
          title: 'TXNS',
          headerTitleStyle: { color: colors.text, fontSize: 22, fontWeight: '800' },
          headerRight: () => <ProfileButton />,
        }}
      />
      <Stack.Screen name="add" options={{ title: 'New spend', presentation: 'modal' }} />
      <Stack.Screen name="profile" options={{ title: 'Profile' }} />
      <Stack.Screen name="import" options={{ title: 'Import a statement' }} />
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

/** The way to everything that is not a transaction: profile, backup, export, settings. */
function ProfileButton(): ReactNode {
  return (
    <Link href="/profile" asChild>
      <Pressable accessibilityRole="button" accessibilityLabel="Profile and settings" hitSlop={12}>
        <CircleUser {...decorative({ size: 28, color: colors.accent })} />
      </Pressable>
    </Link>
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
