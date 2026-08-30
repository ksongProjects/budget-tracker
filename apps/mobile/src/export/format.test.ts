import { describe, expect, it } from 'vitest';
import type { Currency, MinorUnits } from '@budget/schema';
import { toCsv, toReportHtml, totalsByCategory, totalsByCurrency, totalsByMonth } from './format';
import type { ExportRow } from './format';

const usd = 'USD' as Currency;
const jpy = 'JPY' as Currency;

function row(over: Partial<ExportRow> = {}): ExportRow {
  return {
    // Local noon, so a timezone shift cannot move the row to another day.
    occurredAt: new Date(2026, 2, 14, 12, 0, 0).getTime(),
    merchant: 'Blue Bottle',
    category: 'Coffee',
    account: 'Visa',
    amountMinor: 450 as MinorUnits,
    currency: usd,
    note: null,
    source: 'photo',
    confirmedAt: 1,
    ...over,
  };
}

describe('CSV', () => {
  it('writes a header and one line per row', () => {
    const csv = toCsv([row(), row({ merchant: 'Tartine' })]);
    const lines = csv.trimEnd().split('\r\n');

    expect(lines[0]).toBe('Date,Merchant,Category,Account,Amount,Currency,Status,Source,Note');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('2026-03-14,Blue Bottle,Coffee,Visa,4.50,USD,confirmed,photo,');
  });

  it('ends with a newline so the last row is not dropped', () => {
    expect(toCsv([row()]).endsWith('\r\n')).toBe(true);
  });

  it('quotes commas, quotes, and newlines', () => {
    const csv = toCsv([row({ merchant: 'Bar, Grill', note: 'said "fine"\nthen left' })]);

    expect(csv).toContain('"Bar, Grill"');
    expect(csv).toContain('"said ""fine""\nthen left"');
  });

  it('writes amounts a spreadsheet reads as numbers', () => {
    const csv = toCsv([row({ amountMinor: -1234 as MinorUnits })]);
    expect(csv).toContain(',-12.34,USD,');
  });

  it('respects currencies whose minor unit is not 1/100', () => {
    const csv = toCsv([row({ amountMinor: 980 as MinorUnits, currency: jpy })]);
    expect(csv).toContain(',980,JPY,');
  });

  it('marks unconfirmed rows as pending rather than leaving them to be summed', () => {
    expect(toCsv([row({ confirmedAt: null })])).toContain(',pending,');
  });

  it('defuses a merchant name a spreadsheet would run as a formula', () => {
    // A receipt can put anything in this field, and Excel will happily execute
    // it. Prefixing an apostrophe keeps the text and kills the formula.
    const csv = toCsv([row({ merchant: '=HYPERLINK("http://x","click")' })]);

    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csv).not.toContain(',=HYPERLINK');
  });
});

describe('totals', () => {
  it('keeps currencies apart instead of summing them into a meaningless number', () => {
    const totals = totalsByCurrency([
      row({ amountMinor: 450 as MinorUnits }),
      row({ amountMinor: 550 as MinorUnits }),
      row({ amountMinor: 980 as MinorUnits, currency: jpy }),
    ]);

    expect(totals).toEqual([
      { currency: jpy, totalMinor: 980, count: 1 },
      { currency: usd, totalMinor: 1000, count: 2 },
    ]);
  });

  it('groups by month, newest first', () => {
    const months = totalsByMonth([
      row({ occurredAt: new Date(2026, 0, 4, 12).getTime() }),
      row({ occurredAt: new Date(2026, 2, 14, 12).getTime() }),
    ]);

    expect(months.map((month) => month.label)).toEqual(['March 2026', 'January 2026']);
  });

  it('puts uncategorised last however large it is', () => {
    const categories = totalsByCategory([
      row({ category: null, amountMinor: 100_000 as MinorUnits }),
      row({ category: 'Coffee', amountMinor: 450 as MinorUnits }),
      row({ category: 'Rent', amountMinor: 90_000 as MinorUnits }),
    ]);

    expect(categories.map((category) => category.label)).toEqual([
      'Rent',
      'Coffee',
      'Uncategorised',
    ]);
  });
});

describe('report', () => {
  it('says in the document itself that it is not protected', () => {
    const html = toReportHtml([row()], { generatedAt: Date.now(), range: 'All time' });

    expect(html).toContain('not encrypted and not a backup');
  });

  it('escapes markup rather than rendering it', () => {
    const html = toReportHtml([row({ merchant: '<script>alert(1)</script>' })], {
      generatedAt: Date.now(),
      range: 'All time',
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('lists unconfirmed entries but leaves them out of the totals', () => {
    const html = toReportHtml(
      [row({ amountMinor: 450 as MinorUnits }), row({ amountMinor: 90_000 as MinorUnits, confirmedAt: null })],
      { generatedAt: Date.now(), range: 'All time' },
    );

    expect(html).toContain('1 still unconfirmed and not counted in the totals');
    // The confirmed 4.50 is the whole total; the pending 900.00 is not in it.
    expect(html).toContain('>4.50<');
    expect(html).not.toContain('>904.50<');
  });

  it('caps the entry list but still totals every row', () => {
    // Handing the print WebView a row per entry is what took a real device
    // down at 10,000 rows.
    const rows = Array.from({ length: 12 }, (_, index) =>
      row({ amountMinor: 100 as MinorUnits, merchant: `Merchant ${String(index)}` }),
    );

    const html = toReportHtml(rows, {
      generatedAt: Date.now(),
      range: 'All time',
      maxEntries: 5,
    });

    expect(html).toContain('Newest 5 of 12');
    expect(html).toContain('Merchant 4');
    expect(html).not.toContain('Merchant 5');
    // 12 x 1.00 — the cap does not reach the totals.
    expect(html).toContain('>12.00<');
  });

  it('renders an empty ledger without pretending it has totals', () => {
    const html = toReportHtml([], { generatedAt: Date.now(), range: 'All time' });

    expect(html).toContain('No entries in this range.');
    expect(html).toContain('0 entries');
  });
});
