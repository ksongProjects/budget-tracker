import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import type { MinorUnits } from '@budget/schema';
import { guessMapping, isComplete, parseCsv } from './csv.js';
import { readRows } from './rows.js';
import { findDuplicates } from './dedupe.js';
import type { ExistingRow } from './dedupe.js';

/**
 * Three banks, three sets of habits, one import path.
 *
 * The files below are written the way real exports are — different column
 * names, different date order, split debit and credit columns, an accounting
 * negative, a thousands separator — without being anyone's real statement. The
 * corpus of genuine files stays out of the repository (docs/extraction.md); the
 * conventions do not have to.
 */

const USD = CurrencySchema.parse('USD');

const PLAIN = `Date,Description,Amount
2026-03-14,BLUE BOTTLE COFFEE #1234,-4.50
2026-03-15,"SAFEWAY #0421, SEATTLE",-62.18
2026-03-16,RENT MARCH,"-1,850.00"
`;

const SPLIT = `Posted Date,Narrative,Debit,Credit,Balance
03/14/2026,BLUE BOTTLE COFFEE 1234,4.50,,1000.00
03/16/2026,SALARY,,2500.00,3500.00
`;

describe('a plain export', () => {
  const table = parseCsv(PLAIN);

  it('maps itself', () => {
    const guess = guessMapping(table.header);
    expect(isComplete(guess)).toBe(true);
  });

  it('reads every row', () => {
    const guess = guessMapping(table.header);
    if (!isComplete(guess)) throw new Error('mapping incomplete');

    const { rows, problems } = readRows(table, {
      mapping: guess,
      dateOrder: 'ymd',
      currency: USD,
    });

    expect(problems).toEqual([]);
    expect(rows.map((row) => row.amountMinor)).toEqual([450, 6218, 185000]);
  });
});

describe('an export from a bank that writes dates and decimals the other way', () => {
  it('reads once told which way that is', () => {
    // Semicolon-separated is a different parser problem and is not claimed
    // here; this checks the date and decimal conventions, which are.
    const table = parseCsv('Date,Description,Amount\n14.03.2026,BLUE BOTTLE,"-4,50"\n');

    const { rows, problems } = readRows(table, {
      mapping: { date: 0, description: 1, amount: 2 },
      dateOrder: 'dmy',
      currency: USD,
    });

    expect(problems).toEqual([]);
    expect(rows[0]?.occurredAt).toBe(Date.UTC(2026, 2, 14, 12));
    expect(rows[0]?.amountMinor).toBe(450);
  });

  it('is a different day if told the wrong order', () => {
    // Worth pinning: this is the failure that silently moves a month of
    // spending, and nothing in the file itself would reveal it.
    const table = parseCsv('Date,Description,Amount\n03/04/2026,X,-1.00\n');
    const options = { mapping: { date: 0, description: 1, amount: 2 }, currency: USD } as const;

    const dmy = readRows(table, { ...options, dateOrder: 'dmy' }).rows[0]?.occurredAt;
    const mdy = readRows(table, { ...options, dateOrder: 'mdy' }).rows[0]?.occurredAt;

    expect(dmy).not.toBe(mdy);
  });
});

describe('an export with split debit and credit columns', () => {
  const table = parseCsv(SPLIT);

  it('guesses both money columns', () => {
    const guess = guessMapping(table.header);

    expect(guess.amount).toBe(2);
    expect(guess.credit).toBe(3);
  });

  it('reads money out as spending and money in as its opposite', () => {
    const { rows, problems } = readRows(table, {
      mapping: { date: 0, description: 1, amount: 2, credit: 3 },
      dateOrder: 'mdy',
      currency: USD,
    });

    expect(problems).toEqual([]);
    expect(rows.map((row) => row.amountMinor)).toEqual([450, -250000]);
  });
});

describe('importing the same file twice', () => {
  it('adds nothing the second time', () => {
    const table = parseCsv(PLAIN);
    const guess = guessMapping(table.header);
    if (!isComplete(guess)) throw new Error('mapping incomplete');

    const first = readRows(table, { mapping: guess, dateOrder: 'ymd', currency: USD }).rows;

    // The ledger, as it would look after the first import.
    const ledger: ExistingRow[] = first.map((row, index) => ({
      id: `t-${String(index)}`,
      occurredAt: row.occurredAt,
      amountMinor: row.amountMinor,
      description: row.description,
    }));

    const second = findDuplicates(first, ledger);

    expect(second.fresh).toEqual([]);
    expect(second.duplicates).toHaveLength(first.length);
  });

  it('still takes the rows that are genuinely new', () => {
    const table = parseCsv(PLAIN);
    const rows = readRows(table, {
      mapping: { date: 0, description: 1, amount: 2 },
      dateOrder: 'ymd',
      currency: USD,
    }).rows;

    const ledger: ExistingRow[] = [
      {
        id: 't-0',
        occurredAt: rows[0]?.occurredAt ?? 0,
        amountMinor: (rows[0]?.amountMinor ?? 0) as MinorUnits,
        description: rows[0]?.description ?? null,
      },
    ];

    const result = findDuplicates(rows, ledger);

    expect(result.duplicates).toHaveLength(1);
    expect(result.fresh).toHaveLength(rows.length - 1);
  });
});

describe('an unmapped file', () => {
  it('says so rather than importing under a guess', () => {
    const guess = guessMapping(['Col1', 'Col2', 'Col3']);

    expect(isComplete(guess)).toBe(false);
    expect(guess.unmatched).toEqual(['Col1', 'Col2', 'Col3']);
  });
});
