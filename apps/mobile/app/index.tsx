import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { formatAmount } from '@budget/schema';
import type { Transaction } from '@budget/schema';
import { useQuery } from '../src/db/provider';
import { groupByDay, monthLabel } from '../src/lib/grouping';
import type { DaySection } from '../src/lib/grouping';
import { markInteractive } from '../src/lib/perf';
import { backupHealth } from '../src/backup/health';
import type { BackupVerdict } from '../src/backup/health';
import { hasKeyMaterial } from '../src/backup/keys';
import { lastBackupAt } from '../src/backup/service';
import { cloudStatus } from '../src/cloud/sync';
import { colors, radius, spacing, text } from '../src/ui/theme';

const PAGE_SIZE = 50;

/** One flat array of rows so the list virtualizes headers and items together. */
type Row =
  | { readonly kind: 'month'; readonly key: string; readonly label: string }
  | { readonly kind: 'day'; readonly key: string; readonly section: DaySection }
  | { readonly kind: 'item'; readonly key: string; readonly transaction: Transaction };

export default function LedgerScreen(): ReactNode {

  const router = useRouter();
  const [version, setVersion] = useState(0);

  // Writes happen on other screens; refresh on focus rather than wiring a
  // subscription layer this app is too small to need.
  useFocusEffect(
    useCallback(() => {
      setVersion((v) => v + 1);
    }, []),
  );

  const { data, loading, error } = useQuery(
    (l) => l.transactions.list({ limit: PAGE_SIZE }),
    [],
    version,
  );

  const backup = useBackupVerdict(version);

  const rows = useMemo(() => toRows(data ?? []), [data]);

  // The app is usable the first time this screen has data to show.
  if (!loading) markInteractive();

  if (error) {
    return <Centered message={error.message} />;
  }

  if (!loading && rows.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={text.heading}>Nothing captured yet</Text>
        <Text style={[text.muted, styles.emptyBody]}>
          Everything you record stays on this device.
        </Text>
        <Link href="/add" asChild>
          <Pressable accessibilityRole="button" style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Add a spend</Text>
          </Pressable>
        </Link>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <BackupNudge verdict={backup} />
      <FlashList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        renderItem={({ item: row }) => {
          if (row.kind === 'month') return <MonthHeader label={row.label} />;
          if (row.kind === 'day') return <DayHeader section={row.section} />;
          return (
            <TransactionRow
              transaction={row.transaction}
              onPress={() => {
                router.push(`/transaction/${row.transaction.id}`);
              }}
            />
          );
        }}
        contentContainerStyle={styles.listContent}
      />

      <View style={styles.fabRow}>
        <Link href="/add" asChild>
          <Pressable accessibilityRole="button" style={styles.fabSecondary} accessibilityLabel="Type a spend">
            <Text style={styles.fabSecondaryText}>+</Text>
          </Pressable>
        </Link>
        <Link href="/voice" asChild>
          <Pressable accessibilityRole="button" style={styles.fabSecondary} accessibilityLabel="Say a spend">
            <Text style={styles.fabSecondaryText}>🎙</Text>
          </Pressable>
        </Link>
        <Link href="/capture" asChild>
          <Pressable accessibilityRole="button" style={styles.fab} accessibilityLabel="Photograph a receipt">
            <Text style={styles.fabText}>◉</Text>
          </Pressable>
        </Link>
      </View>
    </View>
  );
}

function toRows(transactions: readonly Transaction[]): Row[] {
  const rows: Row[] = [];

  for (const section of groupByDay(transactions)) {
    if (section.startsMonth !== null) {
      rows.push({
        kind: 'month',
        key: `month:${section.startsMonth}`,
        label: monthLabel(section.startsMonth),
      });
    }
    rows.push({ kind: 'day', key: `day:${section.dayKey}`, section });
    for (const transaction of section.items) {
      rows.push({ kind: 'item', key: transaction.id, transaction });
    }
  }

  return rows;
}

function MonthHeader({ label }: { label: string }): ReactNode {
  return (
    <View style={styles.monthHeader}>
      <Text style={text.title}>{label}</Text>
    </View>
  );
}

function DayHeader({ section }: { section: DaySection }): ReactNode {
  return (
    <View style={styles.dayHeader}>
      <Text style={text.muted}>{section.label}</Text>
      <View style={styles.dayHeaderRight}>
        {section.pendingCount > 0 && (
          <Text style={styles.pendingBadge}>
            {section.pendingCount} to confirm
          </Text>
        )}
        {section.totalMinor !== null && section.currency !== null && (
          <Text style={[text.muted, styles.dayTotal]}>
            {formatAmount(section.totalMinor, section.currency)}
          </Text>
        )}
      </View>
    </View>
  );
}

