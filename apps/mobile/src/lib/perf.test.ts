import { describe, expect, it } from 'vitest';
import { BUDGETS, measure, measureRepeated, withBudget } from './perf.js';

describe('withBudget', () => {
  it('marks a measurement inside its budget', () => {
    const result = withBudget({ name: 'warm start', ms: 200 });
    expect(result.budgetMs).toBe(BUDGETS['warm start']);
    expect(result.withinBudget).toBe(true);
  });

  it('marks a measurement over its budget', () => {
    expect(withBudget({ name: 'warm start', ms: 900 }).withinBudget).toBe(false);
  });

  it('treats exactly the budget as passing', () => {
    expect(withBudget({ name: 'warm start', ms: 400 }).withinBudget).toBe(true);
  });

  it('reports null rather than a verdict when nothing is budgeted', () => {
    const result = withBudget({ name: 'unbudgeted thing', ms: 10 });
    expect(result.budgetMs).toBeUndefined();
    expect(result.withinBudget).toBeNull();
  });

  it('lets an explicit budget override the table', () => {
    expect(withBudget({ name: 'warm start', ms: 900, budgetMs: 1000 }).withinBudget).toBe(true);
  });
});

describe('measure', () => {
  it('returns the value and the duration', async () => {
    const { value, measurement } = await measure('warm start', () => Promise.resolve(42));
    expect(value).toBe(42);
    expect(measurement.ms).toBeGreaterThanOrEqual(0);
    expect(measurement.name).toBe('warm start');
  });

  it('propagates a failure rather than reporting a fast success', async () => {
    await expect(
      measure('warm start', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });
});

describe('measureRepeated', () => {
  it('runs the work the requested number of times', async () => {
    let calls = 0;
    await measureRepeated('warm start', 5, () => {
      calls += 1;
      return Promise.resolve();
    });
    expect(calls).toBe(5);
  });

  it('reports the median, so one slow run does not decide the verdict', async () => {
    // Timings are wall-clock here, so assert the shape rather than a value.
    const result = await measureRepeated('warm start', 3, () => Promise.resolve(undefined));
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(result.withinBudget).toBe(true);
  });
});

describe('the budget table', () => {
  it('matches the budgets recorded in the implementation plan', () => {
    expect(BUDGETS['cold start to interactive ledger']).toBe(1500);
    expect(BUDGETS['warm start']).toBe(400);
  });

  it('budgets every query at the interaction threshold', () => {
    for (const name of ['ledger page query (50 rows)', 'summary by category', 'full-text search']) {
      expect(BUDGETS[name], name).toBe(50);
    }
  });
});
