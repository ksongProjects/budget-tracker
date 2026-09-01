import { formatAmount, sumAmounts } from '@budget/schema';
import type { Currency, MinorUnits } from '@budget/schema';
import { amountPattern, amountsIn, mergeColumns } from './receipt.js';
import type { LineItem, StructuredCandidate } from './llm/types.js';
import type { Candidate, OcrLine, OcrResult } from './types.js';

/**
 * A receipt as the two-column thing it actually is: a label and a value, once
 * per printed row.
 *
 * The field-at-a-time rules (receipt.ts) answer "what is the total"; this
 * answers "what does this receipt say", which is a different question and the
 * one the confirm screen needs. Every row survives the trip — including the
 * ones whose value OCR could not read — because a row with a missing number is
 * the single most useful thing to hand a model or a user: it says exactly where
 * to look.
 *
 * Nothing here infers a number. A missing amount stays null until a model
 * proposes one or the user types one, and the row records which of those it
 * was.
 */

export type ReceiptRowKind = 'item' | 'tax' | 'tip' | 'fee' | 'discount' | 'subtotal' | 'total';

/** Where a value came from. A wrong number is worth tracing to its author. */
export type ValueSource = 'ocr' | 'model' | 'user';

export interface ReceiptRow {
  /** Stable for the life of one table, so a list can key on it while editing. */
  readonly id: string;
  readonly label: string;
  /** Null when the receipt printed a label we could not pair with a number. */
  readonly amount: MinorUnits | null;
  readonly quantity: number | null;
  readonly kind: ReceiptRowKind;
  readonly confidence: number;
  readonly source: ValueSource;
  /** The OCR text this row was read from. Empty for a row the user added. */
  readonly evidence: string;
}

export interface ReceiptTable {
  /** Lines above the first priced row: merchant, address, phone. */
  readonly header: readonly string[];
  readonly rows: readonly ReceiptRow[];
  readonly engine: string;
}

const KINDS: readonly { readonly pattern: RegExp; readonly kind: ReceiptRowKind }[] = [
  { pattern: /\b(sub\s*total|subtotal|zwischensumme)\b/i, kind: 'subtotal' },
  { pattern: /\b(discount|savings|coupon|promo|rabatt)\b/i, kind: 'discount' },
  { pattern: /\b(sales\s*tax|tax|vat|gst|hst|mwst|tva)\b/i, kind: 'tax' },
  { pattern: /\b(tip|gratuity)\b/i, kind: 'tip' },
  {
    pattern: /\b(service\s*charge|delivery|shipping|fee|surcharge|levy|deposit)\b/i,
    kind: 'fee',
  },
  {
    pattern:
      /\b(grand\s*total|amount\s*due|balance\s*due|total\s*due|total|summe|gesamt|totale|importe|montant|totaal)\b/i,
    kind: 'total',
  },
];

/**
 * Lines inside the priced block that are not rows of the table: the till's own
 * bookkeeping. Dropping them keeps the editable table the length of the
 * shopping, which is what the user is checking.
 */
