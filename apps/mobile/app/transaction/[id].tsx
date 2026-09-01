import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatAmount, sumAmounts } from '@budget/schema';
import type { Currency, LineItem, MinorUnits, TransactionId } from '@budget/schema';
import { documentPath } from '../../src/capture/documents';
import { useLedger, useQuery } from '../../src/db/provider';
import {
  AmountHeader,
  Card,
  DangerButton,
  Field,
  PrimaryButton,
  TextField,
} from '../../src/ui/form';
import { colors, radius, spacing, text } from '../../src/ui/theme';

/** Detail, edit, confirm, delete. Delete is soft — the row survives for Merge. */
export default function TransactionScreen(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>();
  const ledger = useLedger();
  const router = useRouter();

  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const { data: transaction, loading } = useQuery(
    (l) => l.transactions.get(id as TransactionId),
    [id],
    version,
  );

  // The breakdown and the photo behind this row. Both are read once the
  // transaction is known, and both are absent for a typed spend, which is a
  // normal state rather than an error.
  const { data: items } = useQuery(
    (l) => l.lineItems.listFor(id as TransactionId),
    [id],
    version,
  );

  const { data: photoUri } = useQuery(
    async (l) => {
      const captureId = transaction?.captureId;
      return captureId === null || captureId === undefined
        ? undefined
        : documentPath(l.driver, captureId);
    },
    [transaction?.captureId],
    version,
  );

  if (loading) return <Message text="Loading…" />;
  if (!transaction) return <Message text="This spend no longer exists." />;

  const pending = transaction.confirmedAt === null;
  const noteValue = note ?? transaction.note ?? '';

  const saveNote = async (): Promise<void> => {
    if (note === null || busy) return;
    setBusy(true);
    try {
      await ledger.transactions.update(transaction.id, {
        note: note.trim() === '' ? null : note.trim(),
      });
      setNote(null);
      setVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await ledger.transactions.confirm(transaction.id);
      setVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  };

  const remove = (): void => {
    Alert.alert('Delete this spend?', 'It stops counting toward your totals.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            await ledger.transactions.softDelete(transaction.id);
            router.back();
          })();
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <AmountHeader
        amount={formatAmount(transaction.amountMinor, transaction.currency)}
        currency={transaction.currency}
      />

      {/* The photo is kept for the life of the row, so "what did I actually
          buy" is answerable months later by looking at the receipt rather than
          by trusting the number that was read off it. Tap to see it full
          height — a thumbnail is enough to recognise, never enough to check. */}
      {photoUri !== undefined && (
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={expanded ? 'Shrink the receipt photo' : 'Enlarge the receipt photo'}
          onPress={() => {
            setExpanded((was) => !was);
          }}
        >
          <Image
            source={{ uri: photoUri }}
            style={[styles.photo, expanded && styles.photoExpanded]}
            resizeMode="contain"
          />
        </Pressable>
      )}

      {items !== undefined && items.length > 0 && (
        <Breakdown items={items} currency={transaction.currency} total={transaction.amountMinor} />
      )}

      {pending && (
        <View style={styles.pendingCard}>
          <Text style={styles.pendingTitle}>Not counted yet</Text>
          <Text style={text.muted}>
            This amount stays out of your totals until you confirm it.
          </Text>
          <PrimaryButton label="Confirm" busy={busy} onPress={() => void confirm()} />
        </View>
      )}

      <TextField
        label="Note"
        value={noteValue}
        onChangeText={setNote}
        onBlur={() => void saveNote()}
        placeholder="Add a note"
      />

      <Field label="When">
        <Text style={text.body}>{new Date(transaction.occurredAt).toLocaleString()}</Text>
      </Field>

      <Field label="Source">
        <Text style={text.body}>{transaction.source}</Text>
      </Field>

      <Field label="Revision">
        <Text style={text.muted}>
          {transaction.rev} · last edited {new Date(transaction.updatedAt).toLocaleString()}
        </Text>
      </Field>

      <DangerButton label="Delete" onPress={remove} />
    </ScrollView>
  );
}

/**
 * What was bought, as it was confirmed.
 *
 * Read-only here on purpose: the breakdown was checked against the photo on the
 * confirm screen, and a number that has been counted in a total is not a field
 * to retype in passing. What this does show is whether it still adds up, since
 * the transaction amount can be edited afterwards and the rows cannot follow it
 * on their own.
 */
function Breakdown({
  items,
  currency,
  total,
}: {
  items: readonly LineItem[];
  currency: Currency;
  total: MinorUnits;
}): ReactNode {
  const itemised = sumAmounts(items.map((item) => item.totalMinor));

  return (
    <Card>
      <Text style={text.faint}>What was bought</Text>

      {items.map((item) => (
        <View key={item.id} style={styles.breakdownRow}>
          <Text style={text.body} numberOfLines={1}>
            {item.quantity === null ? '' : `${String(item.quantity)} × `}
            {item.name}
            {item.kind === 'item' ? '' : ` · ${item.kind}`}
          </Text>
          <Text style={[text.body, styles.figure]}>
            {formatAmount(item.totalMinor, currency)}
          </Text>
        </View>
      ))}

      {itemised !== total && (
        <Text style={styles.mismatch}>
          These rows come to {formatAmount(itemised, currency)}, not the{' '}
          {formatAmount(total, currency)} charged.
        </Text>
      )}
    </Card>
  );
}

function Message({ text: message }: { text: string }): ReactNode {
  return (
    <View style={styles.centered}>
      <Text style={text.muted}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  photo: {
    width: '100%',
    height: 200,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  photoExpanded: { height: 520 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  figure: { fontVariant: ['tabular-nums'] },
  mismatch: { color: colors.pending, fontSize: 12, marginTop: spacing.xs },
  pendingCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.pending,
  },
  pendingTitle: { color: colors.pending, fontSize: 16, fontWeight: '600' },
});
