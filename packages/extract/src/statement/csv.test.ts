import { describe, expect, it } from 'vitest';
import { guessMapping, isComplete, parseCsv } from './csv.js';

describe('parsing CSV', () => {
  it('reads a plain file', () => {
    const table = parseCsv('Date,Amount,Description\n2026-03-14,-4.50,Blue Bottle\n');

    expect(table.header).toEqual(['Date', 'Amount', 'Description']);
    expect(table.rows).toEqual([['2026-03-14', '-4.50', 'Blue Bottle']]);
  });

  it('keeps commas inside quoted fields', () => {
    const table = parseCsv('Date,Description\n2026-03-14,"Bar, Grill"\n');

    expect(table.rows[0]).toEqual(['2026-03-14', 'Bar, Grill']);
  });

  it('unescapes doubled quotes', () => {
    const table = parseCsv('Description\n"He said ""fine"""\n');

    expect(table.rows[0]).toEqual(['He said "fine"']);
  });

  it('handles a quoted field that spans lines', () => {
    // Banks that allow a multi-line memo export exactly this.
    const table = parseCsv('Description,Amount\n"first\nsecond",-4.50\n');

    expect(table.rows).toEqual([['first\nsecond', '-4.50']]);
  });

  it('reads Windows line endings', () => {
    const table = parseCsv('Date,Amount\r\n2026-03-14,-4.50\r\n');

    expect(table.rows).toEqual([['2026-03-14', '-4.50']]);
  });

  it('survives a byte-order mark', () => {
    // It comes through every export path, and left in place it becomes part of
    // the first column's name so nothing matches it.
    const table = parseCsv('﻿Date,Amount\n2026-03-14,-4.50\n');

    expect(table.header[0]).toBe('Date');
  });

  it('ignores a trailing newline rather than inventing a row', () => {
    expect(parseCsv('Date\n2026-03-14\n\n').rows).toEqual([['2026-03-14']]);
  });

  it('keeps empty cells', () => {
    expect(parseCsv('a,b,c\n1,,3\n').rows[0]).toEqual(['1', '', '3']);
  });

  it('reads a last row with no newline after it', () => {
    expect(parseCsv('a,b\n1,2').rows).toEqual([['1', '2']]);
  });
});

describe('guessing the columns', () => {
  it('places the obvious ones', () => {
    const guess = guessMapping(['Date', 'Description', 'Amount']);

    expect(guess.date).toBe(0);
    expect(guess.description).toBe(1);
    expect(guess.amount).toBe(2);
    expect(isComplete(guess)).toBe(true);
  });

  it('matches names a bank actually uses', () => {
    const guess = guessMapping(['Posted Date', 'Narrative', 'Debit', 'Credit', 'Balance']);

    expect(guess.date).toBe(0);
    expect(guess.description).toBe(1);
    expect(guess.amount).toBe(2);
    expect(guess.credit).toBe(3);
  });

  it('falls back to a contained word', () => {
    const guess = guessMapping(['Transaction Date', 'Transaction Amount (USD)', 'Payee']);

    expect(guess.date).toBe(0);
    expect(guess.amount).toBe(1);
    expect(guess.description).toBe(2);
  });

  it('never gives one column two jobs', () => {
    // "Date" also contains no other keyword, but a header like this one is
    // where a careless matcher assigns the same index twice and drops a field.
    const guess = guessMapping(['Date', 'Value Date', 'Value', 'Details']);
    const used = [guess.date, guess.amount, guess.description].filter(
      (index): index is number => index !== undefined,
    );

    expect(new Set(used).size).toBe(used.length);
  });

  it('reports what it could not place, for the user to map', () => {
    const guess = guessMapping(['Date', 'Amount', 'Description', 'Balance', 'Reference']);

    expect(guess.unmatched).toEqual(['Balance', 'Reference']);
  });

  it('is incomplete when a required column is missing', () => {
    const guess = guessMapping(['When', 'How much', 'What']);

    expect(isComplete(guess)).toBe(false);
  });
});
