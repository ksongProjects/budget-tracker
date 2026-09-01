import { useState } from 'react';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLedger } from '../src/db/provider';
import { useProfileState } from '../src/profile/context';
import {
  clearExports,
  exportCsv,
  exportPdf,
  rangeLabel,
  mailExport,
  shareExport,
} from '../src/export/service';
import type { ExportRange, ExportResult } from '../src/export/service';
import {
  Chip,
  ChipRow,
  FormError,
  PrimaryButton,
  QuietButton,
  SecondaryButton,
} from '../src/ui/form';
import { colors, radius, spacing, text } from '../src/ui/theme';

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
  const { profile } = useProfileState();

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

  /**
   * Mail it to the address on the profile.
   *
   * Opens the phone's own composer, prefilled. Nothing is sent by this app —
   * the user presses send, having seen exactly what is attached.
   */
  const mail = async (): Promise<void> => {
    if (result === null) return;

    setError(null);
    try {
      const opened = await mailExport(result.path, {
        to: profile?.email ?? null,
        ...(profile?.displayName === undefined ? {} : { name: profile.displayName }),
      });

      if (!opened) {
        setError('This phone has no mail app set up. Use Share instead.');
      }
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
      <ChipRow>
        {RANGES.map((option) => (
          <Chip
            key={option}
            label={rangeLabel(option)}
            selected={option === range}
            onPress={() => {
              setRange(option);
              setResult(null);
              setStatus(null);
            }}
          />
        ))}
      </ChipRow>

      <PrimaryButton
        label="Export CSV"
        busyLabel="Working…"
        busy={busy}
        onPress={() => void run('CSV')}
      />
      <SecondaryButton
        label="Export PDF report"
        busyLabel="Working…"
        busy={busy}
        onPress={() => void run('PDF')}
      />

      {result !== null && (
        <>
          <PrimaryButton
            label={
              profile?.email === null || profile?.email === undefined
                ? `Email the ${result.kind}`
                : `Email the ${result.kind} to ${profile.email}`
            }
            onPress={() => void mail()}
          />
          <SecondaryButton label={`Share the ${result.kind}`} onPress={() => void share()} />
          <QuietButton
            label="Delete the files from this device"
            onPress={() => void discard()}
          />
        </>
      )}

      {status !== null && <Text style={styles.status}>{status}</Text>}
      <FormError message={error} />
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
  status: { color: colors.text },
});
