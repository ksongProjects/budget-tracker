# Extraction

Documents become candidate transactions **on the device**
([ADR 0011](adr/0011-local-first.md) §5). The tiering below survived the local-first
pivot unchanged — only its location moved off the server.

## Pipeline

```
capture → (photo: auto-crop → user adjusts → redact) → extract on-device
        → candidate transaction → user confirms or edits → Ledger
```

Nothing enters the Ledger unconfirmed. Unconfirmed rows carry a null `confirmed_at`
and stay out of every total. With small on-device models proposing numbers, this
rule matters **more** than it did with server-side extraction, not less.

## Tiers

Cheapest and most auditable first. Each extraction records the tier and engine that
produced it, so a wrong number is always traceable. Rules before models is an
auditability decision first and a cost decision second — money data must be
explainable.

**Tier 0 — structured input.** CSV statements, manual entry. Parsed directly, no
inference. Zero ambiguity, so zero model.

**Tier 1 — PDF text layer + per-bank rules.** The text layer is already in the file;
per-institution table and regex rules turn it into rows. Deterministic and exact,
and this carries the bulk of statement volume. One versioned rule set per
institution, each with a fixture PDF in the test suite.

A rule fix now ships as an app update rather than a server deploy — the cost the
local-first pivot accepted. Mitigation: rule sets are data, not code, so they can
ship through Expo OTA updates without an app store round trip.

**Tier 2 — OCR + receipt heuristics.** Totals, tax, date, merchant, card last-4.
High hit rate, because receipts label the total and put it near the bottom whatever
else they do.

**Tier 3 — LLM structuring.** Line-item breakdown, unusual layouts, and free-form
voice ("spent twelve bucks on coffee at Blue Bottle"). Line items are where rules
genuinely fail: item-name columns have no cross-merchant convention.

## Engines by platform

| Job | iOS | Android | Web |
|---|---|---|---|
| OCR | Vision | ML Kit | Tesseract.js (WASM) |
| PDF text layer | native | native | pdf.js |
| Speech-to-text | whisper.cpp | whisper.cpp | not offered |
| Tier 3 LLM | Apple Foundation Models (~3B) | Gemini Nano via LiteRT-LM | opt-in Cloud Assist only |

All of them sit behind one interface per job in `packages/extract`; the tiers and
heuristics are pure TypeScript that never learns which engine it is talking to.
That is what makes the extraction logic testable in CI without a device, against
recorded engine-output fixtures.

Web OCR is the weak spot — Tesseract.js runs about 15% below native Tesseract, and
accuracy tracks image quality steeply. Mitigations: client-side deskew and adaptive
threshold before OCR (worth roughly a 30% cut in character error rate on invoices),
PDF text layer preferred over OCR whenever a text layer exists, and the honest
expectation that photo capture happens on the phone.

## Cloud Assist (opt-in, per capture)

For hard cases the user may tap to send **redacted extracted text** — never pixels,
never audio, never the Ledger — for LLM structuring. Off by default, never sticky,
one capture at a time, and the consent prompt says exactly what leaves.

This is why redaction masking of detected PANs, account numbers, and routing
numbers stays in the crop path even though cropping is no longer a security boundary:
masked text is what a Cloud Assist call is allowed to carry.

MVP ships with a user-supplied API key and no service of ours. A hosted proxy is
deferred until there is demand, and would still see only redacted text.

## Devices without an on-device model

Older hardware gets Tiers 0–2 — total, date, merchant, tax — which is the primary
use case, plus the opt-in Cloud Assist path for line items. The app degrades by
dropping line-item detail, never by refusing to capture.

## Evaluation

A fixture corpus of real receipts and statements with hand-labeled ground truth,
kept locally and gitignored, never committed. Track per-tier accuracy on total,
date, and merchant. Every rule change runs against it, and a regression fails CI.
Without this, rule maintenance is guesswork and regressions ship silently.

Recorded engine outputs (OCR text, transcripts) are committed as fixtures where they
contain no real personal data, so the pure-TS tiers stay testable on any machine.
