import { describe, expect, it } from 'vitest';
import { CaptureIdSchema, UuidSchema, uuidv7, uuidv7Timestamp } from './ids.js';

describe('uuidv7', () => {
  it('produces ids that validate as UUIDv7', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(UuidSchema.safeParse(uuidv7()).success).toBe(true);
    }
  });

  it('sorts lexicographically by creation time', () => {
    const early = uuidv7(1_000_000_000_000);
    const late = uuidv7(1_700_000_000_000);
    expect(early < late).toBe(true);
  });

  it('keeps ids sorted across a sequence of timestamps', () => {
    const base = Date.now();
    const ids = Array.from({ length: 50 }, (_, i) => uuidv7(base + i * 7));
    expect([...ids].sort()).toEqual(ids);
  });

  it('is unique within a single millisecond', () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(now)));
    expect(ids.size).toBe(10_000);
  });

  it('round-trips the embedded timestamp', () => {
    const now = 1_735_689_600_000;
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
  });

  it('encodes current time within the millisecond it was called', () => {
    const before = Date.now();
    const stamped = uuidv7Timestamp(uuidv7());
    const after = Date.now();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});

describe('id schemas', () => {
  it('rejects non-v7 uuids', () => {
    // A v4 uuid: version nibble is 4, not 7.
    expect(UuidSchema.safeParse('9f8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d').success).toBe(false);
  });

  it('rejects malformed strings', () => {
    for (const bad of ['', 'not-a-uuid', '0199b0f0-0000-7000-8000', '0199B0F0-0000-7000-8000-000000000000']) {
      expect(CaptureIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts generated ids', () => {
    expect(CaptureIdSchema.safeParse(uuidv7()).success).toBe(true);
  });
});
