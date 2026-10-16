import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatAmount, sumAmounts } from '@budget/schema';
import type { Category, CategoryId, Currency, LineItemKind, MinorUnits } from '@budget/schema';
import { Card, Chip, ScrollingChipRow } from './form';
import { colors, spacing, text } from './theme';

/** The part of an item a list shows — stored, implied or still a draft. */
export interface ShownItem {
  readonly kind: LineItemKind;
  readonly name: string;
  readonly quantity: number | null;
  readonly totalMinor: MinorUnits;
}

/**
 * What was bought.
 *
 * One list for every record, whatever made it — a receipt's rows, the things
 * said in a recording, or the single implied item of a typed spend — so a
 * record always reads as date, merchant, items, total. It also says whether the
 * items still add up, since the total can be edited afterwards and the items
 * cannot follow it on their own.
 */
export function ItemList({
  items,
  currency,
  total,
  title = 'What was bought',
}: {
  items: readonly ShownItem[];
  currency: Currency;
  total: MinorUnits;
  title?: string;
}): ReactNode {
  if (items.length === 0) return null;

  const itemised = sumAmounts(items.map((item) => item.totalMinor));

  return (
    <Card>
      <Text style={text.faint}>{title}</Text>

      {items.map((item, index) => (
        <View key={`${String(index)}-${item.name}`} style={styles.row}>
          <Text style={[text.body, styles.name]} numberOfLines={1}>
            {item.quantity === null ? '' : `${String(item.quantity)} × `}
            {item.name}
            {item.kind === 'item' ? '' : ` · ${item.kind}`}
          </Text>
          <Text style={[text.body, styles.figure]}>{formatAmount(item.totalMinor, currency)}</Text>
        </View>
      ))}

      {itemised !== total && (
        <Text style={styles.mismatch}>
          These come to {formatAmount(itemised, currency)}, not the {formatAmount(total, currency)}{' '}
          total.
        </Text>
      )}
    </Card>
  );
}

/** Choosing a category: optional, one tap to pick, one more to clear. */
export function CategoryPicker({
  categories,
  selected,
  onSelect,
}: {
  categories: readonly Category[];
  selected: CategoryId | null;
  onSelect: (id: CategoryId | null) => void;
}): ReactNode {
  if (categories.length === 0) return null;

  return (
    <ScrollingChipRow>
      {categories.map((category) => (
        <Chip
          key={category.id}
          label={category.name}
          selected={category.id === selected}
          onPress={() => {
            onSelect(category.id === selected ? null : category.id);
          }}
        />
      ))}
    </ScrollingChipRow>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  name: { flexShrink: 1 },
  figure: { fontVariant: ['tabular-nums'] },
  mismatch: { color: colors.pending, fontSize: 12, marginTop: spacing.xs },
});
