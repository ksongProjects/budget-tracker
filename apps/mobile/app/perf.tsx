import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CurrencySchema, uuidv7 } from '@budget/schema';
import { useLedger } from '../src/db/provider';
import { measureRepeated, sinceProcessStart } from '../src/lib/perf';
import type { MeasurementResult } from '../src/lib/perf';
import { colors, radius, spacing, text } from '../src/ui/theme';

const USD = CurrencySchema.parse('USD');
const SEED_ROWS = 10_000;
const DAY = 86_400_000;

/**
 * Measures the implementation plan's budgets against the real database on real
 * hardware.
 *
 * Seeds a ledger far larger than a real user's so the indexes are actually
 * exercised — a query that is fast over twelve rows tells you nothing.
 */
export default function PerfScreen(): ReactNode {
  const ledger = useLedger();
  const [results, setResults] = useState<MeasurementResult[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setRunning(true);
    setResults([]);
    setNote(null);

    const collected: MeasurementResult[] = [sinceProcessStart('cold start to interactive ledger')];
    setResults([...collected]);

    const push = (measurement: MeasurementResult): void => {
      collected.push(measurement);
      setResults([...collected]);
    };

    // Baseline queries against whatever the device already holds.
    push(await measureRepeated('ledger page query (50 rows)', 5, () =>
      ledger.transactions.list({ limit: 50 }),
    ));

    const existing = await ledger.driver.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions',
    );

    if ((existing?.n ?? 0) < SEED_ROWS) {
      setNote(`Seeding ${String(SEED_ROWS)} transactions…`);
      push(await measureRepeated('seed 10k transactions', 1, () => seed(ledger, SEED_ROWS)));
      setNote(null);
    }

    push(await measureRepeated('ledger page query over 10k rows', 10, () =>
      ledger.transactions.list({ limit: 50 }),
    ));
    push(await measureRepeated('summary by category over 10k rows', 5, () =>
      ledger.transactions.summary('category'),
    ));
    push(await measureRepeated('summary by month', 5, () => ledger.transactions.summary('month')));
    push(await measureRepeated('full-text search', 5, () => ledger.transactions.search('coffee')));

    setRunning(false);
  };

  const failed = results.filter((r) => r.withinBudget === false).length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={text.muted}>
        Runs the implementation plan&apos;s budgets against this device. Seeds{' '}
        {SEED_ROWS.toLocaleString()} rows so the indexes are exercised.
      </Text>

      <Pressable style={styles.button} onPress={() => void run()} disabled={running}>
        <Text style={styles.buttonText}>{running ? 'Measuring…' : 'Run benchmarks'}</Text>
      </Pressable>

      {note !== null && <Text style={styles.note}>{note}</Text>}

      {results.length > 0 && !running && (
        <Text style={[text.heading, failed > 0 ? styles.over : styles.under]}>
          {failed === 0 ? 'All within budget' : `${String(failed)} over budget`}
        </Text>
      )}

      {results.map((result) => (
        <View key={result.name} style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={text.body}>{result.name}</Text>
            <Text
              style={[
                text.amount,
                result.withinBudget === false && styles.over,
                result.withinBudget === true && styles.under,
              ]}
            >
              {result.ms} ms
            </Text>
          </View>
          {result.budgetMs !== undefined && (
            <Text style={text.faint}>budget {result.budgetMs} ms</Text>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

/**
 * Seed rows spread across two years so month grouping and the date index have
 * something real to do.
 */
async function seed(ledger: ReturnType<typeof useLedger>, count: number): Promise<void> {
  const start = Date.now() - 730 * DAY;
  const merchants = ['Blue Bottle Coffee', 'Safeway', 'Shell', 'Tartine Bakery', 'Muni'];
  const notes = ['coffee', 'groceries', 'fuel', 'pastry', 'transit'];

  // One transaction: 10k separate commits would measure fsync, not the queries.
  await ledger.driver.transaction(async () => {
    for (let i = 0; i < count; i += 1) {
      const at = start + i * (730 * DAY) / count;
      await ledger.driver.run(
        `INSERT INTO transactions
           (id, amount_minor, currency, occurred_at, source, note, confirmed_at,
            reconciled, rev, updated_at, origin_device)
         VALUES (?, ?, ?, ?, 'manual', ?, ?, 0, 1, ?, ?)`,
        [
          uuidv7(at),
          100 + (i % 9_900),
          USD,
          at,
          `${notes[i % notes.length] ?? ''} ${merchants[i % merchants.length] ?? ''}`,
          at,
          at,
          ledger.deviceId,
        ],
      );
    }
  });
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
  note: { color: colors.pending },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  under: { color: colors.text },
  over: { color: colors.danger },
});
