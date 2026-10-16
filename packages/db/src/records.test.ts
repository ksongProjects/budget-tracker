import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import type { CaptureId, DeviceId, MinorUnits, Timestamp } from '@budget/schema';
import { createNodeDriver } from './drivers/node.js';
import type { SqliteDriver } from './driver.js';
import { migrate } from './migrate.js';
import type { RepositoryContext } from './context.js';
import { RecordRepository, createCapture } from './records.js';
import { ExtractionRepository, confidenceOf } from './extractions.js';
import { commitImport, previewImport } from './statements.js';
import { LineItemRepository } from './line-items.js';

const USD = CurrencySchema.parse('USD');
const money = (n: number): MinorUnits => n as MinorUnits;
const at = (ms: number): Timestamp => ms as Timestamp;

let driver: SqliteDriver;
let ctx: RepositoryContext;
let records: RecordRepository;
let clockValue = 1_700_000_000_000;

beforeEach(async () => {
  clockValue = 1_700_000_000_000;
  driver = createNodeDriver();
  await migrate(driver);
  ctx = { driver, deviceId: 'device-a' as DeviceId, clock: () => (clockValue += 1) as Timestamp };
  records = new RecordRepository(ctx);
});

afterEach(async () => {
  await driver.close();
});

describe('a record', () => {
  it('has a date, a merchant, its items and a total', async () => {
    const captureId = await createCapture(ctx, 'photo');
    const id = await records.write({
      captureId,
      source: 'photo',
      date: at(1_699_000_000_000),
      merchant: 'BLUE BOTTLE COFFEE #12',
      items: [
        { kind: 'item', name: 'Latte', quantity: 1, unitPriceMinor: null, totalMinor: money(550) },
        { kind: 'tax', name: 'Tax', quantity: null, unitPriceMinor: null, totalMinor: money(50) },
      ],
      amountMinor: money(600),
      currency: USD,
      confirmed: true,
    });

    const record = await records.get(id);
    expect(record).toMatchObject({
      date: 1_699_000_000_000,
      merchant: 'Blue Bottle Coffee',
      total: { amountMinor: 600, currency: 'USD' },
      source: 'photo',
      reconciled: true,
    });
    expect(record?.items.map((item) => [item.name, item.totalMinor, item.implied])).toEqual([
      ['Latte', 550, false],
      ['Tax', 50, false],
    ]);
    expect(record?.confirmedAt).not.toBeNull();
  });

  it('with no breakdown still has one item, the whole of it, and stores none', async () => {
    const id = await records.write({
      captureId: await createCapture(ctx, 'manual'),
      source: 'manual',
      date: at(1_699_000_000_000),
      amountMinor: money(1250),
      currency: USD,
      note: 'lunch',
      confirmed: true,
    });

    const record = await records.get(id);
    expect(record?.items).toEqual([
      {
        kind: 'item',
        name: 'lunch',
        quantity: null,
        unitPriceMinor: null,
        totalMinor: 1250,
        implied: true,
      },
    ]);
    expect(record?.merchant).toBeNull();
    expect(record?.reconciled).toBe(false);
    // Implied, not written: a stored copy would be minted again on another
    // device and duplicated by the next merge.
    expect(await new LineItemRepository(ctx).listFor(id)).toEqual([]);
  });

  it('keeps the source it came from', async () => {
    const id = await records.write({
      captureId: await createCapture(ctx, 'voice'),
      source: 'voice',
      date: at(1_699_000_000_000),
      merchant: 'Shell',
      amountMinor: money(4000),
      currency: USD,
      confirmed: true,
    });

    expect((await records.get(id))?.source).toBe('voice');
    const capture = await driver.get<{ kind: string }>(
      'SELECT c.kind FROM captures c JOIN transactions t ON t.capture_id = c.capture_id WHERE t.id = ?',
      [id],
    );
    expect(capture?.kind).toBe('voice');
  });

  it('writes several from one capture, or none of them', async () => {
    const captureId = await createCapture(ctx, 'voice');
    const base = {
      captureId,
      source: 'voice' as const,
      date: at(1_699_000_000_000),
      currency: USD,
      confirmed: true,
    };

    await expect(
      records.writeAll([
        { ...base, merchant: 'Blue Bottle', amountMinor: money(750) },
        // Not an integer: the schema refuses it, after the first was written.
        { ...base, merchant: 'Shell', amountMinor: money(40.5) },
      ]),
    ).rejects.toThrow();

    const count = await driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(count?.n).toBe(0);

    const ids = await records.writeAll([
      { ...base, merchant: 'Blue Bottle', amountMinor: money(750) },
      { ...base, merchant: 'Shell', amountMinor: money(4000) },
    ]);
    expect(ids).toHaveLength(2);
  });

  it('leaves a merchant out when the name normalizes to nothing', async () => {
    const id = await records.write({
      captureId: await createCapture(ctx, 'manual'),
      source: 'manual',
      date: at(1_699_000_000_000),
      merchant: '*** ',
      amountMinor: money(100),
      currency: USD,
      confirmed: true,
    });

    expect((await records.get(id))?.merchantId).toBeNull();
  });
});

