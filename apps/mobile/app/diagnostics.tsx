import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DRIVER_CONTRACT } from '@budget/db';
import { createExpoDriver } from '../src/db/driver';
import { colors, radius, spacing, text } from '../src/ui/theme';

/**
 * Runs the shared driver contract against the real expo-sqlite driver, on the
 * device.
 *
 * CI proves the contract against node:sqlite, which is not the database that
 * ships. This screen is how the mobile driver's behaviour gets checked on real
 * hardware — a device build, open this, everything green. Without it, "the
 * mobile driver behaves like the tested one" is an assumption.
 */

interface Result {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: string;
}

export default function DiagnosticsScreen(): ReactNode {
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);

  const run = async (): Promise<void> => {
    setRunning(true);
    setResults([]);

    const collected: Result[] = [];
    for (const [index, testCase] of DRIVER_CONTRACT.entries()) {
      // A scratch database per case, so one failure cannot cascade.
      const name = `contract-${String(index)}-${String(Date.now())}.db`;
      const driver = await createExpoDriver(name);
      try {
        await testCase.run(driver);
        collected.push({ name: testCase.name, passed: true });
      } catch (error) {
        collected.push({
          name: testCase.name,
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await driver.close();
      }
      setResults([...collected]);
    }

    setRunning(false);
  };

  const failed = results.filter((r) => !r.passed).length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={text.muted}>
        Runs the same contract CI runs against node:sqlite, but against the
        database this app actually uses.
      </Text>

      <Pressable style={styles.button} onPress={() => void run()} disabled={running}>
        <Text style={styles.buttonText}>{running ? 'Running…' : 'Run driver contract'}</Text>
      </Pressable>

      {results.length > 0 && (
        <Text style={[text.heading, failed > 0 ? styles.fail : styles.pass]}>
          {failed === 0
            ? `All ${String(results.length)} passed`
            : `${String(failed)} of ${String(results.length)} failed`}
        </Text>
      )}

      {results.map((result) => (
        <View key={result.name} style={styles.row}>
          <Text style={result.passed ? styles.pass : styles.fail}>
            {result.passed ? '✓' : '✗'} {result.name}
          </Text>
          {result.error !== undefined && <Text style={styles.errorText}>{result.error}</Text>}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  buttonText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
  row: { backgroundColor: colors.surface, borderRadius: radius.sm, padding: spacing.sm, gap: spacing.xs },
  pass: { color: colors.text },
  fail: { color: colors.danger },
  errorText: { color: colors.danger, fontSize: 12 },
});
