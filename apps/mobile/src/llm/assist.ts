import { redact, structureCapture } from '@budget/extract';
import type { StructuredCandidate, StructuringKind } from '@budget/extract';
import { CurrencySchema } from '@budget/schema';
import type { Currency } from '@budget/schema';
import { deviceEngines, engineList } from './engines';

/**
 * What the capture screens call to get more out of a capture than rules can.
 *
 * Two questions this answers, and they are different: *can* anything read this
 * better, and *what leaves the phone if it does*. A device with an on-device
 * model answers "yes, nothing"; a device with a Cloud Assist key answers "yes,
 * this exact text"; most devices today answer "no", and the capture screen
 * carries on with what the rules found.
 */

export interface AssistOffer {
  /** Whether to offer the user anything at all. */
  readonly available: boolean;
  /** Whether taking the offer sends text off the device. */
  readonly remote: boolean;
  /** The button, in the user's terms. */
  readonly label: string;
}

export async function assistOffer(): Promise<AssistOffer> {
  const engines = await engineList();
  const local = deviceEngines().length > 0;
  const remote = engines.some((engine) => engine.remote);

  if (local) {
    return { available: true, remote: false, label: 'Read the line items on this phone' };
  }
  if (remote) {
    return { available: true, remote: true, label: 'Read the line items with Cloud Assist' };
  }
  return { available: false, remote: false, label: '' };
}

/**
 * Exactly what would be sent, for the user to read before deciding.
 *
 * The same redaction the adapter applies, so the screen and the wire cannot
 * disagree — and the consent the user gives is keyed to this string, which is
 * what stops it from covering anything else.
 */
export function textToSend(text: string): string {
  return redact(text).text;
}

export interface AssistRequest {
  readonly text: string;
  readonly kind: StructuringKind;
  readonly defaultCurrency?: Currency;
  /**
   * The redacted text the user just approved, when the offer was a remote one.
   * Absent for on-device reading, which needs no permission because nothing
   * leaves.
   */
  readonly approvedText?: string;
  readonly onError?: (engine: string, cause: unknown) => void;
}

export async function runAssist(request: AssistRequest): Promise<StructuredCandidate> {
  const engines = await engineList();
  const now = Date.now();

  return structureCapture(
    {
      text: request.text,
      kind: request.kind,
      defaultCurrency: request.defaultCurrency ?? CurrencySchema.parse('USD'),
      now,
      ...(request.approvedText === undefined
        ? {}
        : { consent: { grantedAt: now, approvedText: request.approvedText } }),
    },
    {
      engines,
      ...(request.onError === undefined ? {} : { onError: request.onError }),
    },
  );
}
