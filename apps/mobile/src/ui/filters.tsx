import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Timestamp } from '@budget/schema';
import { Search, decorative } from './icons';
import { MIN_TOUCH_TARGET, colors, radius, spacing } from './theme';

/**
 * Narrowing the ledger.
 *
 * Three questions, because they are the ones people actually ask a spending
 * app: what did I spend on X, what happened this month, and what have I not
 * confirmed yet. Anything more — amount ranges, per-merchant, per-account —
 * belongs behind a screen of its own rather than a bar that gets in the way of
 * the list every time it is not being used.
 *
 * The state lives in the screen; this only draws it. That keeps the query in
 * one place and stops the bar from having an opinion about the database.
 */

export type Period = 'all' | 'month' | 'week';
export type Status = 'all' | 'pending';

export interface Filters {
  readonly query: string;
  readonly period: Period;
  readonly status: Status;
}

export const NO_FILTERS: Filters = { query: '', period: 'all', status: 'all' };

export function isFiltered(filters: Filters): boolean {
  return filters.query.trim() !== '' || filters.period !== 'all' || filters.status !== 'all';
}

/** The `from` a period means, or undefined for "everything". */
export function periodStart(period: Period, now: number): Timestamp | undefined {
  if (period === 'all') return undefined;

  const date = new Date(now);
  if (period === 'week') return (now - 7 * 86_400_000) as Timestamp;

  // "This month" means the calendar month, not thirty days: it is the number
  // people compare against their own idea of a monthly budget.
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) as Timestamp;
}

export interface FilterBarProps {
  readonly value: Filters;
  readonly onChange: (next: Filters) => void;
}

export function FilterBar({ value, onChange }: FilterBarProps): ReactNode {
  return (
    <View style={styles.bar}>
      <View style={styles.searchRow}>
        <Search {...decorative({ size: 18, color: colors.textMuted })} />
        <TextInput
          value={value.query}
          onChangeText={(query) => {
            onChange({ ...value, query });
          }}
          placeholder="Search merchants and notes"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search transactions"
          style={styles.search}
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        <Chip
          label="All time"
          selected={value.period === 'all'}
          onPress={() => {
            onChange({ ...value, period: 'all' });
          }}
        />
        <Chip
          label="This month"
          selected={value.period === 'month'}
          onPress={() => {
            onChange({ ...value, period: 'month' });
          }}
        />
        <Chip
          label="Last 7 days"
          selected={value.period === 'week'}
          onPress={() => {
            onChange({ ...value, period: 'week' });
          }}
        />
        <Chip
          label="To confirm"
          selected={value.status === 'pending'}
          onPress={() => {
            onChange({ ...value, status: value.status === 'pending' ? 'all' : 'pending' });
          }}
        />
      </ScrollView>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.chip, selected && styles.chipSelected]}
      onPress={onPress}
    >
      <Text style={selected ? styles.chipTextSelected : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    minHeight: MIN_TOUCH_TARGET,
  },
  search: { flex: 1, color: colors.text, fontSize: 15 },
  chips: { gap: spacing.sm, paddingRight: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: colors.accentText, fontSize: 13, fontWeight: '700' },
});
