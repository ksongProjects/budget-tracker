import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { CurrencySchema, formatAmount } from '@budget/schema';
import type { AccountId, Currency } from '@budget/schema';
import { commitImport, previewImport } from '@budget/db';
import type { ImportPreview, ImportSource } from '@budget/db';
import {
  NO_TEXT_FOUND,
  NO_TEXT_LAYER,
  guessMapping,
  isComplete,
  parseCsv,
  readStatementDocument,
} from '@budget/extract';
import type { ColumnMapping, CsvTable, DateOrder } from '@budget/extract';
import { useLedger, useQuery } from '../src/db/provider';
import { useDefaultCurrency } from '../src/profile/context';
import { storePhoto } from '../src/capture/documents';
import { usePdfReader } from '../src/statement/pdf-reader';
import { kindOfFile } from '../src/statement/file-kind';
import { CurrencyPicker } from '../src/ui/currency';
import {
  Card,
  Chip,
  ChipRow,
  Field,
  FormError,
  FormWarning,
  PrimaryButton,
  SecondaryButton,
  TextField,
} from '../src/ui/form';
import { FileText, decorative } from '../src/ui/icons';
import { colors, spacing, text } from '../src/ui/theme';

/**
 * Upload a file: a statement or a receipt, whichever it turns out to be.
 *
 * - A **CSV** is a statement, read directly (Tier 0).
 * - A **PDF** is a statement too, read from its text layer by pdf.js in a
 *   hidden WebView (Tier 1) — the same reader, rule sets and layout code the
 *   web app uses. A scanned page, with no text layer, is drawn and read by
 *   on-device OCR instead, then goes through the same layout.
 * - An **image** is a receipt someone already has a picture of. It is stored
 *   exactly like a photo from the camera and goes to the same confirm screen,
 *   so a screenshot of an e-receipt and a photo of a paper one end up the same.
 *
 * Statements share one pipeline from here on: nothing is written until a
 * preview has been read, because an import that acted on the file immediately
 * would turn "I picked the wrong date order" into an undo problem rather than a
 * question. Each row becomes its own record, on the day the bank says.
 */
