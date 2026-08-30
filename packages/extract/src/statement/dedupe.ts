import type { MinorUnits } from '@budget/schema';
import type { StatementRow } from './rows.js';

/**
 * Not importing the same transaction twice.
 *
 * Statements overlap. People re-download a month, export a wider range, or
 * import the same file twice because they cannot remember whether they did.
 * Every one of those must be safe, and "safe" here means the ledger is
 * unchanged — a duplicated rent payment is a wrong total that looks entirely
 * plausible.
 *
 * A statement row carries no stable identity: banks do not export one, and the
 * same payment can appear with a different posting date on a later download.
 * So matching is on what the row *is* — amount, day, and who it was with —
 * rather than on an id that does not exist.
 */

export interface ExistingRow {
  readonly id: string;
  readonly occurredAt: number;
  readonly amountMinor: MinorUnits;
  /** Whatever the ledger knows the counterparty as: merchant name, or the note. */
  readonly description: string | null;
}

export interface DedupeOptions {
  /**
   * How far apart two otherwise identical rows may sit and still be the same
   * payment. Banks move a posting date by a day or two between downloads, and a
   * weekend shifts it further.
   */
  readonly dayWindow?: number;
  /** How alike two descriptions must be, from 0 to 1. */
  readonly similarity?: number;
}

export interface DedupeResult {
  readonly fresh: readonly StatementRow[];
  readonly duplicates: readonly { row: StatementRow; existingId: string }[];
}

const DAY = 86_400_000;

export const DEFAULT_DEDUPE: Required<DedupeOptions> = {
  dayWindow: 3,
  similarity: 0.6,
};

export function findDuplicates(
  incoming: readonly StatementRow[],
  existing: readonly ExistingRow[],
  options: DedupeOptions = {},
): DedupeResult {
  const dayWindow = options.dayWindow ?? DEFAULT_DEDUPE.dayWindow;
  const similarity = options.similarity ?? DEFAULT_DEDUPE.similarity;

  const fresh: StatementRow[] = [];
  const duplicates: { row: StatementRow; existingId: string }[] = [];

  // A ledger row may only account for one incoming row. Two identical coffees
  // on the same day are two coffees, and matching both against one existing row
  // would drop a real transaction.
  const claimed = new Set<string>();

  // Grouped by amount first: it is the one field that never drifts, so this
  // turns a scan of the whole ledger into a scan of the few rows that could
  // possibly match.
  const byAmount = new Map<number, ExistingRow[]>();
  for (const row of existing) {
    const bucket = byAmount.get(row.amountMinor);
    if (bucket) bucket.push(row);
    else byAmount.set(row.amountMinor, [row]);
  }

  for (const row of incoming) {
    const candidates = byAmount.get(row.amountMinor) ?? [];

    const match = candidates
      .filter((candidate) => !claimed.has(candidate.id))
      .filter((candidate) => Math.abs(candidate.occurredAt - row.occurredAt) <= dayWindow * DAY)
      .map((candidate) => ({
        candidate,
        score: similarityOf(row.description, candidate.description ?? ''),
      }))
      .filter((scored) => scored.score >= similarity)
      .sort((a, b) => b.score - a.score)[0];

    if (match === undefined) {
      fresh.push(row);
      continue;
    }

    claimed.add(match.candidate.id);
    duplicates.push({ row, existingId: match.candidate.id });
  }

  return { fresh, duplicates };
}

/**
 * How alike two descriptions are, on the parts a bank keeps stable.
 *
 * Statement descriptions are noisy in predictable ways: a card number, a store
 * number, a reference, a date repeated inside the text. Comparing the words
 * that survive that noise beats comparing the strings, and beats an edit
 * distance that a long reference number would dominate.
 */
export function similarityOf(left: string, right: string): number {
  const a = words(left);
  const b = words(right);

  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const word of a) {
    if (b.has(word)) shared += 1;
  }

  // Against the smaller set: "STARBUCKS" and "STARBUCKS STORE 1234 SEATTLE" are
  // the same merchant, and dividing by the union would score them apart.
  return shared / Math.min(a.size, b.size);
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      // Digits are dropped: store numbers, card fragments and references are
      // exactly the parts that differ between two records of one payment.
      .replaceAll(/[\d]+/g, ' ')
      .split(/[^a-z]+/)
      .filter((word) => word.length > 2),
  );
}
