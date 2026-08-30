import { z } from 'zod';
import {
  AccountIdSchema,
  CaptureIdSchema,
  CategoryIdSchema,
  DeviceIdSchema,
  ExtractionIdSchema,
  LineItemIdSchema,
  MerchantIdSchema,
  TransactionIdSchema,
} from './ids.js';
import { CurrencySchema, MinorUnitsSchema } from './money.js';

/**
 * Domain entities, mirroring docs/data-model.md. Field names are camelCase here
 * and snake_case in SQLite; @budget/db owns that mapping and round-trip-tests it.
 */

/** Epoch milliseconds, UTC. Local time is a presentation concern and is never stored. */
export const TimestampSchema = z.number().int().brand<'Timestamp'>();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const now = (): Timestamp => Date.now() as Timestamp;

/**
 * Every row that a user can edit carries these. Without them a row cannot
 * survive a Merge, so the merge functions take this shape and nothing narrower.
 */
export const MergeFieldsSchema = z.object({
  rev: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
  originDevice: DeviceIdSchema,
});
export type MergeFields = z.infer<typeof MergeFieldsSchema>;

export const CaptureKindSchema = z.enum(['photo', 'statement', 'voice', 'manual']);
export type CaptureKind = z.infer<typeof CaptureKindSchema>;

export const CaptureSchema = MergeFieldsSchema.extend({
  captureId: CaptureIdSchema,
  kind: CaptureKindSchema,
  /** When the user captured, not when the row was written. */
  capturedAt: TimestampSchema,
  /** App-private path; null for manual entry, which has no document. */
  documentPath: z.string().nullable(),
  documentHash: z.string().nullable(),
  documentBytes: z.number().int().nonnegative().nullable(),
});
export type Capture = z.infer<typeof CaptureSchema>;

export const ExtractionTierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type ExtractionTier = z.infer<typeof ExtractionTierSchema>;

export const ExtractionStatusSchema = z.enum(['pending', 'done', 'failed']);

export const ExtractionSchema = z.object({
  id: ExtractionIdSchema,
  captureId: CaptureIdSchema,
  /** Which tier produced this. The audit trail for a wrong number. */
  tier: ExtractionTierSchema,
  engine: z.string().min(1),
  status: ExtractionStatusSchema,
  /** Proposed fields before confirmation; shape varies by tier, so JSON. */
  candidate: z.record(z.string(), z.unknown()),
  confidence: z.record(z.string(), z.number().min(0).max(1)),
  ranAt: TimestampSchema,
  durationMs: z.number().int().nonnegative(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export const TransactionSourceSchema = CaptureKindSchema;

export const TransactionSchema = MergeFieldsSchema.extend({
  id: TransactionIdSchema,
  /** Null only for rows created by CSV import, which have no capture. */
  captureId: CaptureIdSchema.nullable(),
  accountId: AccountIdSchema.nullable(),
  merchantId: MerchantIdSchema.nullable(),
  categoryId: CategoryIdSchema.nullable(),
  amountMinor: MinorUnitsSchema,
  currency: CurrencySchema,
  /** When the money was spent. */
  occurredAt: TimestampSchema,
  /** When the institution posted it; statements only. */
  postedAt: TimestampSchema.nullable(),
  note: z.string().nullable(),
  source: TransactionSourceSchema,
  /** Null until the user confirms. Unconfirmed rows stay out of every total. */
  confirmedAt: TimestampSchema.nullable(),
  /** Original amount preserved so a later rate revision never rewrites history. */
  fxOriginalMinor: MinorUnitsSchema.nullable(),
  fxOriginalCurrency: CurrencySchema.nullable(),
  fxRate: z.number().positive().nullable(),
  /** Whether line items sum to the total. Surfaced, never silently trusted. */
  reconciled: z.boolean(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const LineItemKindSchema = z.enum(['item', 'tax', 'fee', 'discount', 'tip']);
export type LineItemKind = z.infer<typeof LineItemKindSchema>;

export const LineItemSchema = MergeFieldsSchema.extend({
  id: LineItemIdSchema,
  transactionId: TransactionIdSchema,
  kind: LineItemKindSchema,
  name: z.string(),
  quantity: z.number().int().positive().nullable(),
  unitPriceMinor: MinorUnitsSchema.nullable(),
  totalMinor: MinorUnitsSchema,
  /** Order as printed on the receipt. */
  position: z.number().int().nonnegative(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const MerchantSchema = MergeFieldsSchema.extend({
  id: MerchantIdSchema,
  canonicalName: z.string().min(1),
});
export type Merchant = z.infer<typeof MerchantSchema>;

/** `SQ *BLUE BOTTLE`, `BLUE BOTTLE COFFEE`, and `BLUEBOTTLE.COM` are one merchant. */
export const MerchantAliasSchema = MergeFieldsSchema.extend({
  alias: z.string().min(1),
  merchantId: MerchantIdSchema,
});
export type MerchantAlias = z.infer<typeof MerchantAliasSchema>;

export const CategorySchema = MergeFieldsSchema.extend({
  id: CategoryIdSchema,
  name: z.string().min(1),
  /** Null for top-level categories. */
  parentId: CategoryIdSchema.nullable(),
});
export type Category = z.infer<typeof CategorySchema>;

export const AccountSchema = MergeFieldsSchema.extend({
  id: AccountIdSchema,
  name: z.string().min(1),
  currency: CurrencySchema,
});
export type Account = z.infer<typeof AccountSchema>;
