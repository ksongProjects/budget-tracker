import { STRUCTURING_FIXTURES, FIXTURE_NOW } from './fixtures.js';
import type { StructuringFixture } from './fixtures.js';
import type { Currency } from '@budget/schema';
import type { StructuredCandidate, StructuringEngine } from './types.js';

/**
 * Marking an engine's homework.
 *
 * The plan's acceptance for Tier 3 is that the same fixture suite scores every
 * adapter, and this is that scoring — one function, one corpus, run against
 * Apple's model, Gemini Nano, the cloud path, or a double standing in for any
 * of them in CI. Comparable numbers are the whole point: "the on-device model
 * gets the total right nine times in ten and the merchant six" is a decision an
 * app can be built around, and no amount of eyeballing produces it.
 *
 * A field is only marked when the fixture states ground truth for it, so
 * adding an expectation to one fixture never silently penalises the rest.
 */

export type ScoredField =
  | 'amount'
  | 'currency'
  | 'merchant'
  | 'date'
  | 'tax'
  | 'tip'
  | 'lineItems'
  | 'reconciliation';

export interface FieldScore {
  readonly checked: number;
  readonly correct: number;
}

export interface Miss {
  readonly fixture: string;
  readonly field: ScoredField;
  readonly expected: string;
  readonly got: string;
}

export interface EngineScore {
  readonly engine: string;
  readonly fixtures: number;
  readonly fields: Readonly<Record<ScoredField, FieldScore>>;
  readonly misses: readonly Miss[];
  /** Every marked field, correct over checked. */
  readonly accuracy: number;
  readonly averageMs: number;
}

export interface ScoreOptions {
  readonly fixtures?: readonly StructuringFixture[];
  readonly defaultCurrency: Currency;
  readonly now?: number;
}

export async function scoreEngine(
  engine: StructuringEngine,
  options: ScoreOptions,
): Promise<EngineScore> {
  const fixtures = options.fixtures ?? STRUCTURING_FIXTURES;
  const now = options.now ?? FIXTURE_NOW;

  const fields = blankFields();
  const misses: Miss[] = [];
  let totalMs = 0;

  for (const fixture of fixtures) {
    const candidate = await engine.structure({
      text: fixture.text,
      kind: fixture.kind,
      defaultCurrency: options.defaultCurrency,
      now,
    });

    totalMs += candidate.durationMs;
    mark(fixture, candidate, fields, misses);
  }

  const checked = sum(fields, (score) => score.checked);
  const correct = sum(fields, (score) => score.correct);

  return {
    engine: engine.name,
    fixtures: fixtures.length,
    fields,
    misses,
    accuracy: checked === 0 ? 0 : correct / checked,
    averageMs: fixtures.length === 0 ? 0 : totalMs / fixtures.length,
  };
}

function mark(
  fixture: StructuringFixture,
  candidate: StructuredCandidate,
  fields: Record<ScoredField, FieldScore>,
  misses: Miss[],
): void {
  const record = (field: ScoredField, expected: unknown, got: unknown): void => {
    const hit = expected === got;
    const score = fields[field];
    fields[field] = { checked: score.checked + 1, correct: score.correct + (hit ? 1 : 0) };

    if (!hit) {
      misses.push({ fixture: fixture.id, field, expected: show(expected), got: show(got) });
    }
  };

  const wanted = fixture.expect;

  if (wanted.amountMinor !== undefined) {
    record('amount', wanted.amountMinor, candidate.total?.value);
  }
  if (wanted.currency !== undefined) {
    record('currency', wanted.currency, candidate.currency?.value);
  }
  if (wanted.merchant !== undefined) {
    record('merchant', wanted.merchant.toLowerCase(), candidate.merchant?.value.toLowerCase());
  }
  if (wanted.occurredAt !== undefined) {
    // Compared by day, not by instant. A receipt that prints a time gives the
    // rules a timestamp at 09:14 and a model a date at midnight; both read the
    // same day, and marking one of them wrong would be marking the format.
    record('date', day(wanted.occurredAt), day(candidate.occurredAt?.value));
  }
  if (wanted.taxMinor !== undefined) {
    record('tax', wanted.taxMinor, candidate.tax?.value);
  }
  if (wanted.tipMinor !== undefined) {
    record('tip', wanted.tipMinor, candidate.tip?.value);
  }
  if (wanted.lineItemCount !== undefined) {
    record('lineItems', wanted.lineItemCount, candidate.lineItems?.length ?? 0);
  }
  if (wanted.balanced !== undefined) {
    record('reconciliation', wanted.balanced, candidate.reconciliation?.balanced);
  }

  // A fixture that states no amount is stating that there is none to find.
  if (wanted.amountMinor === undefined && fixture.kind === 'utterance') {
    record('amount', undefined, candidate.total?.value);
  }
}

/** How well an engine did on one field, as a fraction, or undefined when unmarked. */
export function rate(score: EngineScore, field: ScoredField): number | undefined {
  const marked = score.fields[field];
  return marked.checked === 0 ? undefined : marked.correct / marked.checked;
}

/** A report a person can read in a terminal or a diagnostics screen. */
export function formatScore(score: EngineScore): string {
  const lines = [
    `${score.engine}: ${(score.accuracy * 100).toFixed(0)}% over ${String(score.fixtures)} fixtures, ${score.averageMs.toFixed(0)} ms each`,
  ];

  for (const field of Object.keys(score.fields) as ScoredField[]) {
    const marked = score.fields[field];
    if (marked.checked === 0) continue;
    lines.push(`  ${field}: ${String(marked.correct)}/${String(marked.checked)}`);
  }

  for (const miss of score.misses) {
    lines.push(`  miss ${miss.fixture} ${miss.field}: wanted ${miss.expected}, got ${miss.got}`);
  }

  return lines.join('\n');
}

function blankFields(): Record<ScoredField, FieldScore> {
  return {
    amount: { checked: 0, correct: 0 },
    currency: { checked: 0, correct: 0 },
    merchant: { checked: 0, correct: 0 },
    date: { checked: 0, correct: 0 },
    tax: { checked: 0, correct: 0 },
    tip: { checked: 0, correct: 0 },
    lineItems: { checked: 0, correct: 0 },
    reconciliation: { checked: 0, correct: 0 },
  };
}

function sum(
  fields: Readonly<Record<ScoredField, FieldScore>>,
  pick: (score: FieldScore) => number,
): number {
  return Object.values(fields).reduce((running, score) => running + pick(score), 0);
}

/** The UTC day a timestamp falls in, which is the granularity a date field means. */
function day(at: number | undefined): string | undefined {
  return at === undefined ? undefined : new Date(at).toISOString().slice(0, 10);
}

function show(value: unknown): string {
  if (value === undefined) return 'nothing';
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);
}
