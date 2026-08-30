# ADR 0007 — Extraction engine is a server-side microservice

**Status**: superseded by [ADR 0011](0011-local-first.md) · 2026-08-29 · supersedes [ADR 0002](0002-client-side-extraction.md)

## Context

ADR 0002 put extraction on the device for latency, scaling cost, and privacy. Under
the split trust model (ADR 0006) the privacy argument no longer applies to extracted
content, and a server-side engine buys things a device-bound one cannot: one codebase
instead of three, per-bank statement rules shipped without an app release, LLM
structuring without a consent gate, and identical behavior on web and mobile.

## Decision

Extraction runs in a dedicated `extractor` microservice, separate from the API
service. The client's job is capture, crop, redact, encrypt, and upload.

Pipeline:

```
client: capture → auto-crop (on-device model) → user confirms crop → redact
      → encrypt original → upload blob (E2EE, ADR 0006)
      → send cropped derivative to extractor
extractor: OCR / PDF text layer / STT → rules → LLM structuring → normalized txn
api: write plaintext ledger rows
client: user confirms or edits → committed
```

The extractor receives the **cropped derivative**, not the original. The original is
encrypted and the extractor never holds a key for it. Cropping is therefore
load-bearing, not cosmetic: it is the mechanism that keeps account numbers and
balances out of the server-readable path.

The extractor holds derivatives in memory and in a scratch bucket with a 24-hour
lifecycle rule, never longer. It persists structured output only.

## On-device OCR stays, as a preview

Mobile still runs on-device OCR immediately after capture and shows a provisional
total in a few hundred milliseconds, while the server call is in flight. The server
result supersedes it when it lands. This keeps the "photograph a receipt, see the
amount instantly" promise without making the device the system of record, and it is
the offline path when there is no connectivity.

Web has no on-device OCR and goes straight to the extractor.

## Consequences

Good: rules ship server-side, so a broken bank parser is a deploy and not an app store
review. One extraction implementation to test. Full LLM line-item extraction available
by default rather than behind a consent prompt. Web and mobile behave identically.

Bad: server-side OCR means GPU and bandwidth cost scaling with active users — the
worst-scaling component in the design, and the reason ADR 0002 avoided it. Mitigate by
keeping the on-device preview (which absorbs the impatient re-taps), downscaling
aggressively before upload, and running OCR on CPU until volume justifies GPUs.
Capture without connectivity now queues rather than completing.

Cropping quality becomes a security control. A bad auto-crop leaks an account number
to the server-readable path. The user confirms every crop before upload, and the
default crop for statements is conservative — transaction rows only, headers and
balance blocks excluded.
