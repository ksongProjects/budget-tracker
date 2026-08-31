import { extractReceipt } from '../receipt.js';
import { parseUtterance } from '../voice/utterance.js';
import type { CandidateTransaction } from '../types.js';
import type { StructuredCandidate, StructuringEngine, StructuringRequest } from './types.js';

/**
 * Which engine reads a capture, and what happens when none can.
 *
 * The tiering rule from docs/extraction.md, in code: cheapest and most
 * auditable first, and the app degrades by dropping line-item detail rather
 * than by refusing to capture. A phone with no on-device model still reads
 * totals, dates and merchants through the rules — which is the primary use
 * case — and the model, when there is one, is asked to improve on that rather
 * than to replace it.
 *
 * Nothing here decides anything either. Whatever comes out is a proposal the
 * user confirms.
 */

export interface RouteOptions {
  /**
   * In preference order. On-device engines first; a remote one is only ever
   * consulted for a request that carries the user's consent for that capture.
   */
  readonly engines: readonly StructuringEngine[];
  /** Reported when an engine throws, so a failure is visible rather than silent. */
  readonly onError?: (engine: string, cause: unknown) => void;
}

/**
 * Read a capture with the best engine available, falling back to the rules.
 *
 * The fallback is not an error path — it is the floor. A model that is missing,
 * slow, or unwilling still leaves the user with the fields that rules can find,
 * and the result says which engine produced it either way.
 */
export async function structureCapture(
  request: StructuringRequest,
  options: RouteOptions,
): Promise<StructuredCandidate> {
  const rules = applyRules(request);

  for (const engine of options.engines) {
    // A remote engine without consent for *this* capture is not skipped
    // quietly for tidiness — it is skipped because consent is the only thing
    // that makes the call legal to make.
    if (engine.remote && request.consent === undefined) continue;

    try {
      const capability = await engine.capability();
      if (capability.availability !== 'ready') continue;

      const proposed = await engine.structure(request);

      // An engine that read nothing is not better than the rules, and an
      // engine that read something still does not get to erase what the rules
      // saw — the two are merged with the model on top.
      if (proposed.total === undefined && proposed.lineItems === undefined) continue;

      return merge(proposed, rules);
    } catch (cause) {
      options.onError?.(engine.name, cause);
    }
  }

  return rules;
}

/** Tier 0–2 in one call: the rules that need no model and no network. */
export function applyRules(request: StructuringRequest): StructuredCandidate {
  const started = Date.now();

  const candidate: CandidateTransaction =
    request.kind === 'utterance'
      ? parseUtterance(request.text, {
          defaultCurrency: request.defaultCurrency,
          now: request.now,
        })
      : extractReceipt({
          // The rules read lines; text from a PDF or a transcript arrives as
          // lines already, and OCR output was lines before it was joined.
          lines: request.text.split('\n').map((text) => ({ text })),
          engine: 'text',
          durationMs: 0,
        });

  return {
    ...candidate,
    // Most receipts print no currency symbol at all, and an amount with no
    // currency cannot be written to the ledger. The user's own default is the
    // honest guess, at a confidence that says it was one.
    ...(candidate.total !== undefined && candidate.currency === undefined
      ? { currency: { value: request.defaultCurrency, confidence: 0.4, evidence: 'assumed' } }
      : {}),
    engine: 'rules',
    durationMs: Date.now() - started,
  };
}

/**
 * Model fields over rules fields, gaps filled from the rules.
 *
 * Never the other way round: where both read a total, the model's is the one a
 * user was shown line items for, and two different totals on one screen is
 * worse than either. Where the model was silent, the rules still have something
 * to say, and dropping it would make the model's presence a downgrade.
 */
export function merge(
  proposed: StructuredCandidate,
  rules: StructuredCandidate,
): StructuredCandidate {
  return {
    ...rules,
    ...definedOnly(proposed),
    engine: proposed.engine,
    durationMs: proposed.durationMs,
  };
}

function definedOnly(candidate: StructuredCandidate): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => value !== undefined),
  );
}
