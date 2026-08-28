# Extraction

Documents become candidate transactions in the `extractor` microservice
([ADR 0007](adr/0007-server-side-processing.md)). The client captures, crops,
redacts, encrypts, and uploads; the extractor does the rest.

## Pipeline

```
client   capture → auto-crop → user confirms crop → redact
         ├─ encrypt original ──────→ blob store        (E2EE, never read by server)
         └─ cropped derivative ────→ extractor         (TLS, 24h scratch)

extractor  OCR / PDF text layer / STT
           → rules
           → LLM structuring
           → merchant canonicalization + categorization
           → candidate transaction

client   user confirms or edits → committed to ledger
```

Nothing enters the ledger unconfirmed. Extraction proposes, the user disposes.
Unconfirmed rows carry a null `confirmed_at` and stay out of every total.

## Tiers

Cheapest and most auditable first. Each extraction records which tier produced it, so
a wrong number is always traceable to the thing that produced it. Rules before models
is a cost decision second and an auditability decision first — money data must be
explainable.

**Tier 0 — structured input.** CSV statements, manual entry. Parsed directly, no
inference.

**Tier 1 — PDF text layer + per-bank rules.** The text layer is already in the file;
per-institution table and regex rules turn it into rows. Deterministic and exact,
and this should carry the bulk of statement volume. One versioned rule set per
institution, each with a fixture PDF in the test suite. Server-side means a broken
parser is a deploy, not an app store review — the main reason this moved off-device.

**Tier 2 — OCR + receipt heuristics.** Totals, tax, date, merchant, card last-4.
High hit rate, because receipts label the total and put it near the bottom whatever
else they do.

**Tier 3 — LLM structuring.** Line-item breakdown, unusual layouts, and free-form
voice ("spent twelve bucks on coffee at Blue Bottle"). Line items are where rules
genuinely fail: item-name columns have no cross-merchant convention. Claude for text
structuring.

## On-device preview

Mobile runs on-device OCR (iOS Vision, Android ML Kit) the instant the photo is taken
and shows a provisional total in a few hundred milliseconds while the server call is
in flight. The server result supersedes it. This preserves the "photograph a receipt,
see the amount immediately" promise despite the round trip, and it is the offline
path — captures queue and extract when connectivity returns.

Web has no on-device OCR and goes straight to the extractor.

## Audio

`faster-whisper` on CPU int8 in the extractor. Transcript then goes through Tier 3.
Note: GPU whisper is not a practical local dev path on an AMD box without CUDA, so
CPU int8 is the default and the deployed config, not a fallback.

## Scaling

Server-side OCR is the worst-scaling component in the system — GPU and bandwidth grow
with active users. Controls, in order of effect:

1. On-device preview absorbs impatient re-captures.
2. Downscale and JPEG-compress derivatives client-side before upload.
3. Tier 1 never touches OCR at all; keep statement rules good.
4. CPU OCR until volume justifies GPUs. Measure before buying.

The extractor scales independently of the API service and runs off a Redis queue, so
a backlog delays extractions without touching login or ledger reads.

## Evaluation

A fixture corpus of real receipts and statements with hand-labeled ground truth, kept
locally and gitignored, never committed. Track per-tier accuracy on total, date, and
merchant. Every rule change runs against it. Without this, rule maintenance is
guesswork and regressions ship silently.
