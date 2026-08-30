import type { Currency, MinorUnits, Timestamp } from '@budget/schema';

/**
 * The extraction contract, per docs/extraction.md.
 *
 * Engines (Vision, ML Kit, Tesseract, whisper) sit behind these interfaces; the
 * tiers and heuristics are pure TypeScript that never learns which engine it is
 * talking to. That is what makes extraction testable in CI against recorded
 * engine output, with no device.
 */

/** One line of text an OCR engine found, with where it found it. */
export interface OcrLine {
  readonly text: string;
  /** Normalized 0–1 box, origin top-left. Absent when an engine does not report it. */
  readonly box?: BoundingBox;
  /** Engine confidence 0–1, when reported. */
  readonly confidence?: number;
}

export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OcrResult {
  readonly lines: readonly OcrLine[];
  readonly engine: string;
  readonly durationMs: number;
}

/** What a platform must provide to take part in Tier 2. */
export interface OcrEngine {
  readonly name: string;
  recognize(imageUri: string): Promise<OcrResult>;
}

/**
 * A proposed field, with the confidence and the evidence behind it.
 *
 * Evidence is not decoration: when a total is wrong, the line it came from is
 * the difference between fixing a rule and guessing.
 */
export interface Candidate<T> {
  readonly value: T;
  readonly confidence: number;
  /** The source text this was read from. */
  readonly evidence: string;
}

export interface CandidateTransaction {
  readonly total?: Candidate<MinorUnits>;
  readonly currency?: Candidate<Currency>;
  readonly occurredAt?: Candidate<Timestamp>;
  readonly merchant?: Candidate<string>;
  readonly tax?: Candidate<MinorUnits>;
  readonly tip?: Candidate<MinorUnits>;
  /** Last four digits of the card, when printed. Never the full number. */
  readonly cardLast4?: Candidate<string>;
}

export const TIERS = [0, 1, 2, 3] as const;
export type Tier = (typeof TIERS)[number];
