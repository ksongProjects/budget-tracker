import { describe, expect, it } from 'vitest';
import type { MinorUnits } from '@budget/schema';
import { CurrencySchema } from '@budget/schema';
import { findDuplicates, similarityOf } from './dedupe.js';
import type { ExistingRow } from './dedupe.js';
import type { StatementRow } from './rows.js';

const USD = CurrencySchema.parse('USD');
const DAY = 86_400_000;
const MARCH_14 = Date.UTC(2026, 2, 14, 12);

function incoming(over: Partial<StatementRow> = {}): StatementRow {
  return {
    line: 2,
    occurredAt: MARCH_14,
    description: 'BLUE BOTTLE COFFEE',
    amountMinor: 450 as MinorUnits,
    currency: USD,
    ...over,
  };
}

function existing(over: Partial<ExistingRow> = {}): ExistingRow {
  return {
    id: 't-1',
    occurredAt: MARCH_14,
    amountMinor: 450 as MinorUnits,
    description: 'BLUE BOTTLE COFFEE',
    ...over,
  };
}

describe('re-importing a statement', () => {
  it('creates nothing the second time', () => {
    // The acceptance criterion for the whole feature: someone re-downloads a
    // month, or imports the same file twice because they cannot remember.
    const rows = [incoming(), incoming({ line: 3, amountMinor: 1200 as MinorUnits })];
    const ledger = [existing(), existing({ id: 't-2', amountMinor: 1200 as MinorUnits })];

    const result = findDuplicates(rows, ledger);

    expect(result.fresh).toEqual([]);
    expect(result.duplicates).toHaveLength(2);
  });

  it('keeps rows the ledger has never seen', () => {
    const result = findDuplicates([incoming()], []);

    expect(result.fresh).toHaveLength(1);
    expect(result.duplicates).toEqual([]);
  });
});

describe('matching one payment recorded twice', () => {
  it('allows a posting date to move by a day or two', () => {
    // The same payment comes back with a later posted date on a second
    // download. Nothing about it says it is the same row.
    const result = findDuplicates([incoming()], [existing({ occurredAt: MARCH_14 + 2 * DAY })]);

    expect(result.duplicates).toHaveLength(1);
  });

  it('does not reach across a gap that is too wide', () => {
    const result = findDuplicates([incoming()], [existing({ occurredAt: MARCH_14 + 10 * DAY })]);

    expect(result.fresh).toHaveLength(1);
  });

  it('matches through the noise a bank adds', () => {
    const result = findDuplicates(
      [incoming({ description: 'BLUE BOTTLE COFFEE #1234 SEATTLE WA' })],
      [existing({ description: 'Blue Bottle Coffee' })],
    );

    expect(result.duplicates).toHaveLength(1);
  });

  it('keeps different merchants apart at the same amount and day', () => {
    const result = findDuplicates([incoming()], [existing({ description: 'Shell Petrol' })]);

    expect(result.fresh).toHaveLength(1);
  });

  it('never matches two incoming rows to one existing row', () => {
    // Two identical coffees on one day are two coffees. Matching both against
    // one ledger row would drop a real transaction.
    const result = findDuplicates([incoming(), incoming({ line: 3 })], [existing()]);

    expect(result.duplicates).toHaveLength(1);
    expect(result.fresh).toHaveLength(1);
  });

  it('treats a different amount as a different payment', () => {
    const result = findDuplicates([incoming()], [existing({ amountMinor: 451 as MinorUnits })]);

    expect(result.fresh).toHaveLength(1);
  });

  it('does not match a row the ledger has no description for', () => {
    const result = findDuplicates([incoming()], [existing({ description: null })]);

    expect(result.fresh).toHaveLength(1);
  });
});

describe('description similarity', () => {
  it('ignores digits, which is where the noise lives', () => {
    expect(similarityOf('STARBUCKS 0421', 'STARBUCKS 9987')).toBe(1);
  });

  it('scores an unrelated pair at zero', () => {
    expect(similarityOf('Blue Bottle', 'Shell Petrol')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(similarityOf('blue bottle', 'BLUE BOTTLE')).toBe(1);
  });

  it('scores a longer description against the shorter one', () => {
    // "STARBUCKS" and "STARBUCKS STORE SEATTLE" are the same merchant; scoring
    // against the union would push them apart for being verbose.
    expect(similarityOf('STARBUCKS', 'STARBUCKS STORE SEATTLE')).toBe(1);
  });

  it('has nothing to say about an empty description', () => {
    expect(similarityOf('', 'Blue Bottle')).toBe(0);
  });
});
