import { describe, expect, it, vi } from 'vitest';
import { CurrencySchema, parseAmount } from '@budget/schema';
import { createScriptedEngine, createUnavailableEngine } from './doubles.js';
import { applyRules, structureCapture } from './route.js';
import type { StructuringEngine, StructuringRequest } from './types.js';

const USD = CurrencySchema.parse('USD');
const NOW = Date.UTC(2026, 7, 30, 12);

const RECEIPT = ['BLUE BOTTLE COFFEE', 'Latte 4.50', 'TAX 0.72', 'TOTAL 8.97'].join('\n');

function receipt(text = RECEIPT): StructuringRequest {
  return { text, kind: 'receipt', defaultCurrency: USD, now: NOW };
}

const modelAnswer = JSON.stringify({
  merchant: 'BLUE BOTTLE COFFEE',
  total: '8.97',
  tax: '0.72',
  lineItems: [{ description: 'Latte', amount: '4.50' }],
});

describe('applyRules', () => {
  it('reads a receipt with no model at all', () => {
    const candidate = applyRules(receipt());

    expect(candidate.total?.value).toBe(parseAmount('8.97', USD));
    expect(candidate.engine).toBe('rules');
  });

  it('reads a spoken spend with no model at all', () => {
    const candidate = applyRules({
      text: 'twelve bucks on coffee at blue bottle',
      kind: 'utterance',
      defaultCurrency: USD,
      now: NOW,
    });

    expect(candidate.total?.value).toBe(parseAmount('12.00', USD));
    expect(candidate.merchant?.value).toBe('blue bottle');
  });

  it('proposes no line items, which is the detail Tier 3 exists to add', () => {
    expect(applyRules(receipt()).lineItems).toBeUndefined();
  });
});

describe('structureCapture', () => {
  it('uses an on-device model when there is one', async () => {
    const engine = createScriptedEngine({ name: 'on-device', respond: () => modelAnswer });
    const candidate = await structureCapture(receipt(), { engines: [engine] });

    expect(candidate.engine).toBe('on-device');
    expect(candidate.lineItems).toHaveLength(1);
  });

  it('falls back to the rules on a device with no model', async () => {
    const engine = createUnavailableEngine('on-device', 'This phone has no on-device model.');
    const candidate = await structureCapture(receipt(), { engines: [engine] });

    // The floor, not an error path: total, tax and merchant still arrive.
    expect(candidate.engine).toBe('rules');
    expect(candidate.total?.value).toBe(parseAmount('8.97', USD));
  });

  it('falls back when a model is present but returns nothing usable', async () => {
    const engine = createScriptedEngine({ name: 'on-device', respond: () => 'I am not sure.' });
    const candidate = await structureCapture(receipt(), { engines: [engine] });

    expect(candidate.engine).toBe('rules');
  });

  it('falls back, and reports, when a model throws', async () => {
    const onError = vi.fn();
    const broken: StructuringEngine = {
      name: 'on-device',
      remote: false,
      capability: () => Promise.resolve({ availability: 'ready' }),
      structure: () => Promise.reject(new Error('out of memory')),
    };

    const candidate = await structureCapture(receipt(), { engines: [broken], onError });

    expect(candidate.engine).toBe('rules');
    expect(onError).toHaveBeenCalledWith('on-device', expect.any(Error));
  });

  it('keeps what the rules found where the model was silent', async () => {
    // The model reads the items and forgets the merchant; the rules had it.
    const engine = createScriptedEngine({
      name: 'on-device',
      respond: () => JSON.stringify({ total: '8.97', lineItems: [{ description: 'Latte', amount: '4.50' }] }),
    });

    const candidate = await structureCapture(receipt(), { engines: [engine] });

    expect(candidate.engine).toBe('on-device');
    expect(candidate.merchant?.value).toBe('BLUE BOTTLE COFFEE');
  });

  it('prefers the model where both read the same field', async () => {
    const engine = createScriptedEngine({
      name: 'on-device',
      respond: () => JSON.stringify({ total: '8.25', lineItems: [{ description: 'Latte', amount: '4.50' }] }),
    });

    const candidate = await structureCapture(receipt(), { engines: [engine] });

    // Two totals on one screen is worse than either. The model wins, because
    // its number is the one the shown line items belong to.
    expect(candidate.total?.value).toBe(parseAmount('8.25', USD));
  });

  it('tries engines in order and stops at the first that reads something', async () => {
    const first = createScriptedEngine({
      name: 'first',
      respond: () => '{}',
      capability: { availability: 'downloadable', reason: 'not fetched yet' },
    });
    const second = createScriptedEngine({ name: 'second', respond: () => modelAnswer });

    const candidate = await structureCapture(receipt(), { engines: [first, second] });

    expect(candidate.engine).toBe('second');
  });
});

describe('consent gating in the router', () => {
  const remote = (respond: () => string): StructuringEngine =>
    createScriptedEngine({ name: 'cloud-assist', remote: true, respond });

  it('never consults a remote engine without consent for this capture', async () => {
    const respond = vi.fn(() => modelAnswer);
    const candidate = await structureCapture(receipt(), { engines: [remote(respond)] });

    expect(respond).not.toHaveBeenCalled();
    expect(candidate.engine).toBe('rules');
  });

  it('consults it when the user has just said yes', async () => {
    const candidate = await structureCapture(
      { ...receipt(), consent: { grantedAt: NOW, approvedText: RECEIPT } },
      { engines: [remote(() => modelAnswer)] },
    );

    expect(candidate.engine).toBe('cloud-assist');
  });
});
