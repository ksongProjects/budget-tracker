import type { CaptureId, Timestamp } from '@budget/schema';
import type { DraftLineItem, NewRecord } from '@budget/db';
import type { SpokenRecord, StructuredCandidate } from '@budget/extract';

/**
 * From what was said to what the ledger stores.
 *
 * Kept out of the screen so the decisions in it — when a model's reading
 * replaces the rules', which items are worth storing — are tested without a
 * microphone.
 */

/**
 * A model's reading of a recording, as one record.
 *
 * Used only when the rules found at most one record: a model reads one spend
 * per call, and letting it collapse "coffee at Blue Bottle and gas at Shell"
 * back into one would undo the split. Its fields win where it read them, the
 * rules' fill the gaps, as everywhere else in Tier 3.
 */
export function fromModel(
  model: StructuredCandidate,
  rules: SpokenRecord | undefined,
): SpokenRecord | undefined {
  if (model.engine === 'rules') return rules;

  const total = model.total;
  if (total === undefined) return rules;

  const merchant = model.merchant ?? rules?.merchant;
  const occurredAt = model.occurredAt ?? rules?.occurredAt;
  const currency = model.currency ?? rules?.currency;
  if (currency === undefined) return rules;

  const items =
    model.lineItems !== undefined && model.lineItems.length > 0
      ? model.lineItems.map((line) => ({
          name: line.value.description,
          amount: { value: line.value.amount, confidence: line.confidence, evidence: line.evidence },
        }))
      : [
          {
            // The rules' name for the one thing bought, when they found one;
            // the model's total, which is the one shown.
            name: rules?.items[0]?.name ?? merchant?.value ?? 'Spend',
            amount: total,
          },
        ];

  return {
    ...(merchant === undefined ? {} : { merchant }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    currency,
    items,
    total: total.value,
    said: rules?.said ?? '',
  };
}

/**
 * The items worth storing.
 *
 * An item the speaker named — "coffee" — is information and is kept. One that
 * only stands in for the whole record, named after the merchant because nothing
 * else was said, is not: the record reads back an implied item for that, and
 * storing a copy would just be a second place for the amount to disagree.
 */
export function draftItems(record: SpokenRecord): DraftLineItem[] {
  if (record.items.length === 1) {
    const only = record.items[0];
    if (only === undefined || only.name === record.merchant?.value || only.name === 'Spend') {
      return [];
    }
  }

  return record.items.map((item) => ({
    kind: 'item',
    name: item.name,
    quantity: null,
    unitPriceMinor: null,
    totalMinor: item.amount.value,
  }));
}

/** A spoken record ready to write, already confirmed — the user just read it. */
export function toNewRecord(
  record: SpokenRecord,
  captureId: CaptureId,
  heardAt: Timestamp,
): NewRecord {
  return {
    captureId,
    source: 'voice',
    date: record.occurredAt?.value ?? heardAt,
    merchant: record.merchant?.value ?? null,
    items: draftItems(record),
    amountMinor: record.total,
    currency: record.currency.value,
    confirmed: true,
  };
}
