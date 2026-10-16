import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLedger } from '../src/db/provider';
import { expoScratchStorage } from '../src/db/driver';
import { Asset } from 'expo-asset';
import { extractReceipt } from '@budget/extract';
import { BUDGETS, coldStart, measureRepeated } from '../src/lib/perf';
import type { MeasurementResult } from '../src/lib/perf';
import {
  BENCHMARK_DATABASE,
  insertBenchmarkRow,
  openScratchLedger,
  seed,
} from '../src/lib/scratch-ledger';
import type { ScratchDatabase } from '../src/lib/scratch-ledger';
import { loadOcrEngine } from '../src/capture/ocr';
import { prepareBenchmarkBackup } from '../src/backup/service';
import { colors, radius, spacing, text } from '../src/ui/theme';

const SEED_ROWS = 10_000;

/**
 * Measures the implementation plan's budgets on real hardware.
 *
 * Seeds a scratch ledger far larger than a real user's so the indexes are
 * actually exercised — a query that is fast over twelve rows tells you nothing.
 * The user's own ledger is only read, never written: this screen ships in
 * release builds, and the phone it runs on may hold someone's real spending.
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

    let scratch: ScratchDatabase | undefined;

    try {
      // The one measurement taken on the user's own ledger, and it only reads.
      const own = await ledger.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
      push(
        await measureRepeated(
          `ledger page query (50 rows, your ${String(own?.n ?? 0)})`,
          5,
          () => ledger.transactions.list({ limit: 50 }),
          BUDGETS['ledger page query (50 rows)'],
        ),
      );

      // Everything else runs against a scratch database: seeding ten thousand
      // rows and timing inserts are writes, and none of them belong in a real
      // ledger — or in the backups made from it.
      scratch = await openScratchLedger(BENCHMARK_DATABASE, expoScratchStorage);
      const bench = scratch.ledger;

      setNote(`Seeding ${String(SEED_ROWS)} transactions…`);
      push(await measureRepeated('seed 10k transactions', 1, () => seed(bench, SEED_ROWS)));
      setNote(null);

      push(await measureRepeated('ledger page query over 10k rows', 10, () =>
        bench.transactions.list({ limit: 50 }),
      ));
      push(await measureRepeated('summary by category over 10k rows', 5, () =>
        bench.transactions.summary('category'),
      ));
      push(await measureRepeated('summary by month', 5, () => bench.transactions.summary('month')));
      push(await measureRepeated('full-text search', 5, () => bench.transactions.search('coffee')));

      // Writing is on the budget list too, and it is the one the user waits on
      // most often: every capture ends in an insert.
      push(await measureRepeated('insert one transaction', 5, () => insertBenchmarkRow(bench)));

      // Shutter to provisional total: OCR plus the tier-2 rules, which is what
      // stands between the shutter sound and a number on screen. Measured over
      // the bundled receipt, because a benchmark that depends on what the camera
      // happened to see is not a benchmark.
      // Not fatal: a release build bundles the receipt as an Android resource,
      // which OCR cannot open by name, and that should cost this one number,
      // not the backup timing after it.
      setNote('Reading the test receipt…');
      let shutterFailure: string | null = null;
      try {
        for (const measurement of await measureShutter()) push(measurement);
      } catch (error) {
        shutterFailure = `Shutter not measured: ${error instanceof Error ? error.message : String(error)}`;
      }
      setNote(null);

      // A backup of a ledger this size: snapshot, encryption and the write,
      // with throwaway keys into a scratch folder.
      setNote('Writing a backup…');
      const backup = await prepareBenchmarkBackup(bench);
      try {
        push(await measureRepeated('backup write', 1, backup.write));
      } finally {
        await backup.discard();
      }
      setNote(shutterFailure);
    } catch (error) {
      setNote(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        await scratch?.discard();
      } catch (error) {
        setNote(`Scratch database left behind: ${error instanceof Error ? error.message : String(error)}`);
      }
      setRunning(false);
    }
  };

  const failed = results.filter((r) => r.withinBudget === false).length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={text.muted}>
        Runs the implementation plan&apos;s budgets against this device. Seeds{' '}
        {SEED_ROWS.toLocaleString()} rows into a separate scratch database, deleted afterwards
        — your own ledger and backups are not written to.
      </Text>

      <Pressable accessibilityRole="button" style={styles.button} onPress={() => void run()} disabled={running}>
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
