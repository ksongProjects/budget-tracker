import type { Currency, MinorUnits, Timestamp } from '@budget/schema';
import type { Candidate, CandidateTransaction } from '../types.js';

/**
 * Tier 3: a small model turns text into structure (docs/extraction.md).
 *
 * The tier exists for the two places rules genuinely fail — line items, whose
 * naming has no cross-merchant convention, and free-form speech. Everything
 * cheaper runs first, and what a model returns is a *proposal* that the
 * validation layer either accepts as candidates or throws away.
 *
 * The interface takes text and returns fields. It has nowhere for pixels, audio
 * or the ledger to go, which is the point: an adapter that wanted to send those
 * would have to change this file, and that is a reviewable event.
 */

/**
 * Whether a model can run here.
 *
 * Three states rather than a boolean because "the OS has this but has not
 * downloaded it" is the common case on a new phone, and the app's answer to it
 * — carry on with Tiers 0–2 — differs from its answer to hardware that will
 * never have a model.
 */
export type Availability = 'ready' | 'downloadable' | 'unsupported';

export interface Capability {
  readonly availability: Availability;
  /** Shown to the user when a model is missing. Plain language, no error codes. */
  readonly reason?: string;
}

/** What kind of text is being structured, which decides how it is prompted. */
export type StructuringKind = 'receipt' | 'utterance';

/**
 * A user's permission to send one capture off the device.
 *
 * Per capture, never sticky (docs/extraction.md). It carries the exact text
 * that was shown and approved, so the adapter can refuse to send anything else:
 * a grant for one receipt cannot be reused for the next, and a grant obtained
 * before redaction cannot cover the text after it changed.
 */
export interface CloudConsent {
  readonly grantedAt: number;
  /** The exact — already redacted — text the user read and approved. */
  readonly approvedText: string;
}

export interface StructuringRequest {
  /** The text to read. Redacted before it reaches any engine that leaves the device. */
  readonly text: string;
  readonly kind: StructuringKind;
  /** Used when the text names no currency. */
  readonly defaultCurrency: Currency;
  /** "Yesterday" is relative to this. */
  readonly now: number;
  /**
   * Present only when the user has just tapped to allow this one capture to
   * leave the device. Every on-device engine ignores it; the cloud adapter
   * refuses to send without it.
   */
  readonly consent?: CloudConsent;
}

/** One line of a receipt, as a model read it. */
export interface LineItem {
  readonly description: string;
  readonly amount: MinorUnits;
  /** Absent when the receipt does not print one, which is most of the time. */
  readonly quantity?: number;
}

/**
 * Whether the line items add up to the total.
 *
 * The single most useful check on a model's arithmetic, and the reason line
 * items are worth extracting at all: a breakdown that does not reconcile is
 * visibly wrong, so the user is shown the gap rather than a confident lie.
 */
export interface Reconciliation {
  readonly balanced: boolean;
  /** Items plus tax plus tip, as read. */
  readonly itemisedTotal: MinorUnits;
  /** Stated total minus itemised total. Positive means the items fall short. */
  readonly differenceMinor: number;
}

export interface StructuredCandidate extends CandidateTransaction {
  readonly lineItems?: readonly Candidate<LineItem>[];
  /** Absent when there were no line items to check. */
  readonly reconciliation?: Reconciliation;
  /** Which engine proposed this, for the audit trail every extraction carries. */
  readonly engine: string;
  readonly durationMs: number;
}

/**
 * What a platform must provide to take part in Tier 3.
 *
 * Apple Foundation Models, Gemini Nano and the opt-in cloud path all sit behind
 * this. The tier logic never learns which one it is talking to, which is what
 * lets the same fixture suite score every one of them in CI.
 */
export interface StructuringEngine {
  readonly name: string;
  /** Whether this engine leaves the device. Exactly one adapter answers true. */
  readonly remote: boolean;
  capability(): Promise<Capability>;
  structure(request: StructuringRequest): Promise<StructuredCandidate>;
}

/** Fields a fixture can state ground truth for. */
export interface StructuringExpectation {
  readonly amountMinor?: MinorUnits;
  readonly currency?: Currency;
  readonly merchant?: string;
  readonly occurredAt?: Timestamp;
  readonly taxMinor?: MinorUnits;
  readonly tipMinor?: MinorUnits;
  readonly lineItemCount?: number;
  readonly balanced?: boolean;
}
