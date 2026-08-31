# Milestone report — Phase 9: Tier 3 LLM structuring

**Dates**: 2026-08-30
**Phase goal**: a model reads what rules cannot — line items, unusual layouts,
free-form speech — without changing where the data lives.
**Outcome**: shipped-with-deviations — the tier, its validation, its scoring and
the opt-in cloud path are built, tested and exercised on hardware. The two
OS-model adapters are not, because neither can run on any machine this project
has.

## Tasks

| Task | Status | Evidence |
|---|---|---|
| 9.1 OS-model adapters behind one interface, structured-output schema | interface and harness done; adapters deferred | one suite scores any engine; two doubles and the rules floor are scored in CI, and the same harness runs on the device |
| 9.2 Line-item prompt, schema validation, per-field confidence | done | 17 reader tests; a breakdown that does not add up is flagged and its confidence capped |
| 9.3 Opt-in cloud assist, per-capture consent, redacted text, user key | done | 10 adapter tests; on device, no permission means no request, permission means a real one |
| 9.4 Device-capability gating | done | no model reported plainly; captures still read by the rules |

## Test evidence

597 node tests and 64 browser tests at phase close, up from 530.

Two numbers matter more than the count:

- **The rules floor is 77%** of marked fields over the fixture suite — amount
  7/8, currency 7/7, merchant 7/7, date 4/4, and the misses are line items and
  reconciliation. That is the bar Tier 3 has to clear to be worth running, and
  it is measured rather than assumed.
- **The device agrees with CI to the field.** The same harness, run from the
  diagnostics screen on the emulator: `rules: 77% over 8 fixtures, 2 ms each`.

The consent gate was checked on hardware against real OCR of the test receipt,
with a deliberately invalid key stored: with no permission the read came back
from the rules and nothing reached the network; with permission for that exact
text the request went and the provider refused it with a 401. A request that
never left could not have been refused.

## Deviations from plan

**No on-device model adapters.** Apple Foundation Models needs an iOS 26 device
and a Mac to build for it; Gemini Nano needs AICore on recent Pixel hardware,
which an x86 emulator does not have. Writing both against their documentation
and shipping them unrun would put two engines into a scoring harness whose
numbers nobody could trust. What ships is the seam — one function returns the
device's engines, and the router, the screens and the harness pick up whatever
it returns.

**Cloud Assist is the only remote engine, and it is Anthropic's Messages API.**
The plan says user-supplied key first, hosted proxy deferred until demand, and
that is what this is.

**The scoring fixtures are invented.** Receipts and voice notes are personal
documents and the real corpus is gitignored, so the committed suite is eight
texts with the shapes that break parsers: OCR that splits a label from its
amount, a decimal comma, a discount line that makes the items overshoot, a
sentence with no number in it.

## What this cannot do

- **Read line items on any phone today.** No on-device model is wired up, so a
  breakdown needs Cloud Assist and therefore a key and a tap.
- **Trust a model about a number that is not printed.** It will keep the
  reading, at a confidence that says where it came from, and mark the evidence
  "not printed".
- **Reuse a permission.** One tap covers one exact redacted text. Edit the
  capture, or move to the next one, and it asks again.
- **Send anything but text.** The interface takes a string and returns fields.
  A photo or a recording has nowhere to go in it.

## Risks carried forward

- **The floor is measured against fixtures we wrote.** 77% is a real number
  about invented receipts. The first real corpus will move it.
- **Reconciliation is exact.** A receipt with a discount line does not balance,
  and the screen says so — correct, but it will be the common case for grocery
  receipts, and a flag that fires constantly stops being read.
- **A model that returns nothing usable costs the user the wait.** The router
  falls back to the rules, but only after the engine has had its turn.
- **Cloud Assist bills the user.** Their key, their quota. A retry loop or a
  long receipt is their money, which is one more reason it is a per-capture tap
  rather than a setting.

## Next

Phase 10: hardening and release. The one thing this phase leaves on the table
is the pair of OS adapters, and both are gated on hardware rather than on
design — a Mac and an iPhone for one, a recent Pixel for the other.
