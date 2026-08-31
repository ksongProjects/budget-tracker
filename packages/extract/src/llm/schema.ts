import { z } from 'zod';

/**
 * The shape a model is asked to return, and the gate everything it returns
 * passes through.
 *
 * Deliberately lenient about *form* and strict about *meaning*. A 3B model on a
 * phone writes `"12.50"`, `12.5`, `"$12.50"` and `"12,50"` for the same number
 * on different runs, and rejecting the run is worse for the user than
 * normalising the string. What is not negotiated: a field that cannot be read
 * as a number is dropped, never guessed at, and an unparseable response yields
 * no candidate rather than a partial one built from whatever survived.
 */

/** Amounts arrive as strings or numbers, with or without symbols and separators. */
const LooseAmount = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const normalised = normaliseAmount(String(value));
  if (normalised === undefined) {
    ctx.addIssue({ code: 'custom', message: 'not an amount' });
    return z.NEVER;
  }
  return normalised;
});

const LooseQuantity = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const quantity = Number(String(value).trim());
  if (!Number.isFinite(quantity) || quantity <= 0) {
    ctx.addIssue({ code: 'custom', message: 'not a quantity' });
    return z.NEVER;
  }
  return quantity;
});

const Nullable = <T extends z.ZodType>(inner: T) => inner.nullish().catch(null);

export const ModelLineItemSchema = z.object({
  description: z.string().trim().min(1),
  amount: LooseAmount,
  quantity: Nullable(LooseQuantity),
});

/**
 * A model's answer.
 *
 * Every field is optional: a model that omits the tip is right about a receipt
 * with no tip on it, and a schema that demanded one would teach it to invent
 * numbers — which is the failure this whole tier has to avoid.
 */
export const ModelOutputSchema = z.object({
  merchant: Nullable(z.string().trim().min(1)),
  /** ISO `YYYY-MM-DD`. Anything else is dropped rather than interpreted. */
  date: Nullable(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  currency: Nullable(z.string().trim().length(3)),
  total: Nullable(LooseAmount),
  tax: Nullable(LooseAmount),
  tip: Nullable(LooseAmount),
  lineItems: z.array(ModelLineItemSchema).nullish().catch(null),
});

export type ModelOutput = z.infer<typeof ModelOutputSchema>;

/**
 * A decimal string `parseAmount` can read, or undefined.
 *
 * Handles what small models actually emit: currency symbols, thousands
 * separators, European decimal commas, and negative amounts written with a
 * leading minus or wrapped in parentheses as accountants write them.
 */
export function normaliseAmount(input: string): string | undefined {
  let text = input.trim();
  if (text === '') return undefined;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }

  // Symbols and spaces go; digits, separators and nothing else stay.
  text = text.replace(/[^\d.,]/g, '');
  if (text === '') return undefined;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever comes last is the decimal point; the other groups thousands.
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // A lone comma is a decimal point when it is followed by one or two digits
    // ("12,50"), and a thousands separator otherwise ("1,250").
    const after = text.length - lastComma - 1;
    text = after === 1 || after === 2 ? text.replace(',', '.') : text.replace(/,/g, '');
  }

  if (!/^\d*\.?\d*$/.test(text) || text === '.') return undefined;

  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;

  return `${negative ? '-' : ''}${text.startsWith('.') ? '0' : ''}${text}`;
}