function TransactionRow({
  transaction,
  onPress,
}: {
  transaction: Transaction;
  onPress: () => void;
}): ReactNode {
  const pending = transaction.confirmedAt === null;

  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={text.body} numberOfLines={1}>
          {transaction.note ?? 'Untitled'}
        </Text>
        {pending && <Text style={styles.pendingLabel}>Not counted until you confirm</Text>}
      </View>
      <Text style={[text.amount, pending && styles.amountPending]}>
        {formatAmount(transaction.amountMinor, transaction.currency)}
      </Text>
    </Pressable>
  );
}

function Centered({ message }: { message: string }): ReactNode {
  return (
    <View style={styles.empty}>
      <Text style={text.muted}>{message}</Text>
    </View>
  );
}

/**
 * The backup nudge.
 *
 * Shown on the screen the user actually lives on, because a warning behind a
 * settings menu is one nobody sees. It links to the place that fixes it, and it
 * stays quiet when there is nothing to fix — a badge that is always on is a
 * badge nobody reads.
 */
function BackupNudge({ verdict }: { verdict: BackupVerdict | undefined }): ReactNode {
  if (verdict === undefined || verdict.health === 'ok') return null;

  return (
    <Link href="/backup" asChild>
      {/* Flattened, not an array: expo-router refuses to pass a style array
          through `asChild`, and it refuses at render time on a screen the user
          is looking at. */}
      <Pressable accessibilityRole="button"
        style={StyleSheet.flatten([
          styles.nudge,
          verdict.health === 'urgent' ? styles.nudgeUrgent : styles.nudgeWarn,
        ])}
      >
        <Text style={styles.nudgeText}>{verdict.message}</Text>
        <Text style={styles.nudgeAction}>Fix</Text>
      </Pressable>
    </Link>
  );
}

function useBackupVerdict(version: number): BackupVerdict | undefined {
  const [verdict, setVerdict] = useState<BackupVerdict | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const check = async (): Promise<void> => {
      const [isSetUp, at, cloud] = await Promise.all([
        hasKeyMaterial(),
        lastBackupAt(),
        cloudStatus(),
      ]);

      if (cancelled) return;
      setVerdict(
        backupHealth({
          isSetUp,
          ...(at === undefined ? {} : { lastBackupAt: at }),
          cloudConfigured: cloud.configured,
          cloudSignedIn: cloud.signedIn,
          ...(cloud.lastUploadAt === undefined ? {} : { lastUploadAt: cloud.lastUploadAt }),
          ...(cloud.lastError === undefined ? {} : { lastError: cloud.lastError }),
        }),
      );
    };

    void check();
    return () => {
      cancelled = true;
    };
  }, [version]);

  return verdict;
}

const styles = StyleSheet.create({
  nudge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
  },
  nudgeWarn: { backgroundColor: colors.surface, borderBottomColor: colors.pending },
  nudgeUrgent: { backgroundColor: colors.surfaceRaised, borderBottomColor: colors.danger },
  nudgeText: { color: colors.text, flexShrink: 1, fontSize: 14 },
  nudgeAction: { color: colors.accent, fontWeight: '600' },
  screen: { flex: 1, backgroundColor: colors.background },
  listContent: { paddingBottom: spacing.xl * 3 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: spacing.lg,
  },
  emptyBody: { marginTop: spacing.sm, textAlign: 'center' },
  monthHeader: { paddingHorizontal: spacing.md, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  dayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  dayHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dayTotal: { fontVariant: ['tabular-nums'] },
  pendingBadge: { color: colors.pending, fontSize: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    marginHorizontal: spacing.md,
    marginBottom: spacing.xs,
    borderRadius: radius.md,
    gap: spacing.md,
  },
  rowMain: { flex: 1 },
  pendingLabel: { color: colors.pending, fontSize: 12, marginTop: 2 },
  amountPending: { color: colors.pending },
  primaryButton: {
    marginTop: spacing.lg,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  primaryButtonText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
  fabRow: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  fab: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabText: { color: colors.accentText, fontSize: 28, lineHeight: 32, fontWeight: '600' },
  fabSecondary: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabSecondaryText: { color: colors.text, fontSize: 26, lineHeight: 30, fontWeight: '600' },
});
