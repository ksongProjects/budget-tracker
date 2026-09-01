import { MoneyError, formatAmount, parseAmount } from '@budget/schema';
import type { Currency, MinorUnits } from '@budget/schema';
import { tableTotals } from '@budget/extract';
import type { ReceiptRow, ReceiptRowKind, ReceiptTable, TableTotals, ValueSource } from '@budget/extract';
import type { DraftLineItem } from '@budget/db';

/**
 * The receipt table while a user is editing it.
 *
 * Amounts are held as the text that was typed, not as numbers. Half of "12.5"
 * is not a number and neither is an empty field, and a model that reparses on
 * every keystroke either rejects what the user is in the middle of typing or
 * silently rounds it. The conversion happens once, on save.
 *
 * Pure so the arithmetic is testable without a device — the totals a user reads
 * before saving are the ones this file computes.
 */

export interface EditableRow {
  readonly key: string;
  readonly label: string;
  /** As typed. Empty means this row has no value yet. */
  readonly amount: string;
  readonly quantity: number | null;
  readonly kind: ReceiptRowKind;
  readonly source: ValueSource;
  readonly confidence: number;
}

/** Kinds a user can cycle a row through, in the order the control steps. */
export const ROW_KINDS: readonly ReceiptRowKind[] = [
  'item',
  'tax',
  'tip',
  'fee',
  'discount',
  'subtotal',
  'total',
];

export function toEditable(table: ReceiptTable, currency: Currency): EditableRow[] {
  return table.rows.map((row) => ({
    key: row.id,
    label: row.label,
    amount: row.amount === null ? '' : formatAmount(row.amount, currency),
    quantity: row.quantity,
    kind: row.kind,
    source: row.source,
    confidence: row.confidence,
  }));
}

/** A row the user added by hand: no evidence, and their own number. */
export function blankRow(key: string): EditableRow {
  return {
    key,
    label: '',
    amount: '',
    quantity: null,
    kind: 'item',
    source: 'user',
    confidence: 1,
  };
}

/**
 * What a typed amount is worth, or null while it is not yet a number.
 *
 * Accepts the comma a decimal-comma receipt teaches its owner to type, and a
 * leading minus, which is how a discount row is entered.
 */
export function readAmount(typed: string, currency: Currency): MinorUnits | null {
  const cleaned = typed.trim().replace(/\s/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '-') return null;

  try {
    return parseAmount(cleaned, currency);
  } catch (cause) {
    if (cause instanceof MoneyError) return null;
    throw cause;
  }
}

/** The edited rows back in the shape the pure extraction code reasons about. */
export function toRows(rows: readonly EditableRow[], currency: Currency): ReceiptRow[] {
  return rows.map((row) => ({
    id: row.key,
    label: row.label.trim(),
    amount: readAmount(row.amount, currency),
    quantity: row.quantity,
    kind: row.kind,
    confidence: row.confidence,
    source: row.source,
    evidence: '',
  }));
}

export function editableTotals(rows: readonly EditableRow[], currency: Currency): TableTotals {
  return tableTotals(toRows(rows, currency));
}

/**
 * Which of these rows belong in the ledger's breakdown.
 *
 * A subtotal and a total are not purchases — they restate the rows around them,
 * and storing them would double every report that sums a breakdown. The total
 * lives on the transaction, where the user confirmed it.
 */
const STORED_KINDS: Partial<Record<ReceiptRowKind, DraftLineItem['kind']>> = {
  item: 'item',
  tax: 'tax',
  tip: 'tip',
  fee: 'fee',
  discount: 'discount',
};

export function toDrafts(rows: readonly EditableRow[], currency: Currency): DraftLineItem[] {
  const drafts: DraftLineItem[] = [];

  for (const row of rows) {
    const kind = STORED_KINDS[row.kind];
    const amount = readAmount(row.amount, currency);
    const name = row.label.trim();

    // A row with no number is a question the user did not answer. It is not
    // written: a breakdown containing a nameless zero is worse than a shorter
    // one, because the zero looks like a fact.
    if (kind === undefined || amount === null || name === '') continue;

    drafts.push({
      kind,
      name,
      quantity: row.quantity,
      unitPriceMinor: null,
      totalMinor: amount,
    });
  }

  return drafts;
}

/** Rows the user still has to answer, for the count shown beside Save. */
export function unanswered(rows: readonly EditableRow[], currency: Currency): number {
  return rows.filter(
    (row) => row.label.trim() !== '' && readAmount(row.amount, currency) === null,
  ).length;
}