const NOT_A_ROW =
  /^\s*(?:[-=*_.]{2,}|thank\s*you|customer\s*copy|merchant\s*copy|please\s*retain|visa|mastercard|amex|debit|credit|approved|auth(?:orisation|orization)?(?:\s*code)?|terminal|batch|ref(?:erence)?|trace|aid|tvr|order\s*#?\d*|table\s*\d*|server\b.*|cashier\b.*|receipt\s*#?\d*|invoice\s*#?\d*|tel(?:ephone)?[:\s].*|\d[\d\s\-()+.]*|.{0,1})\s*$/i;

/**
 * A quantity as receipts print one: `2 x Latte`, `2x Latte`, `2 @ 3.50`, and
 * the bare `1 Oat Latte` that tills print more often than any of them.
 *
 * The bare form is capped at two digits and must be followed by a letter, so
 * `500 ml Water` keeps its size and `12 Eggs` loses its count. Three digits of
 * anything is a weight or a volume far more often than a basket.
 */
const LEADING_QUANTITY = /^(\d{1,3})\s*(?:x|×|@)\s+|^(\d{1,2})\s+(?=[A-Za-z])/i;

/**
 * Separators left behind once the amount is cut off the end of a line.
 *
 * Two patterns, not one: an `x` is a separator only when a space precedes it —
 * `2 x 3.50` leaves `2 x`, but `TAX` ends in one and a rule that ate it read
 * every tax line as shopping.
 */
const TRAILING_SEPARATOR = /\s+[x×@]$/i;
const TRAILING_PUNCTUATION = /[\s.:•·*-]+$/;

export function buildReceiptTable(ocr: OcrResult): ReceiptTable {
  const lines = mergeColumns(ocr.lines).filter((line) => line.text.trim() !== '');

  const priced = lines.map((line) => amountsIn(line.text).length > 0);
  const first = priced.indexOf(true);
  const last = priced.lastIndexOf(true);

  if (first === -1) {
    // No prices anywhere: everything read is header, and there is no table to
    // show. Better than inventing rows out of an address.
    return { header: lines.map((line) => line.text.trim()), rows: [], engine: ocr.engine };
  }

  const header = lines.slice(0, first).map((line) => line.text.trim());
  const rows: ReceiptRow[] = [];

  for (const [offset, line] of lines.slice(first, last + 1).entries()) {
    const row = toRow(line, `r${String(offset)}`);
    if (row) rows.push(row);
  }

  return { header, rows, engine: ocr.engine };
}

function toRow(line: OcrLine, id: string): ReceiptRow | undefined {
  const text = line.text.trim();
  const amounts = amountsIn(text);
  // The last amount on a line is its value: `2 @ 3.50   7.00` charges seven.
  const amount = amounts.at(-1) ?? null;

  let label = text.replace(amountPattern(), ' ').replace(/\s{2,}/g, ' ').trim();
  label = label
    .replace(TRAILING_PUNCTUATION, '')
    .replace(TRAILING_SEPARATOR, '')
    .replace(TRAILING_PUNCTUATION, '')
    .trim();

  if (amount === null && NOT_A_ROW.test(label)) return undefined;

  let quantity: number | null = null;
  const counted = LEADING_QUANTITY.exec(label);
  const count = counted?.[1] ?? counted?.[2];
  if (counted && count !== undefined) {
    quantity = Number(count);
    label = label.slice(counted[0].length).trim();
  }

  if (label === '' && amount === null) return undefined;

  return {
    id,
    label,
    amount,
    quantity,
    kind: classify(label),
    // A row with both halves is as good as Tier 2 gets. One half alone is a
    // question, and the confirm screen shows it as one.
    confidence: amount !== null && label !== '' ? 0.8 : 0.4,
    source: 'ocr',
    evidence: text,
  };
}

export function classify(label: string): ReceiptRowKind {
  for (const { pattern, kind } of KINDS) {
    if (pattern.test(label)) return kind;
  }
  return 'item';
}

export interface TableTotals {
  /** Items, fees and discounts — the shopping, before tax and tip. */
  readonly itemsMinor: MinorUnits;
  readonly taxMinor: MinorUnits;
  readonly tipMinor: MinorUnits;
  /** Items plus tax plus tip: what the rows say the bill comes to. */
  readonly itemisedTotal: MinorUnits;
  /** The total the receipt prints, when it prints one. */
  readonly statedTotal: MinorUnits | null;
  /** Stated minus itemised. Positive means the rows fall short. */
  readonly differenceMinor: number;
  readonly balanced: boolean;
  /** Rows still waiting for a number. */
  readonly missing: number;
}

/**
 * What the rows add up to, and whether that matches what the receipt claims.
 *
 * A subtotal row is deliberately not counted: it restates the items, and adding
 * it would double every receipt that prints one.
 */
export function tableTotals(rows: readonly ReceiptRow[]): TableTotals {
  const of = (kind: ReceiptRowKind): MinorUnits =>
    sumAmounts(
      rows
        .filter((row) => row.kind === kind && row.amount !== null)
        .map((row) => row.amount as MinorUnits),
    );

  const items = sumAmounts([of('item'), of('fee'), of('discount')]);
  const tax = of('tax');
  const tip = of('tip');
  const itemisedTotal = sumAmounts([items, tax, tip]);

  const stated = rows.filter((row) => row.kind === 'total' && row.amount !== null).at(-1);
  const statedTotal = stated?.amount ?? null;

  const difference = statedTotal === null ? 0 : statedTotal - itemisedTotal;

  return {
    itemsMinor: items,
    taxMinor: tax,
    tipMinor: tip,
    itemisedTotal,
    statedTotal,
    differenceMinor: difference,
    // No tolerance on purpose: a gap the user cannot see is a gap nobody fixes.
    balanced: statedTotal !== null && difference === 0,
    missing: rows.filter((row) => row.amount === null).length,
  };
}

/**
 * The table as text for a model to read.
 *
 * A missing value is written `?` rather than omitted, which turns a vague
 * request ("read this receipt") into a specific one ("these three rows have no
 * number"). Row ids go on the wire so an answer can be matched back to a row
 * instead of to a string that OCR may have mangled.
 */
export function renderTable(table: ReceiptTable, currency: Currency): string {
  const head = table.header.length > 0 ? `${table.header.join('\n')}\n---\n` : '';

  const body = table.rows
    .map((row) => {
      const value = row.amount === null ? '?' : formatAmount(row.amount, currency);
      const count = row.quantity === null ? '' : ` (x${String(row.quantity)})`;
      return `${row.id}\t${row.label === '' ? '?' : row.label}${count}\t${value}`;
    })
    .join('\n');

  return `${head}${body}`;
}

/**
 * Fold a model's reading back into the table.
 *
 * Filling a gap is allowed; overwriting a number OCR actually read is not. The
 * receipt is the evidence and the model is a guess about the parts of it that
 * did not survive OCR — a model that "corrects" a printed 4.50 to 4.60 has
 * invented money, and this is the line that stops it.
 */
export function fillTable(table: ReceiptTable, structured: StructuredCandidate): ReceiptTable {
  const proposals = [...(structured.lineItems ?? [])];
  const taken = new Set<number>();

  const rows = table.rows.map((row) => {
    if (row.amount !== null && row.label !== '') return row;

    const index = proposals.findIndex((item, at) => !taken.has(at) && matches(row, item.value));
    if (index === -1) return row;

    taken.add(index);
    const proposal = proposals[index] as Candidate<LineItem>;

    return {
      ...row,
      label: row.label === '' ? proposal.value.description : row.label,
      amount: row.amount ?? proposal.value.amount,
      quantity: row.quantity ?? proposal.value.quantity ?? null,
      kind: row.label === '' ? classify(proposal.value.description) : row.kind,
      confidence: proposal.confidence,
      source: 'model' as const,
    };
  });

  // Items the model found that no row claimed. Appended rather than dropped:
  // OCR loses whole lines on a creased receipt, and an extra row the user can
  // delete is cheaper than a missing one they have to notice.
  const extra = proposals
    .map((item, at) => ({ item, at }))
    .filter(({ at }) => !taken.has(at))
    .map(({ item }, offset) => ({
      id: `m${String(offset)}`,
      label: item.value.description,
      amount: item.value.amount,
      quantity: item.value.quantity ?? null,
      kind: classify(item.value.description),
      confidence: item.confidence,
      source: 'model' as const,
      evidence: '',
    }));

  return { ...table, rows: [...rows, ...extra] };
}

/**
 * Whether a model's line item is the row we are looking at.
 *
 * Loose on purpose — OCR gives `ESPRESSO DOP` for `Espresso Doppio` — but
 * anchored on a word rather than a substring, so `Tea` does not claim `Steak`.
 */
function matches(row: ReceiptRow, item: LineItem): boolean {
  if (row.label === '') return row.amount !== null && row.amount === item.amount;

  const left = words(row.label);
  const right = words(item.description);
  if (left.length === 0 || right.length === 0) return false;

  return left.some((word) => right.some((other) => shareAPrefix(word, other)));
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length >= 3);
}

function shareAPrefix(a: string, b: string): boolean {
  const length = Math.min(a.length, b.length);
  return length >= 3 && a.slice(0, length) === b.slice(0, length);
}
