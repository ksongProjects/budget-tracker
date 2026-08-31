import { describe, expect, it } from 'vitest';
import { CurrencySchema } from '@budget/schema';
import { createScriptedEngine } from './doubles.js';
import { STRUCTURING_FIXTURES } from './fixtures.js';
import { formatScore, rate, scoreEngine } from './score.js';
import { applyRules } from './route.js';
import type { StructuringEngine, StructuringRequest } from './types.js';

/**
 * Two adapters, one suite.
 *
 * The plan's acceptance for Tier 3 is that the same fixture suite scores both
 * OS models. Neither runs in CI, so their place is taken by doubles that write
 * what a model writes — one careful, one with the habits small models actually
 * have. What is under test is the *harness*: that it can tell them apart, and
 * that the number it produces means something.
 */

const USD = CurrencySchema.parse('USD');

/** A model that reads each fixture correctly and returns clean JSON. */
const CAREFUL: Readonly<Record<string, unknown>> = {
  'cafe-with-items': {
    merchant: 'BLUE BOTTLE COFFEE',
    date: '2026-08-29',
    currency: 'USD',
    total: '8.97',
    tax: '0.72',
    lineItems: [
      { description: 'Latte', amount: '4.50' },
      { description: 'Croissant', amount: '3.75' },
    ],
  },
  'restaurant-with-tip': {
    merchant: 'TARTINE MANUFACTORY',
    currency: 'USD',
    total: '26.39',
    tax: '1.79',
    tip: '4.10',
    lineItems: [
      { description: 'Morning bun', amount: '5.50' },
      { description: 'Country loaf', amount: '11.00' },
      { description: 'Coffee', amount: '4.00' },
    ],
  },
  'discounted-basket': {
    merchant: 'SAFEWAY 0421',
    date: '2026-08-29',
    currency: 'USD',
    total: '22.77',
    lineItems: [
      { description: 'Milk 2%', amount: '4.29' },
      { description: 'Eggs dozen', amount: '6.49' },
      { description: 'Coffee beans', amount: '14.99' },
    ],
  },
  'ocr-split-columns': {
    merchant: 'MUNI',
    date: '2026-08-29',
    currency: 'USD',
    total: '2.75',
  },
  'euro-comma-decimal': {
    merchant: 'BÄCKEREI SCHMIDT',
    currency: 'EUR',
    total: '6,00',
    lineItems: [
      { description: 'Brötchen', amount: '2,40' },
      { description: 'Kaffee', amount: '3,60' },
    ],
  },
  'spoken-coffee': { merchant: 'blue bottle', currency: 'USD', total: '12.00' },
  'spoken-two-numbers': {
    merchant: 'tartine',
    currency: 'USD',
    total: '4.50',
    date: '2026-08-29',
  },
  'spoken-no-amount': {},
};

/**
 * A model with the habits of a 3B on a phone: prose around the JSON, a
 * currency symbol inside the amount, a merchant it recognised rather than
 * read, and a tendency to skip the line items when the receipt is long.
 */
const SLOPPY: Readonly<Record<string, unknown>> = {
  'cafe-with-items': {
    merchant: 'Starbucks',
    date: '2026-08-29',
    currency: 'USD',
    total: '$8.97',
    tax: '$0.72',
  },
  'restaurant-with-tip': { merchant: 'TARTINE MANUFACTORY', total: '$26.39', tax: '$1.79' },
  'discounted-basket': { merchant: 'SAFEWAY 0421', total: '$25.77' },
  'ocr-split-columns': { merchant: 'MUNI', total: '$2.75', date: '2026-08-29' },
  'euro-comma-decimal': { merchant: 'BÄCKEREI SCHMIDT', currency: 'EUR', total: '6.00' },
  'spoken-coffee': { merchant: 'blue bottle', total: '12' },
  'spoken-two-numbers': { merchant: 'tartine', total: '450' },
  'spoken-no-amount': { merchant: 'hardware store', total: '0.00' },
};

function fixtureFor(request: StructuringRequest): string {
  const match = STRUCTURING_FIXTURES.find((fixture) => fixture.text === request.text);
  return match?.id ?? '';
}

function scripted(name: string, answers: Readonly<Record<string, unknown>>, wrap = false) {
  return createScriptedEngine({
    name,
    durationMs: 40,
    respond: (request) => {
      const answer = JSON.stringify(answers[fixtureFor(request)] ?? {});
      return wrap ? `Sure! Here is the JSON:\n\`\`\`json\n${answer}\n\`\`\`` : answer;
    },
  });
}

/** The rules, dressed as an engine, so the floor is scored by the same harness. */
const rulesEngine: StructuringEngine = {
  name: 'rules',
  remote: false,
  capability: () => Promise.resolve({ availability: 'ready' }),
  structure: (request) => Promise.resolve(applyRules(request)),
};

describe('scoring an engine', () => {
  it('gives a careful model a high mark on every field', async () => {
    const score = await scoreEngine(scripted('careful', CAREFUL), { defaultCurrency: USD });

    expect(score.accuracy).toBe(1);
    expect(score.misses).toEqual([]);
    expect(score.fixtures).toBe(STRUCTURING_FIXTURES.length);
    expect(score.averageMs).toBe(40);
  });

  it('marks the same suite against a sloppier one and separates them', async () => {
    const careful = await scoreEngine(scripted('careful', CAREFUL), { defaultCurrency: USD });
    const sloppy = await scoreEngine(scripted('sloppy', SLOPPY, true), { defaultCurrency: USD });

    expect(sloppy.accuracy).toBeLessThan(careful.accuracy);
    expect(sloppy.misses.length).toBeGreaterThan(0);
  });

  it('still reads the amount out of prose and a currency symbol', async () => {
    const sloppy = await scoreEngine(scripted('sloppy', SLOPPY, true), { defaultCurrency: USD });

    // The validation layer's job: the wrapping and the "$" are noise, and the
    // number underneath them is right.
    expect(rate(sloppy, 'amount')).toBeGreaterThan(0.5);
  });

  it('catches the invented merchant and the missing breakdown', async () => {
    const sloppy = await scoreEngine(scripted('sloppy', SLOPPY, true), { defaultCurrency: USD });

    expect(sloppy.misses).toContainEqual(
      expect.objectContaining({ fixture: 'cafe-with-items', field: 'merchant' }),
    );
    expect(sloppy.misses).toContainEqual(
      expect.objectContaining({ fixture: 'cafe-with-items', field: 'lineItems' }),
    );
  });

  it('penalises an amount invented for a sentence that named none', async () => {
    const sloppy = await scoreEngine(scripted('sloppy', SLOPPY, true), { defaultCurrency: USD });

    // "I bought something at the hardware store" has no number in it, and a
    // model that answers 0.00 has made one up.
    expect(sloppy.misses).toContainEqual(
      expect.objectContaining({ fixture: 'spoken-no-amount', field: 'amount' }),
    );
  });

  it('scores the rules floor, which is what a phone with no model gets', async () => {
    const score = await scoreEngine(rulesEngine, { defaultCurrency: USD });

    // Not a target — a baseline. Tier 3 has to beat this to be worth running,
    // and this is the number that says whether it does.
    expect(rate(score, 'amount')).toBeGreaterThan(0.5);
    expect(rate(score, 'lineItems')).toBeLessThan(1);
  });

  it('reports itself in a form a person can read', async () => {
    const score = await scoreEngine(scripted('careful', CAREFUL), { defaultCurrency: USD });
    const report = formatScore(score);

    expect(report).toContain('careful: 100%');
    expect(report).toContain('amount:');
  });
});
