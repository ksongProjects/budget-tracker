import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatAmount } from '@budget/schema';
import type { TransactionId } from '@budget/schema';
import { useLedger, useQuery } from '../../src/db/provider';
import { colors, radius, spacing, text } from '../../src/ui/theme';

/** Detail, edit, confirm, delete. Delete is soft — the row survives for Merge. */
export default function TransactionScreen(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>();
  const ledger = useLedger();
  const router = useRouter();

  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: transaction, loading } = useQuery(
    (l) => l.transactions.get(id as TransactionId),
    [id],
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
      <View style={styles.amountBlock}>
        <Text style={styles.amountText}>
          {formatAmount(transaction.amountMinor, transaction.currency)}
        </Text>
        <Text style={text.faint}>{transaction.currency}</Text>
      </View>

      {pending && (
        <View style={styles.pendingCard}>
          <Text style={styles.pendingTitle}>Not counted yet</Text>
          <Text style={text.muted}>
            This amount stays out of your totals until you confirm it.
          </Text>
          <Pressable style={styles.primaryButton} onPress={() => void confirm()} disabled={busy}>
            <Text style={styles.primaryButtonText}>Confirm</Text>
          </Pressable>
        </View>
      )}

      <Field label="Note">
        <TextInput
          value={noteValue}
          onChangeText={setNote}
          onBlur={() => void saveNote()}
          placeholder="Add a note"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
        />
      </Field>

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

      <Pressable style={styles.deleteButton} onPress={remove}>
        <Text style={styles.deleteButtonText}>Delete</Text>
      </Pressable>
    </ScrollView>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <View style={styles.field}>
      <Text style={text.faint}>{label}</Text>
      {children}
    </View>
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
  amountBlock: { alignItems: 'center', paddingVertical: spacing.lg },
  amountText: {
    color: colors.text,
    fontSize: 48,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  pendingCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.pending,
  },
  pendingTitle: { color: colors.pending, fontSize: 16, fontWeight: '600' },
  field: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  input: { color: colors.text, fontSize: 16, padding: 0 },
  primaryButton: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  primaryButtonText: { color: colors.accentText, fontWeight: '600' },
  deleteButton: {
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.danger,
  },
  deleteButtonText: { color: colors.danger, fontWeight: '600' },
});
