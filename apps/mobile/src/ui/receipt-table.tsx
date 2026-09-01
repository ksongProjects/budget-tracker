import { useRef } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatAmount } from '@budget/schema';
import type { Currency, MinorUnits } from '@budget/schema';
import type { ReceiptRowKind } from '@budget/extract';
import { ROW_KINDS, blankRow, editableTotals } from '../capture/table-edit';
import type { EditableRow } from '../capture/table-edit';
import { Plus, Trash2, decorative } from './icons';
import { MIN_TOUCH_TARGET, colors, radius, spacing, text } from './theme';

/**
 * The receipt, as the two columns it was printed as, editable in place.
 *
 * The screen used to show a total and a note and hide everything else behind
 * "read the line items" — so a misread row was invisible until it was in the
 * ledger. Here every row the rules found is on screen, wrong ones can be
 * corrected where they are wrong, and the rows OCR could not price are marked
 * rather than dropped.
 *
 * What the rows add up to is shown against what the receipt claims. The gap is
 * never closed automatically: a discount line, a missed row and a misread digit
 * all look the same to arithmetic, and only the person holding the receipt can
 * tell them apart.
 */

/** How a kind reads on a row. `item` carries no tag — most rows are items. */
const KIND_LABELS: Record<ReceiptRowKind, string> = {
  item: 'Item',
  tax: 'Tax',
  tip: 'Tip',
  fee: 'Fee',
  discount: 'Discount',
  subtotal: 'Subtotal',
  total: 'Total',
};

export interface ReceiptTableEditorProps {
  readonly rows: readonly EditableRow[];
  readonly currency: Currency;
  readonly onChange: (rows: EditableRow[]) => void;
}

export function ReceiptTableEditor({
  rows,
  currency,
  onChange,
}: ReceiptTableEditorProps): ReactNode {
  const totals = editableTotals(rows, currency);
  // A counter rather than a timestamp: two rows added inside the same
  // millisecond would share a key, and React would treat them as one row.
  const added = useRef(0);

  const replace = (key: string, patch: Partial<EditableRow>): void => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  return (
    <View style={styles.table}>
      <View style={styles.headerRow}>
        <Text style={[text.faint, styles.labelColumn]}>Item</Text>
        <Text style={[text.faint, styles.amountColumn]}>{currency}</Text>
        <View style={styles.actionColumn} />
      </View>

      {rows.length === 0 && (
        <Text style={text.faint}>
          No rows were read from this photo. Add them by hand, or just type the total below.
        </Text>
      )}

      {rows.map((row) => (
        <View key={row.key} style={styles.row}>
          <View style={styles.labelColumn}>
            <TextInput
              value={row.label}
              onChangeText={(label) => {
                // Typing over a row makes it the user's, whoever proposed it.
                replace(row.key, { label, source: 'user', confidence: 1 });
              }}
              placeholder="What was it?"
              placeholderTextColor={colors.textFaint}
              style={styles.labelInput}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Row type: ${KIND_LABELS[row.kind]}. Tap to change.`}
              onPress={() => {
                const next = ROW_KINDS[(ROW_KINDS.indexOf(row.kind) + 1) % ROW_KINDS.length];
                replace(row.key, { kind: next ?? 'item' });
              }}
            >
              <Text style={styles.kind}>
                {KIND_LABELS[row.kind]}
                {row.quantity === null ? '' : ` · x${String(row.quantity)}`}
                {row.source === 'model' ? ' · read by a model' : ''}
              </Text>
            </Pressable>
          </View>

          <TextInput
            value={row.amount}
            onChangeText={(amount) => {
              replace(row.key, { amount, source: 'user', confidence: 1 });
            }}
            placeholder="?"
            placeholderTextColor={row.amount === '' ? colors.pending : colors.textFaint}
            keyboardType="decimal-pad"
            style={[styles.amountInput, row.amount === '' && styles.amountMissing]}
          />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete ${row.label === '' ? 'this row' : row.label}`}
            style={styles.actionColumn}
            onPress={() => {
              onChange(rows.filter((other) => other.key !== row.key));
            }}
          >
            <Trash2 {...decorative({ size: 18, color: colors.textFaint })} />
          </Pressable>
        </View>
      ))}

      <Pressable
        accessibilityRole="button"
        style={styles.addRow}
        onPress={() => {
          added.current += 1;
          onChange([...rows, blankRow(`u${String(added.current)}`)]);
        }}
      >
        <Plus {...decorative({ size: 18, color: colors.accent })} />
        <Text style={styles.addText}>Add a row</Text>
      </Pressable>

      <View style={styles.totals}>
        <Totals label="Items" value={formatAmount(totals.itemsMinor, currency)} />
        {totals.taxMinor !== 0 && (
          <Totals label="Tax" value={formatAmount(totals.taxMinor, currency)} />
        )}
        {totals.tipMinor !== 0 && (
          <Totals label="Tip" value={formatAmount(totals.tipMinor, currency)} />
        )}
        <Totals
          label="These rows come to"
          value={formatAmount(totals.itemisedTotal, currency)}
          strong
        />

        {totals.statedTotal !== null && !totals.balanced && (
          <Text style={styles.warn}>
            The receipt says {formatAmount(totals.statedTotal, currency)} — a gap of{' '}
            {formatAmount(Math.abs(totals.differenceMinor) as MinorUnits, currency)}. A discount, or a
            row that did not come through. Worth a look before saving.
          </Text>
        )}

        {totals.missing > 0 && (
          <Text style={styles.warn}>
            {totals.missing === 1
              ? 'One row has no amount yet.'
              : `${String(totals.missing)} rows have no amount yet.`}{' '}
            Rows left blank are not saved.
          </Text>
        )}
      </View>
    </View>
  );
}

function Totals({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): ReactNode {
  return (
    <View style={styles.totalRow}>
      <Text style={strong ? text.body : text.muted}>{label}</Text>
      <Text style={[strong ? text.body : text.muted, styles.figure]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  table: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
  },
  labelColumn: { flex: 1 },
  labelInput: { color: colors.text, fontSize: 15, paddingVertical: spacing.xs },
  kind: { color: colors.textFaint, fontSize: 11 },
  amountColumn: { width: 96, textAlign: 'right' },
  amountInput: {
    width: 96,
    color: colors.text,
    fontSize: 15,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
    paddingVertical: spacing.xs,
  },
  // An unpriced row is the one thing on this screen the user has to act on.
  amountMissing: {
    borderBottomWidth: 1,
    borderBottomColor: colors.pending,
  },
  actionColumn: { width: 28, alignItems: 'flex-end' },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
  },
  addText: { color: colors.accent, fontWeight: '600', fontSize: 15 },
  totals: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  figure: { fontVariant: ['tabular-nums'] },
  warn: { color: colors.pending, fontSize: 12 },
});
