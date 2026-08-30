import { z } from 'zod';

/**
 * UUIDv7: a 48-bit millisecond timestamp followed by randomness. Ids sort by
 * creation time, so primary-key indexes stay dense and `ORDER BY id` is a
 * useful tiebreak. Merge depends on ids being globally unique across devices
 * that have never met, which the 74 random bits provide.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const UuidSchema = z.string().regex(UUID_PATTERN, 'must be a UUIDv7');

export const CaptureIdSchema = UuidSchema.brand<'CaptureId'>();
export const TransactionIdSchema = UuidSchema.brand<'TransactionId'>();
export const LineItemIdSchema = UuidSchema.brand<'LineItemId'>();
export const MerchantIdSchema = UuidSchema.brand<'MerchantId'>();
export const CategoryIdSchema = UuidSchema.brand<'CategoryId'>();
export const AccountIdSchema = UuidSchema.brand<'AccountId'>();
export const ExtractionIdSchema = UuidSchema.brand<'ExtractionId'>();

export type CaptureId = z.infer<typeof CaptureIdSchema>;
export type TransactionId = z.infer<typeof TransactionIdSchema>;
export type LineItemId = z.infer<typeof LineItemIdSchema>;
export type MerchantId = z.infer<typeof MerchantIdSchema>;
export type CategoryId = z.infer<typeof CategoryIdSchema>;
export type AccountId = z.infer<typeof AccountIdSchema>;
export type ExtractionId = z.infer<typeof ExtractionIdSchema>;

/** Identifies the device that minted a row; survives in the ledger to break merge ties deterministically. */
export const DeviceIdSchema = z.string().min(1).brand<'DeviceId'>();
export type DeviceId = z.infer<typeof DeviceIdSchema>;

const HEX = '0123456789abcdef';

/**
 * Generate a UUIDv7. Uses the Web Crypto API, which exists on Node, in the
 * browser, and in React Native — no platform branch, and no Math.random, which
 * would undermine the uniqueness merge relies on.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const timestamp = BigInt(Math.trunc(now));
  for (let i = 0; i < 6; i += 1) {
    // Big-endian 48-bit timestamp in bytes 0..5.
    bytes[i] = Number((timestamp >> BigInt(8 * (5 - i))) & 0xffn);
  }

  // Version 7 in the high nibble of byte 6; RFC 9562 variant in byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  let hex = '';
  for (const byte of bytes) {
    hex += (HEX[byte >> 4] ?? '0') + (HEX[byte & 0x0f] ?? '0');
  }

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds encoded in a UUIDv7, for debugging and for merge diagnostics. */
export function uuidv7Timestamp(id: string): number {
  return Number(BigInt(`0x${id.slice(0, 8)}${id.slice(9, 13)}`));
}
