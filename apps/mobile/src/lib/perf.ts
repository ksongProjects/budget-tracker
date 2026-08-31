/**
 * Measurement against the budgets in docs/implementation-plan.md.
 *
 * The budgets exist because "feels fast on a flagship" hides every regression.
 * These record what actually happened, in milliseconds, so a claim about
 * performance is a number rather than an adjective.
 */

export interface Measurement {
  readonly name: string;
  readonly ms: number;
  /** The budget from the implementation plan, when there is one. */
  readonly budgetMs?: number;
}

export interface MeasurementResult extends Measurement {
  readonly withinBudget: boolean | null;
}

/** Budgets from docs/implementation-plan.md, in milliseconds. */
export const BUDGETS: Readonly<Record<string, number>> = {
  'cold start to interactive ledger': 1500,
  'warm start': 400,
  'ledger page query (50 rows)': 50,
  'summary by category': 50,
  'summary by month': 50,
  'full-text search': 50,
  'insert one transaction': 50,
  'seed 10k transactions': 60_000,
  'ledger page query over 10k rows': 50,
  'summary by category over 10k rows': 50,
  // Shutter to a number on screen: OCR plus the tier-2 rules.
  'shutter to provisional total': 500,
  // A typical ledger, encrypted and written to disk.
  'backup write': 2000,
};

/** Time one operation. Returns the value alongside the duration. */
export async function measure<T>(
  name: string,
  work: () => Promise<T>,
): Promise<{ value: T; measurement: MeasurementResult }> {
  const started = Date.now();
  const value = await work();
  const ms = Date.now() - started;

  return { value, measurement: withBudget({ name, ms }) };
}

export function withBudget(measurement: Measurement): MeasurementResult {
  const budgetMs = measurement.budgetMs ?? BUDGETS[measurement.name];
  return {
    ...measurement,
    ...(budgetMs === undefined ? {} : { budgetMs }),
    withinBudget: budgetMs === undefined ? null : measurement.ms <= budgetMs,
  };
}

/**
 * Run `work` `runs` times and report the median.
 *
 * Median, not mean: one garbage collection pause should not decide whether a
 * budget passed, and it should not hide a slow path either.
 */
export async function measureRepeated<T>(
  name: string,
  runs: number,
  work: () => Promise<T>,
): Promise<MeasurementResult> {
  const timings: number[] = [];

  for (let i = 0; i < runs; i += 1) {
    const started = Date.now();
    await work();
    timings.push(Date.now() - started);
  }

  timings.sort((a, b) => a - b);
  const middle = Math.floor(timings.length / 2);
  const median =
    timings.length % 2 === 0
      ? ((timings[middle - 1] ?? 0) + (timings[middle] ?? 0)) / 2
      : (timings[middle] ?? 0);

  return withBudget({ name, ms: median });
}

/**
 * When the app process started, set as early as the JS bundle runs. Cold start
 * is measured from here to the first ledger paint.
 */
export const PROCESS_START = Date.now();

let interactiveAt: number | undefined;

/**
 * Called by the ledger screen the first time it renders real data. This is the
 * moment the app is usable, and the only honest end point for cold start.
 *
 * Measuring to "when the benchmark button was pressed" instead reports however
 * long the tester took to tap it — which is what the first version of this
 * harness did, and it reported 71 seconds.
 */
export function markInteractive(): void {
  interactiveAt ??= Date.now();
}

/**
 * Cold start, or undefined if the ledger has not painted yet. Undefined rather
 * than a placeholder: a missing measurement must not look like a fast one.
 */
export function coldStart(): MeasurementResult | undefined {
  if (interactiveAt === undefined) return undefined;
  return withBudget({
    name: 'cold start to interactive ledger',
    ms: interactiveAt - PROCESS_START,
  });
}
