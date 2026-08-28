# ADR 0002 — Image and audio processing on the client

**Status**: accepted · 2026-08-28

## Context

Receipt photos and voice notes have to become text somewhere. The choice is the
device or the server, and it determines both the latency the user feels and the shape
of our cost curve.

## Decision

The client does capture, crop, deskew, downscale, OCR, PDF text extraction,
speech-to-text, redaction, encryption, and rule-based structuring. The server sees
text at most, and only with consent.

## Consequences

Latency: on-device OCR runs in roughly 100–300 ms using iOS Vision or Android ML Kit.
The server round-trip is upload of a multi-megabyte image, queue wait, inference, and
return — an order of magnitude worse, and it fails entirely without connectivity.

Scaling: on-device OCR has zero marginal server cost per user. Server-side image OCR
would scale GPU spend and bandwidth linearly with active users and would be the
worst-scaling component in the system. This is the single biggest reason for the
decision.

Privacy: pixels never leave the device on the default path, which is what makes ADR
0001 workable rather than merely aspirational.

Cost: two OCR integrations to maintain (iOS and Android), and the web SPA has no good
offline OCR — web users get PDF text-layer parsing, and scanned images fall back to
Cloud Assist. Shipping a WASM OCR bundle to the browser was rejected as too heavy for
the traffic it would serve.
