import { CurrencySchema, parseAmount } from '@budget/schema';
import type { Timestamp } from '@budget/schema';
import type { StructuringExpectation, StructuringKind } from './types.js';

/**
 * The suite every Tier 3 engine is scored against.
 *
 * One corpus, every adapter: Apple's model, Gemini Nano, the opt-in cloud path
 * and any double stand in front of the same texts and are marked the same way.
 * That is what makes "is the on-device model good enough?" a question with a
 * number for an answer instead of an opinion.
 *
 * The texts are invented — receipts and voice notes are personal documents, and
 * the real corpus is gitignored (docs/extraction.md). What is committed is the
 * *shape*: OCR that splits a label from its amount, a receipt whose items do
 * not add up, a transcript with the number spelled out.
 */

const USD = CurrencySchema.parse('USD');
const EUR = CurrencySchema.parse('EUR');

const usd = (amount: string) => parseAmount(amount, USD);
const eur = (amount: string) => parseAmount(amount, EUR);

/** 2026-08-29, the day most of these fixtures happened. */
const AUGUST_29 = Date.UTC(2026, 7, 29) as Timestamp;

/** What "now" is when the suite runs, so relative days resolve the same way every time. */
export const FIXTURE_NOW = Date.UTC(2026, 7, 30, 12);

export interface StructuringFixture {
  readonly id: string;
  readonly kind: StructuringKind;
  readonly text: string;
  readonly expect: StructuringExpectation;
  /** Why this one is in the suite. */
  readonly note: string;
}

export const STRUCTURING_FIXTURES: readonly StructuringFixture[] = [
  {
    id: 'cafe-with-items',
    kind: 'receipt',
    text: [
      'BLUE BOTTLE COFFEE',
      '1 Ferry Building',
      '2026-08-29  09:14',
      'Latte           4.50',
      'Croissant       3.75',
      'SUBTOTAL        8.25',
      'TAX             0.72',
      'TOTAL           8.97',
      'VISA ****4242',
    ].join('\n'),
    expect: {
      amountMinor: usd('8.97'),
      currency: USD,
      merchant: 'BLUE BOTTLE COFFEE',
      occurredAt: AUGUST_29,
      taxMinor: usd('0.72'),
      lineItemCount: 2,
      balanced: true,
    },
    note: 'The straightforward case: items, tax and total that add up.',
  },
  {
    id: 'restaurant-with-tip',
    kind: 'receipt',
    text: [
      'TARTINE MANUFACTORY',
      '595 Alabama St',
      '08/29/2026',
      'Morning bun         5.50',
      'Country loaf       11.00',
      'Coffee              4.00',
      'Subtotal           20.50',
      'Tax                 1.79',
      'Tip                 4.10',
      'TOTAL              26.39',
    ].join('\n'),
    expect: {
      amountMinor: usd('26.39'),
      currency: USD,
      merchant: 'TARTINE MANUFACTORY',
      taxMinor: usd('1.79'),
      tipMinor: usd('4.10'),
      lineItemCount: 3,
      balanced: true,
    },
    note: 'Tip is a line of its own and belongs in the reconciliation.',
  },
  {
    id: 'discounted-basket',
    kind: 'receipt',
    text: [
      'SAFEWAY 0421',
      '2026-08-29',
      'Milk 2%             4.29',
      'Eggs dozen          6.49',
      'Coffee beans       14.99',
      'MEMBER SAVINGS     -3.00',
      'TAX                 0.00',
      'TOTAL              22.77',
    ].join('\n'),
    expect: {
      amountMinor: usd('22.77'),
      currency: USD,
      merchant: 'SAFEWAY 0421',
      occurredAt: AUGUST_29,
      lineItemCount: 3,
      // The discount is why: items alone overshoot the total, and the flag is
      // supposed to say so rather than hide it.
      balanced: false,
    },
    note: 'A discount line means the items deliberately do not reconcile.',
  },
  {
    id: 'ocr-split-columns',
    kind: 'receipt',
    text: [
      'MUNI',
      'SINGLE RIDE',
      'TOTAL',
      '2.75',
      '2026-08-29',
    ].join('\n'),
    expect: {
      amountMinor: usd('2.75'),
      currency: USD,
      merchant: 'MUNI',
      occurredAt: AUGUST_29,
      lineItemCount: 0,
    },
    note: 'OCR that puts the label and its amount on separate lines.',
  },
  {
    id: 'euro-comma-decimal',
    kind: 'receipt',
    text: [
      'BÄCKEREI SCHMIDT',
      'Berlin',
      '29.08.2026',
      'Brötchen        2,40',
      'Kaffee          3,60',
      'SUMME EUR       6,00',
    ].join('\n'),
    expect: {
      amountMinor: eur('6.00'),
      currency: EUR,
      merchant: 'BÄCKEREI SCHMIDT',
      lineItemCount: 2,
      balanced: true,
    },
    note: 'A decimal comma, which is the failure mode of every naive amount parser.',
  },
  {
    id: 'spoken-coffee',
    kind: 'utterance',
    text: 'twelve bucks on coffee at blue bottle',
    expect: {
      amountMinor: usd('12.00'),
      currency: USD,
      merchant: 'blue bottle',
    },
    note: 'The plain spoken case, with the number spelled out.',
  },
  {
    id: 'spoken-two-numbers',
    kind: 'utterance',
    text: 'four fifty at tartine yesterday',
    expect: {
      // Four fifty means 4.50 to anyone who heard it, and the rules
      // deliberately read it as 4 rather than invent a decimal
      // (packages/extract/src/voice/utterances.ts). Ground truth is what a
      // person meant, so this is a fixture the rules are expected to miss and
      // a model is expected to get — which is the whole argument for Tier 3.
      amountMinor: usd('4.50'),
      currency: USD,
      merchant: 'tartine',
      occurredAt: AUGUST_29,
    },
    note: 'Two spoken numbers in a row: where a model should beat the rules.',
  },
  {
    id: 'spoken-no-amount',
    kind: 'utterance',
    text: 'i think i bought something at the hardware store',
    expect: {
      // Nothing readable means nothing proposed. A zero here would import as a
      // real transaction of no value.
      lineItemCount: 0,
    },
    note: 'A sentence with no number in it, which must produce no amount.',
  },
];
