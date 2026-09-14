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
 * The receipt in one line, for a screen that keeps the rows folded away.
 *
 * "Review items" tells a user nothing, so they open the fold every time or
 * never, and a row read wrong is found either way too late. A count, the rows
 * still waiting for a price, and whether the rest reach the total they are
 * about to save are enough to judge it without opening anything.
 *
 * The gap is named, never closed: a discount line, a row OCR missed and a
 * misread digit all look the same to arithmetic.
 */
export function summariseRows(
  rows: readonly EditableRow[],
  currency: Currency,
  total: MinorUnits | null,
): string {
  if (rows.length === 0) return 'Nothing read from the photo — add rows by hand';

  const totals = editableTotals(rows, currency);
  const parts = [`${String(rows.length)} ${rows.length === 1 ? 'row' : 'rows'} read`];

  if (totals.missing > 0) {
    parts.push(`${String(totals.missing)} without a price`);
  }

  // Both facts when both are true. Saying only "4 without a price" once hid a
  // breakdown 38.89 out on a 49.55 bill: the unpriced rows were the smaller
  // problem, and the line that should have stopped the save never showed.
  if (total !== null && totals.itemisedTotal !== total) {
    const gap = Math.abs(total - totals.itemisedTotal) as MinorUnits;
    parts.push(`${formatAmount(gap, currency)} ${currency} off the total`);
  } else if (total !== null && totals.missing === 0) {
    parts.push('they add up');
  }

  return parts.join(' · ');
}

/**
 * Whether the rows should be in front of the user before they save.
 *
 * The confirm screen keeps a receipt that adds up folded away, because a clean
 * receipt is detail. One that does not is not detail: a row is unpriced, or the
 * priced rows miss the total, and either way the breakdown about to be stored
 * disagrees with the number the user is confirming.
 *
 * No total typed yet claims nothing — there is nothing to disagree with.
 */
export function rowsNeedAttention(
  rows: readonly EditableRow[],
  currency: Currency,
  total: MinorUnits | null,
): boolean {
  if (rows.length === 0) return false;

  const totals = editableTotals(rows, currency);
  if (totals.missing > 0) return true;

  return total !== null && totals.itemisedTotal !== total;
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
