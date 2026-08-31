import { redact } from '../redact.js';
import { buildPrompt } from './prompt.js';
import { readModelOutput } from './read.js';
import type {
  Capability,
  StructuredCandidate,
  StructuringEngine,
  StructuringRequest,
} from './types.js';

/**
 * Cloud Assist: the one path that leaves the device, and the rules it obeys.
 *
 * Off by default, never sticky, one capture at a time, and what goes is
 * redacted *text* — never pixels, never audio, never the ledger
 * (docs/extraction.md). The MVP uses the user's own API key and no service of
 * ours, so the only party that ever sees a capture is the one the user chose
 * and paid.
 *
 * Three refusals are enforced here rather than in a screen, because a screen
 * can be routed around and this cannot:
 *
 *   1. No consent, no call.
 *   2. Consent is for one exact text. Approve a receipt, and that grant will
 *      not send a different one — including the same receipt after an edit.
 *   3. Consent goes stale. A tap from an hour ago is not permission now.
 *
 * The redaction runs here too, not upstream, so the bytes on the wire are the
 * bytes the user approved and there is no window between the two.
 */

export interface CloudAssistOptions {
  /** The user's own key. Never ours, never bundled, never logged. */
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly model?: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  /** How long a tap stays valid. Short: consent is for the capture in front of the user. */
  readonly consentValidMs?: number;
}

const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CONSENT_VALID_MS = 120_000;
const ANTHROPIC_VERSION = '2023-06-01';

export function createCloudAssist(options: CloudAssistOptions): StructuringEngine {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const consentValidMs = options.consentValidMs ?? DEFAULT_CONSENT_VALID_MS;

  return {
    name: 'cloud-assist',
    remote: true,

    capability(): Promise<Capability> {
      return Promise.resolve(
        options.apiKey === ''
          ? { availability: 'unsupported', reason: 'Cloud Assist needs your own API key.' }
          : { availability: 'ready' },
      );
    },

    async structure(request: StructuringRequest): Promise<StructuredCandidate> {
      const sending = redact(request.text).text;
      check(request, sending, consentValidMs);

      const prompt = buildPrompt({ ...request, text: sending });
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      let response: Response;
      try {
        response = await options.fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`Cloud Assist refused the request (${String(response.status)}).`);
      }

      const body: unknown = await response.json();

      return readModelOutput(textOf(body), { ...request, text: sending }, {
        engine: 'cloud-assist',
        durationMs: Date.now() - started,
      });
    },
  };
}

function check(request: StructuringRequest, sending: string, validMs: number): void {
  const { consent } = request;

  if (consent === undefined) {
    throw new Error('Cloud Assist needs your permission for this capture.');
  }
  if (consent.approvedText !== sending) {
    throw new Error('This is not the text you approved sending.');
  }
  if (request.now - consent.grantedAt > validMs) {
    throw new Error('That permission has expired. Tap again to send this capture.');
  }
}

/** The text out of a Messages API response, tolerant of blocks we do not use. */
function textOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';

  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';

  return content
    .map((block: unknown) =>
      typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('');
}
