import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLedger } from '../src/db/provider';
import {
  clearExports,
  exportCsv,
  exportPdf,
  rangeLabel,
  shareExport,
} from '../src/export/service';
import type { ExportRange, ExportResult } from '../src/export/service';
import { MIN_TOUCH_TARGET, colors, radius, spacing, text } from '../src/ui/theme';

const RANGES: readonly ExportRange[] = ['all', 'this-year', 'last-90-days'];

/**
 * Exporting: the one place the app writes the user's money data in the clear.
 *
 * The warning is above the buttons, not behind a link and not after the fact.
 * Everything else in this app is encrypted at rest or never leaves the device,
 * so the one exception has to be stated where the decision is made.
 */
export default function ExportScreen(): ReactNode {
  const ledger = useLedger();

  const [range, setRange] = useState<ExportRange>('all');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(ExportResult & { kind: string }) | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: 'CSV' | 'PDF'): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus(`Writing the ${kind}…`);

    try {
      const written =
        kind === 'CSV' ? await exportCsv(ledger, range) : await exportPdf(ledger, range);

      setResult({ ...written, kind });
      setStatus(
        `${kind}: ${String(written.rows)} entries, ${formatSize(written.bytes)}. Not encrypted.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const share = async (): Promise<void> => {
    if (!result) return;

    try {
      const shared = await shareExport(result.path);
      if (!shared) setError('This device has no way to share a file.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const discard = async (): Promise<void> => {
    const removed = await clearExports();
    setResult(null);
    setStatus(removed === 0 ? 'Nothing to delete.' : `Deleted ${String(removed)} exported file(s).`);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.warnBox}>
        <Text style={styles.warnTitle}>Exports are not protected</Text>
        <Text style={styles.warnBody}>
          A CSV or PDF is plain, unencrypted text. Anyone who opens the file — or the app
          you send it to — can read every entry. It is for spreadsheets and taxes, not for
          backup: it cannot be restored from, and it is not a substitute for one.
        </Text>
      </View>

      <Text style={text.heading}>What to include</Text>
      <View style={styles.rangeRow}>
        {RANGES.map((option) => (
          <Pressable accessibilityRole="button"
            key={option}
            style={[styles.range, option === range && styles.rangeActive]}
            onPress={() => {
              setRange(option);
              setResult(null);
              setStatus(null);
            }}
          >
            <Text style={[styles.rangeText, option === range && styles.rangeTextActive]}>
              {rangeLabel(option)}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable accessibilityRole="button" style={styles.primary} onPress={() => void run('CSV')} disabled={busy}>
        <Text style={styles.primaryText}>{busy ? 'Working…' : 'Export CSV'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => void run('PDF')} disabled={busy}>
        <Text style={styles.secondaryText}>Export PDF report</Text>
      </Pressable>

      {result !== null && (
        <>
          <Pressable accessibilityRole="button" style={styles.primary} onPress={() => void share()}>
            <Text style={styles.primaryText}>Share the {result.kind}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={styles.quiet} onPress={() => void discard()}>
            <Text style={styles.quietText}>Delete the files from this device</Text>
          </Pressable>
        </>
      )}

      {status !== null && <Text style={styles.status}>{status}</Text>}
      {error !== null && <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.error}
        >
          {error}
        </Text>}
    </ScrollView>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  warnBox: {
    borderWidth: 1,
    borderColor: colors.pending,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  warnTitle: { color: colors.pending, fontWeight: '700', fontSize: 16 },
  warnBody: { color: colors.textMuted, fontSize: 14 },
  rangeRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  range: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rangeActive: { borderColor: colors.accent, backgroundColor: colors.surfaceRaised },
  rangeText: { color: colors.textMuted },
  rangeTextActive: { color: colors.text, fontWeight: '600' },
  primary: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  primaryText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
  secondary: {
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryText: { color: colors.text, fontWeight: '600' },
  quiet: {
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    // Small print, full-size target: the text is quiet, the control is not.
    minHeight: MIN_TOUCH_TARGET,
  },
  quietText: { color: colors.textMuted },
  status: { color: colors.text },
  error: { color: colors.danger },
});
