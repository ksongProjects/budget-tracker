import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CurrencySchema, uuidv7 } from '@budget/schema';
import { useLedger } from '../src/db/provider';
import { Asset } from 'expo-asset';
import { extractReceipt } from '@budget/extract';
import { coldStart, measureRepeated } from '../src/lib/perf';
import type { MeasurementResult } from '../src/lib/perf';
import { loadOcrEngine } from '../src/capture/ocr';
import { createBackup } from '../src/backup/service';
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

    // Undefined until the ledger has painted; omitted rather than faked.
    const cold = coldStart();
    const collected: MeasurementResult[] = cold ? [cold] : [];
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

    // Writing is on the budget list too, and it is the one the user waits on
    // most often: every capture ends in an insert.
    push(
      await measureRepeated('insert one transaction', 5, async () => {
        await ledger.transactions.create(benchmarkRow());
      }),
    );

    // Shutter to provisional total: OCR plus the tier-2 rules, which is what
    // stands between the shutter sound and a number on screen. Measured over
    // the bundled receipt, because a benchmark that depends on what the camera
    // happened to see is not a benchmark.
    setNote('Reading the test receipt…');
    for (const measurement of await measureShutter()) push(measurement);
    setNote(null);

    // A backup of a ledger this size, written the way the app writes one.
    setNote('Writing a backup…');
    push(await measureBackup(ledger));
    setNote(null);

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
/** A row shaped like one the add screen writes, for timing an insert. */
function benchmarkRow() {
  const at = Date.now();
  return {
    captureId: null,
    accountId: null,
    merchantId: null,
    categoryId: null,
    amountMinor: 1234 as never,
    currency: USD,
    occurredAt: at as never,
    postedAt: null,
    note: 'benchmark',
    source: 'manual' as const,
    confirmedAt: at as never,
    fxOriginalMinor: null,
    fxOriginalCurrency: null,
    fxRate: null,
    reconciled: false,
  };
}

/**
 * Shutter to provisional total, over the receipt in the test assets.
 *
 * The budget covers OCR plus the rules, because that is the wait the user
 * feels: the shutter fires and the screen either shows a number or does not.
 */
async function measureShutter(): Promise<MeasurementResult[]> {
  const engine = loadOcrEngine();
  if (!engine) return [];

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const asset = Asset.fromModule(require('../assets/test-receipt.png') as number);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;

  const whole = await measureRepeated('shutter to provisional total', 3, async () => {
    extractReceipt(await engine.recognize(uri));
  });

  // Split, because "over budget" is not actionable and "the engine is 95% of
  // it" is: one half is a native model this app does not control, the other is
  // rules it does.
  const recognised = await engine.recognize(uri);
  const rules = await measureRepeated('  of which the rules', 5, () => {
    extractReceipt(recognised);
    return Promise.resolve();
  });
  const ocr = await measureRepeated('  of which OCR', 3, async () => {
    await engine.recognize(uri);
  });

  return [whole, ocr, rules];
}

/** A real backup of whatever this device is holding, written the way the app writes one. */
async function measureBackup(ledger: ReturnType<typeof useLedger>): Promise<MeasurementResult> {
  return measureRepeated('backup write', 1, async () => {
    await createBackup(ledger);
  });
}

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
