import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CurrencySchema, formatAmount } from '@budget/schema';
import type { MinorUnits } from '@budget/schema';
import { useQuery } from '../src/db/provider';
import { monthLabel } from '../src/lib/grouping';
import { colors, radius, spacing, text } from '../src/ui/theme';

const DISPLAY_CURRENCY = CurrencySchema.parse('USD');

type GroupBy = 'category' | 'month';

/**
 * Aggregates come from SQLite, not from summing a loaded page: the totals must
 * cover the whole ledger, and only confirmed rows count.
 */
export default function SummaryScreen(): ReactNode {

  const [groupBy, setGroupBy] = useState<GroupBy>('category');

  const { data, loading } = useQuery((l) => l.transactions.summary(groupBy), [groupBy]);
  const { data: total } = useQuery((l) => l.transactions.total(), []);

  const names = useQuery(
    async (l) => {
      if (groupBy !== 'category') return new Map<string, string>();
      const categories = await l.categories.list();
      return new Map(categories.map((c) => [c.id as string, c.name]));
    },
    [groupBy],
  );

  const rows = data ?? [];
  const max = rows.reduce((highest, row) => Math.max(highest, row.totalMinor), 0);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.totalBlock}>
        <Text style={text.faint}>Confirmed spending</Text>
        <Text style={styles.totalText}>
          {formatAmount((total ?? 0) as MinorUnits, DISPLAY_CURRENCY)}
        </Text>
      </View>

      <View style={styles.tabs}>
        {(['category', 'month'] as const).map((option) => (
          <Pressable
            key={option}
            onPress={() => {
              setGroupBy(option);
            }}
            style={[styles.tab, groupBy === option && styles.tabActive]}
          >
            <Text style={[styles.tabText, groupBy === option && styles.tabTextActive]}>
              {option === 'category' ? 'By category' : 'By month'}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading && <Text style={text.muted}>Loading…</Text>}

      {!loading && rows.length === 0 && (
        <Text style={text.muted}>
          Nothing confirmed yet. Amounts count once you confirm them.
        </Text>
      )}

      {rows.map((row) => {
        const label =
          groupBy === 'month'
            ? monthLabel(row.key ?? '')
            : (names.data?.get(row.key ?? '') ?? 'Uncategorized');

        return (
          <View key={row.key ?? 'none'} style={styles.row}>
            <View style={styles.rowHeader}>
              <Text style={text.body}>{label}</Text>
              <Text style={text.amount}>
                {formatAmount(row.totalMinor as MinorUnits, DISPLAY_CURRENCY)}
              </Text>
            </View>
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.barFill,
                  { width: `${max === 0 ? 0 : (row.totalMinor / max) * 100}%` },
                ]}
              />
            </View>
            <Text style={text.faint}>
              {row.count} {row.count === 1 ? 'spend' : 'spends'}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  totalBlock: { alignItems: 'center', paddingVertical: spacing.lg },
  totalText: {
    color: colors.text,
    fontSize: 40,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  tabs: { flexDirection: 'row', gap: spacing.sm },
  tab: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  tabActive: { backgroundColor: colors.accent },
  tabText: { color: colors.textMuted, fontSize: 14 },
  tabTextActive: { color: colors.accentText, fontWeight: '600' },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceRaised },
  barFill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
});
