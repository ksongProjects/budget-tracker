# Extraction

Turning a Document into candidate Transactions. Ordered cheapest-and-most-auditable
first. Every Extraction records which tier fired and its confidence, so a wrong
number can always be traced to the thing that produced it.

## Principle

Rules before models. Not only for cost — a deterministic parse is auditable, and
money data must be auditable. A model is the fallback for format variance, not the
default path.

## Where each stage runs

| Stage | Runs on | Why |
|---|---|---|
| Capture, crop, deskew, downscale | client | no round-trip, works offline |
| OCR (image → text) | client | ~100–300 ms on-device vs. seconds for upload+GPU+return |
| PDF text-layer extraction | client | text layer is already there; parsing it is trivial |
| Speech-to-text | client | on-device STT is native on both platforms |
| Redaction | client | must happen before anything can leave the device |
| Encryption | client | non-negotiable |
| Rule-based structuring | client | pure functions over text, shared TS package |
| LLM structuring | server, consented only | needs a hosted model |

On-device OCR is the single most important scaling decision in the system. Server-side
image OCR would make GPU cost and bandwidth scale linearly with active users; it is
the worst-scaling component we could have chosen, and we are not choosing it.

Client OCR APIs: iOS `Vision` / `VNRecognizeTextRequest`, Android ML Kit Text
Recognition. Both free, offline, and already tuned for receipts. On web, the file is
usually a PDF or an uploaded image — use the PDF text layer, and fall back to Cloud
Assist for scanned images rather than shipping a WASM OCR blob.

## Tier cascade

**Tier 0 — structured input.** CSV statements and manual entry. Parsed directly. No
inference.

**Tier 1 — text layer + rules.** Bank statement PDFs. Extract the text layer, then
apply per-institution table/regex rules. Deterministic and exact; this should cover
the large majority of statement volume. Maintain rules per bank, versioned, with a
fixture PDF per rule in the test suite.

**Tier 2 — OCR + receipt heuristics.** Receipt photos. On-device OCR, then rules for
the fields with strong conventions: total, tax, date, merchant name, last-4 of card.
These have high hit rates because receipts, whatever else they do, put the total near
the bottom and label it.

**Tier 3 — LLM structuring (Cloud Assist).** Full line-item breakdown, unusual
layouts, and free-form voice input ("spent twelve bucks on coffee at Blue Bottle").
Line items are where rules genuinely fail — item-name columns have no convention
across merchants. Requires per-Document consent, and receives **redacted text only**.

Always attempt Tier 2 first and show the user the total immediately. Tier 3 is an
enrichment on an already-usable result, never a blocker. The product promise is
"photograph a receipt, get the amount in seconds" — that promise is kept by Tier 2
alone.

## Audio

On-device STT first (iOS `Speech`, Android `SpeechRecognizer`). Server-side
`faster-whisper` on CPU int8 as a consented fallback for long or noisy recordings.
Note: the dev machine is AMD without CUDA, so GPU whisper on the server is not a
practical local path — another reason on-device is the default rather than an
optimization.

Transcript → same Tier 3 structuring as text.

## Confirm step

Extraction output is always *candidate* data. The user sees the parsed amount,
merchant, and category pre-filled, and confirms or edits. Nothing enters the Ledger
unconfirmed. Confidence below threshold highlights the field rather than silently
guessing.

## Evaluation

Keep a fixture corpus of real receipts and statements (locally, gitignored, never
committed) with hand-labeled ground truth. Track per-tier accuracy on total, date,
and merchant. Any rule change runs against the corpus. Without this, rule maintenance
becomes guesswork.
