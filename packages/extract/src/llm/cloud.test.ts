import { describe, expect, it, vi } from 'vitest';
import { CurrencySchema, parseAmount } from '@budget/schema';
import { createCloudAssist } from './cloud.js';
import type { StructuringRequest } from './types.js';

const USD = CurrencySchema.parse('USD');
const NOW = Date.UTC(2026, 7, 30, 12);

const RECEIPT = ['BLUE BOTTLE COFFEE', 'VISA 4242 4242 4242 4242', 'TOTAL 8.97'].join('\n');
/** What the adapter will actually send: the same text with the card masked. */
const REDACTED = ['BLUE BOTTLE COFFEE', 'VISA ************4242', 'TOTAL 8.97'].join('\n');

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function replying(text: string) {
  return vi.fn(() => Promise.resolve(answer({ content: [{ type: 'text', text }] })));
}

function request(overrides: Partial<StructuringRequest> = {}): StructuringRequest {
  return { text: RECEIPT, kind: 'receipt', defaultCurrency: USD, now: NOW, ...overrides };
}

const consent = { grantedAt: NOW, approvedText: REDACTED };

describe('Cloud Assist refusals', () => {
  it('makes no call at all without consent', async () => {
    const fetch = replying('{}');
    const engine = createCloudAssist({ apiKey: 'sk-test', fetch });

    await expect(engine.structure(request())).rejects.toThrow(/permission/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a consent granted for different text', async () => {
    const fetch = replying('{}');
    const engine = createCloudAssist({ apiKey: 'sk-test', fetch });

    // The user approved one receipt; this is another. A grant is for a capture,
    // not for a session.
    await expect(
      engine.structure(
        request({ consent: { grantedAt: NOW, approvedText: 'SOME OTHER RECEIPT' } }),
      ),
    ).rejects.toThrow(/not the text you approved/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses consent granted before the text was redacted', async () => {
    const fetch = replying('{}');
    const engine = createCloudAssist({ apiKey: 'sk-test', fetch });

    // Approving the unredacted text would send a full card number, so the
    // unmasked string is exactly the one that must not authorise a send.
    await expect(
      engine.structure(request({ consent: { grantedAt: NOW, approvedText: RECEIPT } })),
    ).rejects.toThrow(/not the text you approved/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a stale tap', async () => {
    const fetch = replying('{}');
    const engine = createCloudAssist({ apiKey: 'sk-test', fetch });

    await expect(
      engine.structure(
        request({ consent: { grantedAt: NOW - 600_000, approvedText: REDACTED } }),
      ),
    ).rejects.toThrow(/expired/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports itself unavailable without a key rather than calling with none', async () => {
    const engine = createCloudAssist({ apiKey: '', fetch: replying('{}') });
    await expect(engine.capability()).resolves.toMatchObject({ availability: 'unsupported' });
  });
});

describe('Cloud Assist sends', () => {
  it('the redacted text, and only the text', async () => {
    const fetch = replying(JSON.stringify({ total: '8.97', merchant: 'BLUE BOTTLE COFFEE' }));
    const engine = createCloudAssist({ apiKey: 'sk-test', fetch });

    await engine.structure(request({ consent }));

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const sent = init.body as string;
    const body = JSON.parse(sent) as { messages: { content: string }[]; system: string };

    expect(body.messages[0]?.content).toBe(REDACTED);
    expect(sent).not.toContain('4242 4242 4242 4242');
    // No image, no audio, no ledger — a text request is all this can be.
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'system', 'messages']);
  });

  it('the user key, in the header, and nothing of ours', async () => {
    const fetch = replying('{}');
    const engine = createCloudAssist({ apiKey: 'sk-user-key', fetch });

    await engine.structure(request({ consent }));

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers['x-api-key']).toBe('sk-user-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('and reads the answer back into candidates', async () => {
    const fetch = replying(
      `Here you go:\n\`\`\`json\n${JSON.stringify({ total: '8.97', currency: 'USD' })}\n\`\`\``,
    );
    const engine = createCloudAssist({ apiKey: 'sk-test', fetch });

    const candidate = await engine.structure(request({ consent }));

    expect(candidate.total?.value).toBe(parseAmount('8.97', USD));
    expect(candidate.engine).toBe('cloud-assist');
  });

  it('and says so plainly when the service refuses', async () => {
    const fetch = vi.fn(() => Promise.resolve(answer({ error: 'overloaded' }, 529)));
    const engine = createCloudAssist({ apiKey: 'sk-test', fetch });

    await expect(engine.structure(request({ consent }))).rejects.toThrow(/529/);
  });

  it('and gives up rather than hanging on a dead socket', async () => {
    // The failure a phone actually sees: a request that never returns. Without
    // a timeout the capture screen waits forever with no way back.
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const engine = createCloudAssist({ apiKey: 'sk-test', fetch, timeoutMs: 10 });

    await expect(engine.structure(request({ consent }))).rejects.toThrow(/abort/i);
  });
});
