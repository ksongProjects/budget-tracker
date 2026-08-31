import type { ColumnMapping, CsvTable } from './csv.js';
import { tableOfDocument } from './layout.js';
import type { PdfDocument, TableOptions } from './layout.js';
import type { DateOrder } from './rows.js';

/**
 * Per-bank rule sets.
 *
 * A statement's layout is stable per institution and arbitrary across them, so
 * the knowledge is written down per bank rather than inferred every time. These
 * are **data, not code** — no functions, no regexes compiled from user input —
 * which is what lets a fixed rule ship as an over-the-air update rather than an
 * app-store round trip ([extraction.md](../../../../docs/extraction.md)).
 *
 * Every rule set is versioned and every imported row records which one produced
 * it. When a bank changes its layout, that record is the difference between
 * "these rows are wrong" and "these rows, from that version, are wrong".
 *
 * A rule set is never required. Nothing here is on the path of a statement it
 * has not seen: an unrecognised file falls back to guessing the columns and
 * asking the user, which is what every file did before rule sets existed.
 */

export interface StatementRuleSet {
  /** Stable across versions; recorded against every row it produces. */
  readonly id: string;
  /** Bumped whenever anything below changes, so a bad rule is identifiable. */
  readonly version: number;
  /** Shown to the user: "This looks like a First National statement." */
  readonly label: string;
  /**
   * How the file identifies itself. Matched against the text of the first page
   * — a bank's name is on its own statements and on nobody else's.
   */
  readonly identifiedBy: readonly string[];
  /** The line that starts the table. Everything above it is letterhead. */
  readonly headerPattern: string;
  /** Column names as this bank writes them. Matched case-insensitively. */
  readonly columns: {
    readonly date: string;
    readonly amount: string;
    readonly description: string;
    readonly credit?: string;
    readonly currency?: string;
  };
  readonly dateOrder: DateOrder;
  /** Three-letter code, when the bank reports one currency for the whole file. */
  readonly currency?: string;
  readonly debitsArePositive?: boolean;
  /** Layout overrides for a bank whose columns sit unusually close together. */
  readonly layout?: Pick<TableOptions, 'columnGap' | 'lineTolerance' | 'columnSupport'>;
}

/**
 * The rule sets that ship.
 *
 * Two, and both are synthetic: real statements are personal financial documents
 * and stay out of the repository (the corpus is gitignored). These exist to fix
 * the shape and to keep the machinery honest — every rule set below is checked
 * against a fixture that exercises it end to end, and a new one is not
 * considered done without one.
 */
export const RULE_SETS: readonly StatementRuleSet[] = [
  {
    id: 'example-first-national',
    version: 1,
    label: 'First National Bank',
    identifiedBy: ['First National Bank'],
    headerPattern: '^Date\\b.*Description',
    columns: { date: 'Date', description: 'Description', amount: 'Amount' },
    dateOrder: 'ymd',
    currency: 'USD',
  },
  {
    id: 'example-northbank',
    version: 1,
    label: 'Northbank',
    identifiedBy: ['Northbank plc', 'Northbank Current Account'],
    headerPattern: 'Posted\\s+Date',
    columns: {
      date: 'Posted Date',
      description: 'Narrative',
      amount: 'Money Out',
      credit: 'Money In',
    },
    // A bank that puts spending in its own column writes it unsigned.
    dateOrder: 'dmy',
    currency: 'GBP',
    debitsArePositive: true,
  },
];

/** What a matched rule set says about how to read the file. */
export interface RuleSetReading {
  readonly ruleSet: StatementRuleSet;
  readonly table: CsvTable;
  readonly mapping: ColumnMapping;
  readonly dateOrder: DateOrder;
  readonly currency: string | undefined;
  readonly debitsArePositive: boolean;
}

/**
 * The rule set this document is written by, if any.
 *
 * Matching is on the text of the first page, because that is where a bank puts
 * its name and because a match must not depend on the table having been read
 * correctly — that is the part the rule set exists to help with.
 */
export function matchRuleSet(
  document: PdfDocument,
  ruleSets: readonly StatementRuleSet[] = RULE_SETS,
): StatementRuleSet | undefined {
  const first = document.pages[0];
  if (first === undefined) return undefined;

  const text = first.items.map((item) => item.text).join(' ').toLowerCase();

  return ruleSets.find((ruleSet) =>
    ruleSet.identifiedBy.some((marker) => text.includes(marker.toLowerCase())),
  );
}

/**
 * Read a document the way its bank's rule set says to.
 *
 * Returns undefined when the rule set matched the letterhead but not the table
 * — a bank that changed its column names, which is exactly the case where
 * guessing would produce plausible nonsense. Falling back to asking the user
 * beats importing under a rule that no longer holds.
 */
export function readWithRuleSet(
  document: PdfDocument,
  ruleSet: StatementRuleSet,
): RuleSetReading | undefined {
  const table = tableOfDocument(document, {
    headerPattern: new RegExp(ruleSet.headerPattern, 'i'),
    ...(ruleSet.layout ?? {}),
  });

  if (table.header.length === 0) return undefined;

  const mapping = mappingFor(table.header, ruleSet);
  if (mapping === undefined) return undefined;

  return {
    ruleSet,
    table,
    mapping,
    dateOrder: ruleSet.dateOrder,
    currency: ruleSet.currency,
    debitsArePositive: ruleSet.debitsArePositive ?? false,
  };
}

/**
 * Column names to indexes.
 *
 * By name rather than by position: a bank adding a "Balance" column at the end
 * should not silently shift every other column, and a rule set written against
 * names survives that.
 */
function mappingFor(
  header: readonly string[],
  ruleSet: StatementRuleSet,
): ColumnMapping | undefined {
  const find = (name: string | undefined): number | undefined => {
    if (name === undefined) return undefined;

    const wanted = name.trim().toLowerCase();
    const index = header.findIndex((column) => column.trim().toLowerCase() === wanted);

    return index === -1 ? undefined : index;
  };

  const date = find(ruleSet.columns.date);
  const amount = find(ruleSet.columns.amount);
  const description = find(ruleSet.columns.description);

  if (date === undefined || amount === undefined || description === undefined) return undefined;

  const credit = find(ruleSet.columns.credit);
  const currency = find(ruleSet.columns.currency);

  return {
    date,
    amount,
    description,
    ...(credit === undefined ? {} : { credit }),
    ...(currency === undefined ? {} : { currency }),
  };
}

/** What produced a row, for the record kept against every import. */
export function provenanceOf(ruleSet: StatementRuleSet): string {
  return `${ruleSet.id}@${String(ruleSet.version)}`;
}
