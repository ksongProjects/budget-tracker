import { CurrencySchema, LineItemKindSchema } from '@budget/schema';
import type { CaptureId, Currency, MinorUnits, Timestamp } from '@budget/schema';
import type { DraftLineItem } from '@budget/db';

/**
 * A record handed from a capture screen to the add form, as route params.
 *
 * Route params are strings that anything holding a link can set, so the form
 * reads them through `readHandoff` rather than trusting them: a malformed item
 * list is dropped, not half-read, and an amount that is not a whole number of
 * minor units is no amount at all.
 */
export interface Handoff {
  readonly amountMinor?: MinorUnits;
  readonly currency?: Currency;
  readonly merchant?: string;
  readonly note?: string;
  readonly date?: Timestamp;
  readonly items?: readonly DraftLineItem[];
  readonly source?: 'voice';
  readonly captureId?: CaptureId;
}

export type HandoffParams = Partial<Record<keyof Handoff, string>>;

export function toParams(handoff: Handoff): HandoffParams {
  const params: Record<string, string> = {};
  if (handoff.amountMinor !== undefined) params.amountMinor = String(handoff.amountMinor);
  if (handoff.currency !== undefined) params.currency = handoff.currency;
  if (handoff.merchant !== undefined) params.merchant = handoff.merchant;
  if (handoff.note !== undefined) params.note = handoff.note;
  if (handoff.date !== undefined) params.date = String(handoff.date);
  if (handoff.items !== undefined) params.items = JSON.stringify(handoff.items);
  if (handoff.source !== undefined) params.source = handoff.source;
  if (handoff.captureId !== undefined) params.captureId = handoff.captureId;
  return params;
}

export function readHandoff(params: HandoffParams): Handoff {
  const amountMinor = wholeNumber(params.amountMinor);
  const currency = CurrencySchema.safeParse(params.currency).data;
  const date = wholeNumber(params.date);
  const items = readItems(params.items);

  return {
    ...(amountMinor === undefined ? {} : { amountMinor: amountMinor as MinorUnits }),
    ...(currency === undefined ? {} : { currency }),
    ...(params.merchant === undefined ? {} : { merchant: params.merchant }),
    ...(params.note === undefined ? {} : { note: params.note }),
    ...(date === undefined ? {} : { date: date as Timestamp }),
    ...(items === undefined ? {} : { items }),
    ...(params.source === 'voice' ? { source: 'voice' as const } : {}),
    ...(params.captureId === undefined ? {} : { captureId: params.captureId as CaptureId }),
  };
}

function wholeNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function readItems(value: string | undefined): DraftLineItem[] | undefined {
  if (value === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const items: DraftLineItem[] = [];
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const item = entry as Record<string, unknown>;

    const kind = LineItemKindSchema.safeParse(item.kind).data;
    const total = typeof item.totalMinor === 'number' ? item.totalMinor : NaN;
    if (kind === undefined || typeof item.name !== 'string' || !Number.isSafeInteger(total)) {
      return undefined;
    }

    items.push({
      kind,
      name: item.name,
      quantity:
        typeof item.quantity === 'number' && Number.isSafeInteger(item.quantity) && item.quantity > 0
          ? item.quantity
          : null,
      unitPriceMinor: null,
      totalMinor: total as MinorUnits,
    });
  }

  return items;
}
