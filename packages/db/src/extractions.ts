import { ExtractionSchema, uuidv7 } from '@budget/schema';
import type { CaptureId, Extraction, ExtractionTier } from '@budget/schema';
import type { RepositoryContext } from './context.js';

/**
 * The record of each time something read a capture.
 *
 * Kept after the user confirms — when a saved number is wrong, this is what
 * says whether the camera, the rules, a model or a bank file produced it
 * (docs/data-model.md). Append-only: a second reading of the same capture is a
 * second row, not an edit of the first.
 */
export interface NewExtraction {
  readonly captureId: CaptureId;
  readonly tier: ExtractionTier;
  readonly engine: string;
  readonly status?: Extraction['status'];
  /** What was proposed, before anyone confirmed it. */
  readonly candidate: Record<string, unknown>;
  /** Per field, 0–1. */
  readonly confidence?: Record<string, number>;
  readonly durationMs: number;
}

interface ExtractionRow {
  readonly id: string;
  readonly capture_id: string;
  readonly tier: number;
  readonly engine: string;
  readonly status: string;
  readonly candidate: string;
  readonly confidence: string;
  readonly ran_at: number;
  readonly duration_ms: number;
}

export class ExtractionRepository {
  constructor(private readonly ctx: RepositoryContext) {}

  async record(input: NewExtraction): Promise<Extraction> {
    const extraction = ExtractionSchema.parse({
      id: uuidv7(),
      captureId: input.captureId,
      tier: input.tier,
      engine: input.engine,
      status: input.status ?? 'done',
      // Through JSON once here, so what is stored is exactly what reads back:
      // a candidate holding `undefined` fields would otherwise differ from its
      // own row.
      candidate: JSON.parse(JSON.stringify(input.candidate)) as Record<string, unknown>,
      confidence: input.confidence ?? {},
      ranAt: this.ctx.clock(),
      // Milliseconds, not money: a timer's fraction of a millisecond is noise.
      durationMs: Math.max(0, Math.trunc(input.durationMs)),
    });

    await this.ctx.driver.run(
      `INSERT INTO extractions
         (id, capture_id, tier, engine, status, candidate, confidence, ran_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        extraction.id,
        extraction.captureId,
        extraction.tier,
        extraction.engine,
        extraction.status,
        JSON.stringify(extraction.candidate),
        JSON.stringify(extraction.confidence),
        extraction.ranAt,
        extraction.durationMs,
      ],
    );

    return extraction;
  }

  /** Every reading of a capture, newest first. */
  async listFor(captureId: CaptureId): Promise<Extraction[]> {
    const rows = await this.ctx.driver.all<ExtractionRow>(
      `SELECT id, capture_id, tier, engine, status, candidate, confidence, ran_at, duration_ms
       FROM extractions WHERE capture_id = ? ORDER BY ran_at DESC, id DESC`,
      [captureId],
    );

    return rows.map((row) =>
      ExtractionSchema.parse({
        id: row.id,
        captureId: row.capture_id,
        tier: row.tier,
        engine: row.engine,
        status: row.status,
        candidate: JSON.parse(row.candidate) as unknown,
        confidence: JSON.parse(row.confidence) as unknown,
        ranAt: row.ran_at,
        durationMs: row.duration_ms,
      }),
    );
  }
}

/**
 * Per-field confidence from a candidate whose fields carry one — the shape
 * every reader in `@budget/extract` produces.
 */
export function confidenceOf(candidate: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, value] of Object.entries(candidate) as [string, unknown][]) {
    if (typeof value !== 'object' || value === null || !('confidence' in value)) continue;

    const confidence: unknown = value.confidence;
    if (typeof confidence === 'number') out[field] = Math.min(1, Math.max(0, confidence));
  }
  return out;
}
