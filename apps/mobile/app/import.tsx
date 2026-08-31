import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { formatAmount } from '@budget/schema';
import type { Currency } from '@budget/schema';
import { commitImport, previewImport } from '@budget/db';
import type { ImportPreview } from '@budget/db';
import { guessMapping, isComplete, parseCsv } from '@budget/extract';
import type { ColumnMapping, CsvTable, DateOrder } from '@budget/extract';
import { useLedger } from '../src/db/provider';
import { useDefaultCurrency } from '../src/profile/context';
import { CurrencyPicker } from '../src/ui/currency';
import { FileText, decorative } from '../src/ui/icons';
import { MIN_TOUCH_TARGET, colors, radius, spacing, text } from '../src/ui/theme';

/**
 * Importing a bank statement on the phone.
 *
 * The same pipeline the web app runs — one parser, one idea of what counts as a
 * duplicate, one commit — behind a screen shaped for a thumb. Nothing is
 * written until a preview has been read: an import that acted on the file
 * immediately would turn "I picked the wrong date order" into an undo problem
 * rather than a question.
 *
 * CSV only, here. A PDF statement is read through pdf.js, which needs a browser
 * engine the phone does not have, so the screen says so and points at the web
 * app rather than failing halfway through a file someone waited for.
 */
export default function ImportScreen(): ReactNode {
  const ledger = useLedger();
  const router = useRouter();
  const defaultCurrency = useDefaultCurrency();

  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [table, setTable] = useState<CsvTable | undefined>(undefined);
  const [mapping, setMapping] = useState<Partial<ColumnMapping>>({});
  const [dateOrder, setDateOrder] = useState<DateOrder>('mdy');
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [preview, setPreview] = useState<ImportPreview | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | undefined>(undefined);

  const choose = async (): Promise<void> => {
    setError(null);
    setPreview(undefined);
    setDone(undefined);

    try {
      const picked = await DocumentPicker.getDocumentAsync({
        // Some file providers hand back a CSV as text/plain or as an Excel
        // type; accepting a narrow list is how a file the user can see becomes
        // a file they cannot pick.
        type: ['text/csv', 'text/comma-separated-values', 'text/plain', '*/*'],
        copyToCacheDirectory: true,
      });

      if (picked.canceled) return;

      const asset = picked.assets[0];
      if (asset === undefined) return;

      if (asset.name.toLowerCase().endsWith('.pdf')) {
        setError(
          'PDF statements are read in the web app — the reader needs a browser engine this phone does not have. A CSV from the same bank works here.',
        );
        return;
      }

      const text = await FileSystem.readAsStringAsync(asset.uri);
      const parsed = parseCsv(text);

      if (parsed.rows.length === 0) {
        setError('That file has a header and no rows.');
        return;
      }

      const guess = guessMapping(parsed.header);

      setFileName(asset.name);
      setTable(parsed);
      setMapping(guess);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const look = async (): Promise<void> => {
    if (table === undefined || !isComplete(mapping)) return;

    setBusy(true);
    setError(null);

    try {
      setPreview(await previewImport(ledger, table, { mapping, dateOrder, currency }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const commit = async (): Promise<void> => {
    if (preview === undefined) return;

    setBusy(true);
    setError(null);

    try {
      const result = await commitImport(ledger, preview.fresh);
      setDone(result.imported);
      setPreview(undefined);
      setTable(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={text.body}>
        A CSV from your bank. Nothing is added until you have seen what it would add, and imported
        rows arrive unconfirmed — they count toward nothing until you accept them.
      </Text>

      <Pressable accessibilityRole="button" style={styles.primary} onPress={() => void choose()}>
        <FileText {...decorative({ color: colors.accentText })} />
        <Text style={styles.primaryText}>{table === undefined ? 'Choose a file' : 'Choose another file'}</Text>
      </Pressable>

      {fileName !== undefined && table !== undefined && (
        <View style={styles.card}>
          <Text style={text.heading}>{fileName}</Text>
          <Text style={text.muted}>
            {table.rows.length} rows, {table.header.length} columns
          </Text>

          <Text style={text.muted}>Columns</Text>
          {(['date', 'description', 'amount'] as const).map((field) => (
            <ColumnChoice
              key={field}
              field={field}
              header={table.header}
              selected={mapping[field]}
              onSelect={(index) => {
                setMapping((current) => ({ ...current, [field]: index }));
                setPreview(undefined);
              }}
            />
          ))}

          <Text style={text.muted}>Dates read as</Text>
          <View style={styles.row}>
            {(
              [
                ['mdy', 'Month first'],
                ['dmy', 'Day first'],
                ['ymd', 'Year first'],
              ] as const
            ).map(([order, label]) => (
              <Chip
                key={order}
                label={label}
                selected={dateOrder === order}
                onPress={() => {
                  setDateOrder(order);
                  setPreview(undefined);
                }}
              />
            ))}
          </View>

          {/* The file's own currency, which is not always the one this phone
              records in — a statement from a trip abroad is the normal case.
              Starts at the profile default and stays put unless changed. */}
          <CurrencyPicker
            value={currency}
            onChange={(next) => {
              setCurrency(next);
              setPreview(undefined);
            }}
            label="Amounts in this file are"
          />
          <Text style={text.faint}>
            Your default is {defaultCurrency}. Change it here for a statement in another currency;
            it does not change your default.
          </Text>

          <Pressable
            accessibilityRole="button"
            style={[styles.secondary, (!isComplete(mapping) || busy) && styles.disabled]}
            disabled={!isComplete(mapping) || busy}
            onPress={() => void look()}
          >
            <Text style={styles.secondaryText}>{busy ? 'Reading…' : 'Preview the import'}</Text>
          </Pressable>
        </View>
      )}

      {preview !== undefined && (
        <View style={styles.card}>
          <Text style={text.heading}>
            {preview.fresh.length} to import, {preview.duplicates.length} already in your ledger
          </Text>
          {preview.problems.length > 0 && (
            <Text style={styles.warn}>
              {preview.problems.length} rows could not be read and will be skipped.
            </Text>
          )}

          {preview.fresh.slice(0, 5).map((row) => (
            <View key={`${String(row.line)}-${row.description}`} style={styles.previewRow}>
              <Text style={text.body} numberOfLines={1}>
                {row.description}
              </Text>
              <Text style={text.amount}>{formatAmount(row.amountMinor, row.currency)}</Text>
            </View>
          ))}
          {preview.fresh.length > 5 && (
            <Text style={text.faint}>and {preview.fresh.length - 5} more</Text>
          )}

          <Pressable
            accessibilityRole="button"
            style={[styles.primary, (preview.fresh.length === 0 || busy) && styles.disabled]}
            disabled={preview.fresh.length === 0 || busy}
            onPress={() => void commit()}
          >
            <Text style={styles.primaryText}>
              {busy ? 'Importing…' : `Import ${String(preview.fresh.length)} rows`}
            </Text>
          </Pressable>
        </View>
      )}

      {done !== undefined && (
        <View style={styles.card}>
          <Text style={text.body}>
            {done} rows imported, waiting to be confirmed. They count toward nothing until you
            accept them.
          </Text>
          <Pressable
            accessibilityRole="button"
            style={styles.secondary}
            onPress={() => {
              router.back();
            }}
          >
            <Text style={styles.secondaryText}>Back to transactions</Text>
          </Pressable>
        </View>
      )}

      {error !== null && (
        <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error}>
          {error}
        </Text>
      )}
    </ScrollView>
  );
}

function ColumnChoice({
  field,
  header,
  selected,
  onSelect,
}: {
  field: 'date' | 'description' | 'amount';
  header: readonly string[];
  selected: number | undefined;
  onSelect: (index: number) => void;
}): ReactNode {
  return (
    <View style={styles.choice}>
      <Text style={text.faint}>{field}</Text>
      <View style={styles.row}>
        {header.map((name, index) => (
          <Chip
            key={`${name}-${String(index)}`}
            label={name === '' ? `Column ${String(index + 1)}` : name}
            selected={selected === index}
            onPress={() => {
              onSelect(index);
            }}
          />
        ))}
      </View>
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
      <Text style={selected ? styles.chipTextSelected : styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  choice: { gap: spacing.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxWidth: 180,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 13 },
  chipTextSelected: { color: colors.accentText, fontSize: 13, fontWeight: '700' },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  primary: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
  },
  primaryText: { color: colors.accentText, fontWeight: '700', fontSize: 16 },
  secondary: {
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryText: { color: colors.text, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  warn: { color: colors.pending, fontSize: 12 },
  error: { color: colors.danger },
});
