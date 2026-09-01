import type { StructuringRequest } from './types.js';

/**
 * What the model is asked, in one place.
 *
 * A prompt is behaviour: change a word and the numbers change. Keeping it here,
 * as data built by a pure function, means it is diffable, testable, and the
 * same for every adapter — an on-device model and the opt-in cloud path get the
 * identical instruction, so the fixture suite that scores one scores the other.
 */

export interface Prompt {
  readonly system: string;
  readonly user: string;
  /** For adapters whose API takes a JSON schema for constrained decoding. */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}

const RULES = [
  'Return only JSON. No explanation, no markdown fence, no commentary.',
  'Copy numbers exactly as printed. Never compute a total the text does not state.',
  'Omit a field you cannot find. Never guess, and never write a zero for a missing value.',
  'Dates are ISO YYYY-MM-DD.',
  'Currency is a three-letter ISO code.',
].join(' ');

const RECEIPT_TASK =
  'The text is OCR of a shop receipt, so it may be misaligned, may repeat lines, ' +
  'and may split a label from its amount. Read the merchant, the date, the ' +
  'total actually charged, the tax, the tip, and the purchased line items. ' +
  // The confirm screen sends the table the rules already built, not raw OCR:
  // the rows it could not price are marked, which turns "read this receipt"
  // into the far easier "these three rows have no number".
  'It may arrive as tab-separated rows of id, label and amount, where a "?" ' +
  'marks a value OCR could not read. Fill those in from the surrounding text ' +
  'and repeat the rows that already have an amount exactly as given.';

const UTTERANCE_TASK =
  'The text is a transcript of someone saying what they spent, out loud, in one ' +
  'sentence. It has no punctuation to rely on and numbers may be spelled out. ' +
  'Read the amount, the currency, the merchant, and the day if one is named.';

export function buildPrompt(request: StructuringRequest): Prompt {
  const today = isoDate(request.now);
  const task = request.kind === 'receipt' ? RECEIPT_TASK : UTTERANCE_TASK;

  return {
    system:
      'You extract structured spending data from text. ' +
      `${task} ${RULES} ` +
      // The default is stated rather than assumed so a model that finds no
      // currency writes the user's own instead of guessing at USD.
      `If no currency appears in the text, use ${request.defaultCurrency}. ` +
      `Today is ${today}; resolve relative days like "yesterday" against it, ` +
      'and never date a purchase in the future.',
    user: request.text,
    jsonSchema: JSON_SCHEMA,
  };
}

/** ISO date in UTC — the same day the rest of the app's timestamps are read in. */
function isoDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

const JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    merchant: { type: 'string' },
    date: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    total: { type: 'string' },
    tax: { type: 'string' },
    tip: { type: 'string' },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          amount: { type: 'string' },
          quantity: { type: 'number' },
        },
        required: ['description', 'amount'],
      },
    },
  },
  required: [],
};
