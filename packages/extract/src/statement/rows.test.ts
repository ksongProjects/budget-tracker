import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import { parseCsv } from './csv.js';
import { parseDate, parseMoney, readRows } from './rows.js';

const USD = CurrencySchema.parse('USD');
const JPY = CurrencySchema.parse('JPY');
const EUR = CurrencySchema.parse('EUR');

const MAPPING = { date: 0, amount: 1, description: 2 };

function read(csv: string, over: Partial<Parameters<typeof readRows>[1]> = {}) {
  return readRows(parseCsv(csv), {
    mapping: MAPPING,
    dateOrder: 'ymd',
    currency: USD,
    ...over,
  });
}

describe('reading amounts', () => {
  it('reads a plain decimal', () => {
    expect(parseMoney('4.50', USD)).toBe(450);
  });

  it('reads a thousands separator', () => {
    expect(parseMoney('1,234.56', USD)).toBe(123456);
  });

  it('reads the European convention', () => {
    // Same amount, written the other way round. Getting this wrong turns
    // 1234.56 into 1.23, which looks like a plausible transaction.
    expect(parseMoney('1.234,56', USD)).toBe(123456);
  });

  it('treats a lone group separator as thousands, not a fraction', () => {
    expect(parseMoney('1,234', USD)).toBe(123400);
    expect(parseMoney('1.234', USD)).toBe(123400);
  });

  it('reads accounting parentheses as negative', () => {
    expect(parseMoney('(4.50)', USD)).toBe(-450);
  });

  it('ignores a currency symbol on either side', () => {
    expect(parseMoney('$4.50', USD)).toBe(450);
    expect(parseMoney('4,50 €', EUR)).toBe(450);
  });

  it('respects a currency with no minor unit', () => {
    expect(parseMoney('980', JPY)).toBe(980);
  });

  it('refuses what it cannot read rather than returning zero', () => {
    // A zero would import as a real transaction of no value, which is worse
    // than a row the user is asked about.
    expect(parseMoney('', USD)).toBeUndefined();
    expect(parseMoney('n/a', USD)).toBeUndefined();
    expect(parseMoney('--', USD)).toBeUndefined();
  });
});

describe('reading dates', () => {
  it('reads ISO whatever order was asked for', () => {
    expect(parseDate('2026-03-14', 'dmy')).toBe(Date.UTC(2026, 2, 14, 12));
  });

  it('reads the order it is told', () => {
    // The same eight characters, two different days. Nothing in the file says
    // which, so it is a setting rather than a guess.
    expect(parseDate('03/04/2026', 'dmy')).toBe(Date.UTC(2026, 3, 3, 12));
    expect(parseDate('03/04/2026', 'mdy')).toBe(Date.UTC(2026, 2, 4, 12));
  });

  it('reads two-digit years the way every other tool does', () => {
    expect(parseDate('14/03/26', 'dmy')).toBe(Date.UTC(2026, 2, 14, 12));
    expect(parseDate('14/03/98', 'dmy')).toBe(Date.UTC(1998, 2, 14, 12));
  });

  it('lands at midday so a timezone cannot move the day', () => {
    // Stored at midnight, this row shows as the previous day for anyone west of
    // UTC the moment it is rendered in local time.
    expect(new Date(parseDate('2026-03-14', 'ymd') ?? 0).getUTCHours()).toBe(12);
  });

  it('refuses a date that does not exist', () => {
    expect(parseDate('31/02/2026', 'dmy')).toBeUndefined();
    expect(parseDate('2026-13-01', 'ymd')).toBeUndefined();
    expect(parseDate('sometime', 'dmy')).toBeUndefined();
  });
});

describe('reading rows', () => {
  it('reads a statement into transactions', () => {
    const { rows, problems } = read('Date,Amount,Description\n2026-03-14,-4.50,Blue Bottle\n');

    expect(problems).toEqual([]);
    expect(rows[0]).toEqual({
      line: 2,
      occurredAt: Date.UTC(2026, 2, 14, 12),
      description: 'Blue Bottle',
      amountMinor: 450,
      currency: USD,
    });
  });

  it('flips the sign so spending is positive in the ledger', () => {
    // Banks write spending negative; this app records what was spent. A file
    // from a bank that does it the other way is a setting, not a guess.
    const negative = read('Date,Amount,Description\n2026-03-14,-4.50,Coffee\n');
    const positive = read('Date,Amount,Description\n2026-03-14,4.50,Coffee\n', {
      debitsArePositive: true,
    });

    expect(negative.rows[0]?.amountMinor).toBe(450);
    expect(positive.rows[0]?.amountMinor).toBe(450);
  });

  it('reads split debit and credit columns', () => {
    const { rows } = readRows(
      parseCsv('Date,Debit,Credit,Description\n2026-03-14,4.50,,Coffee\n2026-03-15,,20.00,Refund\n'),
      {
        mapping: { date: 0, amount: 1, credit: 2, description: 3 },
        dateOrder: 'ymd',
        currency: USD,
      },
    );

    expect(rows[0]?.amountMinor).toBe(450);
    expect(rows[1]?.amountMinor).toBe(-2000);
  });

  it('refuses a row with both a debit and a credit', () => {
    const { rows, problems } = readRows(
      parseCsv('Date,Debit,Credit,Description\n2026-03-14,4.50,20.00,Odd\n'),
      {
        mapping: { date: 0, amount: 1, credit: 2, description: 3 },
        dateOrder: 'ymd',
        currency: USD,
      },
    );

    expect(rows).toEqual([]);
    expect(problems[0]?.reason).toContain('amount');
  });

  it('takes a per-row currency when the file states one', () => {
    const { rows } = readRows(
      parseCsv('Date,Amount,Description,Currency\n2026-03-14,-980,Ramen,JPY\n'),
      {
        mapping: { date: 0, amount: 1, description: 2, currency: 3 },
        dateOrder: 'ymd',
        currency: USD,
      },
    );

    expect(rows[0]?.currency).toBe(JPY);
    expect(rows[0]?.amountMinor).toBe(980);
  });

  it('reports a bad row instead of skipping it', () => {
    // A silently dropped row is a ledger that is quietly wrong, which is the
    // failure this whole import path exists to avoid.
    const { rows, problems } = read(
      'Date,Amount,Description\n2026-03-14,-4.50,Coffee\nnot a date,-1.00,Mystery\n',
    );

    expect(rows).toHaveLength(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(3);
    expect(problems[0]?.reason).toContain('date');
  });

  it('numbers problems the way a spreadsheet does', () => {
    const { problems } = read('Date,Amount,Description\nbad,-1.00,One\n');

    // Line 2, because line 1 is the header the user is looking at.
    expect(problems[0]?.line).toBe(2);
  });

  it('refuses a row that does not line up with the header', () => {
    // An unquoted thousands comma shifts every column after it. Read blindly,
    // this row imports as $1.00 to a merchant called "850.00" — a wrong number
    // that looks entirely reasonable.
    const { rows, problems } = read(
      'Date,Amount,Description\n2026-03-16,-1,850.00,RENT MARCH\n',
    );

    expect(rows).toEqual([]);
    expect(problems[0]?.reason).toContain('columns');
  });

  it('refuses a row with no description', () => {
    const { problems } = read('Date,Amount,Description\n2026-03-14,-4.50,\n');

    expect(problems[0]?.reason).toContain('description');
  });
});
