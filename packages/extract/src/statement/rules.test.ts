import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import { RULE_SETS, matchRuleSet, provenanceOf, readWithRuleSet } from './rules.js';
import { RULE_SET_FIXTURES } from './fixtures/rule-sets.js';
import { readRows } from './rows.js';
import type { PdfDocument } from './layout.js';

/**
 * Every rule set, against its own fixture.
 *
 * The plan asks for a fixture behind each one, and this is what enforces it: a
 * rule set added without evidence fails here rather than in someone's ledger.
 */

describe('the shipped rule sets', () => {
  it('all have a fixture', () => {
    const missing = RULE_SETS.filter((ruleSet) => RULE_SET_FIXTURES[ruleSet.id] === undefined);

    expect(missing.map((ruleSet) => ruleSet.id)).toEqual([]);
  });

  it('all have a unique id', () => {
    const ids = RULE_SETS.map((ruleSet) => ruleSet.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('are all versioned', () => {
    for (const ruleSet of RULE_SETS) {
      expect(ruleSet.version).toBeGreaterThan(0);
    }
  });

  it('are data, with no behaviour hidden inside them', () => {
    // A rule set that could contain a function could not ship as an update.
    for (const ruleSet of RULE_SETS) {
      expect(JSON.parse(JSON.stringify(ruleSet))).toEqual(ruleSet);
    }
  });
});

describe.each(RULE_SETS)('$label', (ruleSet) => {
  const fixture = RULE_SET_FIXTURES[ruleSet.id];
  if (fixture === undefined) throw new Error(`no fixture for ${ruleSet.id}`);

  it('recognises its own statement', () => {
    expect(matchRuleSet(fixture.document)?.id).toBe(ruleSet.id);
  });

  it('reads the table its bank writes', () => {
    const reading = readWithRuleSet(fixture.document, ruleSet);
    expect(reading).toBeDefined();
    if (reading === undefined) return;

    const { rows, problems } = readRows(reading.table, {
      mapping: reading.mapping,
      dateOrder: reading.dateOrder,
      currency: CurrencySchema.parse(reading.currency ?? 'USD'),
      debitsArePositive: reading.debitsArePositive,
    });

    expect(problems).toEqual([]);
    expect(rows).toHaveLength(fixture.expect.count);
    expect(rows.map((row) => row.amountMinor)).toEqual(fixture.expect.amounts);
    expect(rows[0]?.description).toBe(fixture.expect.firstDescription);
    expect(rows[0]?.occurredAt).toBe(fixture.expect.firstOccurredAt);
  });

  it('records which version produced the rows', () => {
    expect(provenanceOf(ruleSet)).toBe(`${ruleSet.id}@${String(ruleSet.version)}`);
  });
});

describe('a statement from a bank with no rule set', () => {
  const unknown: PdfDocument = {
    engine: 'fixture',
    pages: [
      {
        number: 1,
        width: 612,
        height: 792,
        items: [
          { text: 'Some Other Bank', x: 40, y: 40, width: 80, height: 10 },
          { text: 'Date', x: 40, y: 110, width: 20, height: 10 },
          { text: 'Amount', x: 400, y: 110, width: 30, height: 10 },
        ],
      },
    ],
  };

  it('matches nothing rather than the closest thing', () => {
    expect(matchRuleSet(unknown)).toBeUndefined();
  });
});

describe('a bank that changed its layout', () => {
  it('declines rather than reading the wrong columns', () => {
    // The letterhead still identifies the bank, but the table does not match.
    // Guessing here is how a rule set silently starts importing nonsense.
    const renamed: PdfDocument = {
      engine: 'fixture',
      pages: [
        {
          number: 1,
          width: 612,
          height: 792,
          items: [
            { text: 'First National Bank', x: 40, y: 40, width: 100, height: 10 },
            { text: 'When', x: 40, y: 110, width: 25, height: 10 },
            { text: 'What', x: 140, y: 110, width: 25, height: 10 },
            { text: 'How much', x: 420, y: 110, width: 45, height: 10 },
            { text: '2026-03-14', x: 40, y: 130, width: 50, height: 10 },
            { text: 'COFFEE', x: 140, y: 130, width: 35, height: 10 },
            { text: '-4.50', x: 420, y: 130, width: 25, height: 10 },
          ],
        },
      ],
    };

    const ruleSet = matchRuleSet(renamed);
    expect(ruleSet?.id).toBe('example-first-national');
    if (ruleSet === undefined) return;

    expect(readWithRuleSet(renamed, ruleSet)).toBeUndefined();
  });

  it('survives a bank adding a column', () => {
    // Columns are found by name, so a new "Balance" on the end shifts nothing.
    const withBalance: PdfDocument = {
      engine: 'fixture',
      pages: [
        {
          number: 1,
          width: 612,
          height: 792,
          items: [
            { text: 'First National Bank', x: 40, y: 40, width: 100, height: 10 },
            { text: 'Date', x: 40, y: 110, width: 25, height: 10 },
            { text: 'Description', x: 140, y: 110, width: 55, height: 10 },
            { text: 'Amount', x: 420, y: 110, width: 35, height: 10 },
            { text: 'Balance', x: 520, y: 110, width: 35, height: 10 },
            { text: '2026-03-14', x: 40, y: 130, width: 50, height: 10 },
            { text: 'COFFEE', x: 140, y: 130, width: 35, height: 10 },
            { text: '-4.50', x: 420, y: 130, width: 25, height: 10 },
            { text: '1,240.10', x: 520, y: 130, width: 40, height: 10 },
          ],
        },
      ],
    };

    const reading = readWithRuleSet(withBalance, RULE_SETS[0] as never);
    expect(reading).toBeDefined();
    if (reading === undefined) return;

    const { rows } = readRows(reading.table, {
      mapping: reading.mapping,
      dateOrder: reading.dateOrder,
      currency: CurrencySchema.parse('USD'),
    });

    expect(rows[0]?.amountMinor).toBe(450);
  });
});
