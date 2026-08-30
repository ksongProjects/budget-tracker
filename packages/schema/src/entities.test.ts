import { describe, expect, it } from 'vitest';
import {
  CaptureSchema,
  ExtractionSchema,
  LineItemSchema,
  TransactionSchema,
  now,
} from './entities.js';
import { uuidv7 } from './ids.js';

const device = 'device-a';

const baseMerge = {
  rev: 1,
  updatedAt: now(),
  deletedAt: null,
  originDevice: device,
};

const validTransaction = {
  ...baseMerge,
  id: uuidv7(),
  captureId: uuidv7(),
  accountId: null,
  merchantId: null,
  categoryId: null,
  amountMinor: 1234,
  currency: 'USD',
  occurredAt: now(),
  postedAt: null,
  note: null,
  source: 'photo',
  confirmedAt: null,
  fxOriginalMinor: null,
  fxOriginalCurrency: null,
  fxRate: null,
  reconciled: false,
};

describe('TransactionSchema', () => {
  it('accepts a valid row', () => {
    expect(TransactionSchema.parse(validTransaction).amountMinor).toBe(1234);
  });

  it('round-trips through JSON, which backups and extraction payloads depend on', () => {
    const parsed = TransactionSchema.parse(validTransaction);
    const revived = TransactionSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(revived).toEqual(parsed);
  });

  it('rejects a float amount', () => {
    expect(TransactionSchema.safeParse({ ...validTransaction, amountMinor: 12.34 }).success).toBe(false);
  });

  it('rejects a bad currency', () => {
    expect(TransactionSchema.safeParse({ ...validTransaction, currency: 'usd' }).success).toBe(false);
  });

  it('rejects an unknown source', () => {
    expect(TransactionSchema.safeParse({ ...validTransaction, source: 'telepathy' }).success).toBe(false);
  });

  it('requires the merge fields', () => {
    const { rev: _rev, ...withoutRev } = validTransaction;
    expect(TransactionSchema.safeParse(withoutRev).success).toBe(false);
  });

  it('allows a null captureId only, never a malformed one', () => {
    expect(TransactionSchema.safeParse({ ...validTransaction, captureId: null }).success).toBe(true);
    expect(TransactionSchema.safeParse({ ...validTransaction, captureId: 'nope' }).success).toBe(false);
  });

  it('keeps the original amount and rate together for foreign currency', () => {
    const fx = TransactionSchema.parse({
      ...validTransaction,
      fxOriginalMinor: 1500,
      fxOriginalCurrency: 'EUR',
      fxRate: 1.08,
    });
    expect(fx.fxOriginalCurrency).toBe('EUR');
  });

  it('rejects a non-positive exchange rate', () => {
    expect(TransactionSchema.safeParse({ ...validTransaction, fxRate: 0 }).success).toBe(false);
  });
});

describe('CaptureSchema', () => {
  const capture = {
    ...baseMerge,
    captureId: uuidv7(),
    kind: 'manual',
    capturedAt: now(),
    documentPath: null,
    documentHash: null,
    documentBytes: null,
  };

  it('accepts a manual capture with no document', () => {
    expect(CaptureSchema.parse(capture).kind).toBe('manual');
  });

  it('accepts a photo capture with a document', () => {
    const photo = CaptureSchema.parse({
      ...capture,
      kind: 'photo',
      documentPath: 'documents/abc.jpg',
      documentHash: 'sha256:deadbeef',
      documentBytes: 204_800,
    });
    expect(photo.documentBytes).toBe(204_800);
  });

  it('rejects a negative document size', () => {
    expect(CaptureSchema.safeParse({ ...capture, documentBytes: -1 }).success).toBe(false);
  });
});

describe('LineItemSchema', () => {
  const item = {
    ...baseMerge,
    id: uuidv7(),
    transactionId: uuidv7(),
    kind: 'item',
    name: 'Oat latte',
    quantity: 1,
    unitPriceMinor: 550,
    totalMinor: 550,
    position: 0,
  };

  it('accepts an item row', () => {
    expect(LineItemSchema.parse(item).totalMinor).toBe(550);
  });

  it('accepts tax and tip as kinds rather than columns', () => {
    for (const kind of ['tax', 'fee', 'discount', 'tip']) {
      expect(LineItemSchema.safeParse({ ...item, kind }).success, kind).toBe(true);
    }
  });

  it('rejects a zero quantity', () => {
    expect(LineItemSchema.safeParse({ ...item, quantity: 0 }).success).toBe(false);
  });
});

describe('ExtractionSchema', () => {
  const extraction = {
    id: uuidv7(),
    captureId: uuidv7(),
    tier: 2,
    engine: 'vision',
    status: 'done',
    candidate: { totalMinor: 1234, merchant: 'Blue Bottle' },
    confidence: { totalMinor: 0.98, merchant: 0.71 },
    ranAt: now(),
    durationMs: 187,
  };

  it('accepts a completed run', () => {
    expect(ExtractionSchema.parse(extraction).tier).toBe(2);
  });

  it('rejects a tier outside 0..3', () => {
    expect(ExtractionSchema.safeParse({ ...extraction, tier: 4 }).success).toBe(false);
  });

  it('rejects confidence outside 0..1', () => {
    expect(ExtractionSchema.safeParse({ ...extraction, confidence: { total: 1.4 } }).success).toBe(false);
  });

  it('accepts arbitrary candidate shapes, which vary by tier', () => {
    const voice = ExtractionSchema.parse({
      ...extraction,
      tier: 3,
      engine: 'apple-fm',
      candidate: { transcript: 'twelve bucks on coffee', items: [{ name: 'coffee' }] },
    });
    expect(voice.engine).toBe('apple-fm');
  });
});
