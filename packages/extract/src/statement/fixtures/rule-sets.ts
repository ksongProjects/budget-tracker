import type { PdfDocument, PdfTextItem } from '../layout.js';

/**
 * One fixture per rule set, as the text layer a bank's PDF would produce.
 *
 * The implementation plan asks for a fixture PDF behind every rule set. Real
 * statements are personal financial documents and stay out of the repository,
 * so what is committed is the *layout*: the same coordinates, column positions
 * and header wording, with invented amounts and merchants. That is the part a
 * rule set actually depends on.
 *
 * A rule set without an entry here fails its test. The point is not the two
 * banks below — it is that adding a third cannot be done without evidence that
 * it works.
 */

function item(text: string, x: number, y: number): PdfTextItem {
  return { text, x, y, width: text.length * 5, height: 10 };
}

function page(items: readonly PdfTextItem[]): PdfDocument['pages'][number] {
  return { number: 1, width: 612, height: 792, items };
}

export interface RuleSetFixture {
  readonly document: PdfDocument;
  /** What the rows should come out as, so a layout change fails loudly. */
  readonly expect: {
    readonly count: number;
    /** Minor units, in file order. */
    readonly amounts: readonly number[];
    readonly firstDescription: string;
    readonly firstOccurredAt: number;
  };
}

/** A US bank: one signed amount column, ISO dates. */
const firstNational: RuleSetFixture = {
  document: {
    engine: 'fixture',
    pages: [
      page([
        item('First National Bank', 40, 40),
        item('Statement period 1 March 2026 to 31 March 2026', 40, 56),
        item('Account ending 4321', 40, 72),

        item('Date', 40, 110),
        item('Description', 140, 110),
        item('Amount', 420, 110),

        item('2026-03-14', 40, 130),
        item('BLUE BOTTLE COFFEE 1234', 140, 130),
        item('-4.50', 420, 130),

        item('2026-03-15', 40, 150),
        item('SAFEWAY 0421', 140, 150),
        item('-62.18', 420, 150),

        item('2026-03-16', 40, 170),
        item('RENT MARCH', 140, 170),
        item('-1,850.00', 420, 170),
      ]),
    ],
  },
  expect: {
    count: 3,
    amounts: [450, 6218, 185000],
    firstDescription: 'BLUE BOTTLE COFFEE 1234',
    firstOccurredAt: Date.UTC(2026, 2, 14, 12),
  },
};

/**
 * A UK bank: split money-in and money-out columns, day-first dates, and a
 * balance column at the end that must not be mistaken for the amount.
 */
const northbank: RuleSetFixture = {
  document: {
    engine: 'fixture',
    pages: [
      page([
        item('Northbank plc', 40, 40),
        item('Northbank Current Account', 40, 56),

        item('Posted Date', 40, 110),
        item('Narrative', 150, 110),
        item('Money Out', 330, 110),
        item('Money In', 430, 110),
        item('Balance', 520, 110),

        item('14/03/2026', 40, 130),
        item('CAFE NERO 88', 150, 130),
        item('3.20', 330, 130),
        item('1,240.10', 520, 130),

        item('16/03/2026', 40, 150),
        item('SALARY MARCH', 150, 150),
        item('2,400.00', 430, 150),
        item('3,640.10', 520, 150),
      ]),
    ],
  },
  expect: {
    count: 2,
    // Money out is spending; money in is its opposite.
    amounts: [320, -240000],
    firstDescription: 'CAFE NERO 88',
    firstOccurredAt: Date.UTC(2026, 2, 14, 12),
  },
};

export const RULE_SET_FIXTURES: Readonly<Record<string, RuleSetFixture>> = {
  'example-first-national': firstNational,
  'example-northbank': northbank,
};