describe('extractions', () => {
  it('are kept per capture, newest first, with per-field confidence', async () => {
    const captureId = await createCapture(ctx, 'photo');
    const repo = new ExtractionRepository(ctx);

    const candidate = {
      total: { value: 600, confidence: 0.9, evidence: 'TOTAL 6.00' },
      merchant: { value: 'Blue Bottle', confidence: 0.6, evidence: 'BLUE BOTTLE' },
      tip: undefined,
    };
    await repo.record({
      captureId,
      tier: 2,
      engine: 'mlkit',
      candidate,
      confidence: confidenceOf(candidate),
      durationMs: 412.4,
    });
    await repo.record({ captureId, tier: 3, engine: 'gemini-nano', candidate: {}, durationMs: 900 });

    const runs = await repo.listFor(captureId);
    expect(runs.map((run) => [run.tier, run.engine])).toEqual([
      [3, 'gemini-nano'],
      [2, 'mlkit'],
    ]);
    expect(runs[1]?.confidence).toEqual({ total: 0.9, merchant: 0.6 });
    expect(runs[1]?.durationMs).toBe(412);
    expect(runs[1]?.candidate).not.toHaveProperty('tip');
  });
});

describe('a statement import', () => {
  const table = {
    header: ['Transaction Date', 'Posted Date', 'Description', 'Amount'],
    rows: [
      ['2026-03-01', '2026-03-03', 'SQ *BLUE BOTTLE 0412', '-4.50'],
      ['2026-03-02', 'garbled', 'SHELL OIL 57442', '-40.00'],
    ],
  };
  const settings = {
    mapping: { date: 0, posted: 1, description: 2, amount: 3 },
    dateOrder: 'ymd' as const,
    currency: USD,
  };

  it('makes one record per row, with a merchant, a posted date and an account', async () => {
    const preview = await previewImport(ctx, table, settings);
    expect(preview.fresh).toHaveLength(2);

    const account = await driver.run(
      `INSERT INTO accounts (id, name, currency, rev, updated_at, origin_device)
       VALUES ('0190a000-0000-7000-8000-000000000001', 'Checking', 'USD', 1, 1, 'device-a')`,
    );
    void account;

    const result = await commitImport(ctx, preview.fresh, {
      accountId: '0190a000-0000-7000-8000-000000000001' as never,
    });

    const rows = await driver.all<{
      id: string;
      merchant: string | null;
      note: string;
      posted_at: number | null;
      account_id: string | null;
      confirmed_at: number | null;
    }>(
      `SELECT t.id, m.canonical_name AS merchant, t.note, t.posted_at, t.account_id, t.confirmed_at
       FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id
       ORDER BY t.occurred_at`,
    );

    expect(rows.map((row) => row.merchant)).toEqual(['Blue Bottle', 'Shell Oil']);
    // The bank's words survive the cleaning.
    expect(rows.map((row) => row.note)).toEqual(['SQ *BLUE BOTTLE 0412', 'SHELL OIL 57442']);
    // Statement days are read as noon UTC, so no timezone moves them a day.
    expect(rows[0]?.posted_at).toBe(Date.UTC(2026, 2, 3, 12));
    // An unreadable posting date costs the row nothing.
    expect(rows[1]?.posted_at).toBeNull();
    expect(rows.every((row) => row.account_id === '0190a000-0000-7000-8000-000000000001')).toBe(
      true,
    );
    expect(rows.every((row) => row.confirmed_at === null)).toBe(true);

    const runs = await new ExtractionRepository(ctx).listFor(result.captureId as CaptureId);
    expect(runs.map((run) => [run.tier, run.engine])).toEqual([[0, 'csv']]);
  });

  it('still recognises its own rows when the same file comes in again', async () => {
    const first = await previewImport(ctx, table, settings);
    await commitImport(ctx, first.fresh);

    const again = await previewImport(ctx, table, settings);
    expect(again.fresh).toHaveLength(0);
    expect(again.duplicates).toHaveLength(2);
  });
});