export default function UploadScreen(): ReactNode {
  const ledger = useLedger();
  const router = useRouter();
  const defaultCurrency = useDefaultCurrency();
  const pdf = usePdfReader();

  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [table, setTable] = useState<CsvTable | undefined>(undefined);
  const [source, setSource] = useState<ImportSource>({});
  const [recognised, setRecognised] = useState<string | undefined>(undefined);
  const [mapping, setMapping] = useState<Partial<ColumnMapping>>({});
  const [dateOrder, setDateOrder] = useState<DateOrder>('mdy');
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [debitsArePositive, setDebitsArePositive] = useState(false);
  const [accountId, setAccountId] = useState<AccountId | null>(null);
  const [newAccount, setNewAccount] = useState('');
  const [preview, setPreview] = useState<ImportPreview | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | undefined>(undefined);

  const { data: accounts } = useQuery((l) => l.accounts.list(), [], done ?? 0);

  const reset = (): void => {
    setError(null);
    setPreview(undefined);
    setDone(undefined);
    setRecognised(undefined);
  };

  const choose = async (): Promise<void> => {
    reset();

    try {
      const picked = await DocumentPicker.getDocumentAsync({
        // Some file providers hand back a CSV as text/plain or as an Excel
        // type, and a photo as a generic binary; accepting a narrow list is how
        // a file the user can see becomes a file they cannot pick. What the
        // file is gets decided below, from its type and name.
        type: ['*/*'],
        copyToCacheDirectory: true,
      });

      if (picked.canceled) return;

      const asset = picked.assets[0];
      if (asset === undefined) return;

      const kind = kindOfFile(asset.name, asset.mimeType);
      const started = Date.now();

      if (kind === 'image') {
        setReading(true);
        // A receipt, then: stored like a camera photo, read on the confirm
        // screen, saved from there straight to the ledger.
        const stored = await storePhoto(ledger.driver, ledger.deviceId, asset.uri);
        router.replace(`/confirm/${stored.captureId}`);
        return;
      }

      if (kind === 'pdf') {
        setReading(true);
        const document = await pdf.read(asset.uri);
        const read = readStatementDocument(document);
        if (read === undefined) {
          // A scan that OCR found nothing in is a different problem from a
          // scan that could not be OCR'd at all (Expo Go has no ML Kit).
          setError((document.scannedPages ?? 0) > 0 ? NO_TEXT_FOUND : NO_TEXT_LAYER);
          return;
        }

        setFileName(asset.name);
        setTable(read.table);
        setMapping(read.mapping ?? guessMapping(read.table.header));
        if (read.dateOrder !== undefined) setDateOrder(read.dateOrder);
        const stated = CurrencySchema.safeParse(read.currency).data;
        if (stated !== undefined) setCurrency(stated);
        setDebitsArePositive(read.debitsArePositive ?? false);
        setRecognised(read.recognised);
        setSource({ tier: 1, engine: document.engine, durationMs: Date.now() - started });
        return;
      }

      if (kind === 'unknown') {
        setError(
          `${asset.name} is not a file this can read. Upload a CSV or PDF statement, or a photo or screenshot of a receipt.`,
        );
        return;
      }

      const parsed = parseCsv(await FileSystem.readAsStringAsync(asset.uri));
      if (parsed.rows.length === 0) {
        setError('That file has a header and no rows.');
        return;
      }

      setFileName(asset.name);
      setTable(parsed);
      setMapping(guessMapping(parsed.header));
      setDebitsArePositive(false);
      setSource({ tier: 0, engine: 'csv', durationMs: Date.now() - started });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReading(false);
    }
  };

  const look = async (): Promise<void> => {
    if (table === undefined || !isComplete(mapping)) return;

    setBusy(true);
    setError(null);

    try {
      setPreview(
        await previewImport(ledger, table, { mapping, dateOrder, currency, debitsArePositive }),
      );
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
      // An account typed here is created now, once, rather than as part of
      // previewing: a preview is a question and must not leave rows behind.
      const typed = newAccount.trim();
      const account =
        typed === '' ? accountId : (await ledger.accounts.create(typed, currency)).id;

      const result = await commitImport(ledger, preview.fresh, { ...source, accountId: account });
      setDone(result.imported);
      setPreview(undefined);
      setTable(undefined);
      setNewAccount('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {pdf.host}

      <Text style={text.body}>
        A statement from your bank — CSV or PDF — or a photo or screenshot of a receipt.
      </Text>
      <Text style={text.muted}>
        Statements: nothing is added until you have seen what it would add, and each row arrives
        unconfirmed — it counts toward nothing until you accept it. Receipts go to the same check
        as a photo from the camera.
      </Text>

      <PrimaryButton
        label={table === undefined ? 'Choose a file' : 'Choose another file'}
        busyLabel="Reading the file…"
        busy={reading}
        icon={<FileText {...decorative({ color: colors.accentText })} />}
        onPress={() => void choose()}
      />

      {fileName !== undefined && table !== undefined && (
        <Card>
          <Text style={text.heading}>{fileName}</Text>
          <Text style={text.muted}>
            {table.rows.length} rows, {table.header.length} columns
          </Text>
          {recognised !== undefined && (
            <Text style={text.faint}>Recognised as {recognised}. Check the columns anyway.</Text>
          )}

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
          <ColumnChoice
            field="posted date (optional)"
            header={table.header}
            selected={mapping.posted}
            optional
            onSelect={(index) => {
              setMapping((current) => {
                const { posted: _dropped, ...rest } = current;
                return index === undefined ? rest : { ...rest, posted: index };
              });
              setPreview(undefined);
            }}
          />

          <Text style={text.muted}>Dates read as</Text>
          <ChipRow>
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
          </ChipRow>

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

          <Field label="Which account is this? (optional)">
            <ChipRow>
              {(accounts ?? []).map((account) => (
                <Chip
                  key={account.id}
                  label={account.name}
                  selected={accountId === account.id && newAccount.trim() === ''}
                  onPress={() => {
                    setAccountId(accountId === account.id ? null : account.id);
                    setNewAccount('');
                  }}
                />
              ))}
            </ChipRow>
          </Field>
          <TextField
            label="Or a new account"
            value={newAccount}
            onChangeText={setNewAccount}
            placeholder="e.g. Checking, Visa"
          />

          <SecondaryButton
            label="Preview the import"
            busyLabel="Reading…"
            disabled={!isComplete(mapping)}
            busy={busy}
            onPress={() => void look()}
          />
        </Card>
      )}

      {preview !== undefined && (
        <Card>
          <Text style={text.heading}>
            {preview.fresh.length} to import, {preview.duplicates.length} already in your ledger
          </Text>
          {preview.problems.length > 0 && (
            <FormWarning
              message={`${String(preview.problems.length)} rows could not be read and will be skipped.`}
            />
          )}

          {preview.fresh.slice(0, 5).map((row) => (
            <View key={`${String(row.line)}-${row.description}`} style={styles.previewRow}>
              <Text style={[text.body, styles.previewName]} numberOfLines={1}>
                {row.description}
              </Text>
              <Text style={text.amount}>{formatAmount(row.amountMinor, row.currency)}</Text>
            </View>
          ))}
          {preview.fresh.length > 5 && (
            <Text style={text.faint}>and {preview.fresh.length - 5} more</Text>
          )}

          <PrimaryButton
            label={`Import ${String(preview.fresh.length)} rows`}
            busyLabel="Importing…"
            disabled={preview.fresh.length === 0}
            busy={busy}
            onPress={() => void commit()}
          />
        </Card>
      )}

      {done !== undefined && (
        <Card>
          <Text style={text.body}>
            {done} rows imported, waiting to be confirmed. They count toward nothing until you
            accept them.
          </Text>
          <SecondaryButton
            label="Back to transactions"
            onPress={() => {
              router.dismissAll();
              router.replace('/');
            }}
          />
        </Card>
      )}

      <FormError message={error} />
    </ScrollView>
  );
}

function ColumnChoice({
  field,
  header,
  selected,
  optional = false,
  onSelect,
}: {
  field: string;
  header: readonly string[];
  selected: number | undefined;
  optional?: boolean;
  onSelect: (index: number | undefined) => void;
}): ReactNode {
  return (
    <Field label={field}>
      <ChipRow>
        {optional && (
          <Chip
            label="None"
            selected={selected === undefined}
            onPress={() => {
              onSelect(undefined);
            }}
          />
        )}
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
      </ChipRow>
    </Field>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  previewName: { flexShrink: 1 },
});
