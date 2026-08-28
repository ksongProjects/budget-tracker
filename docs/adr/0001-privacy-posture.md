# ADR 0001 — E2EE by default, Cloud Assist by consent

**Status**: superseded by [ADR 0006](0006-split-trust-model.md) · 2026-08-28

## Context

Users upload bank statements and receipts — among the most sensitive personal data
there is. We also want high-quality extraction, which for line items means an LLM.
These pull in opposite directions: true E2EE means the server holds only ciphertext
and therefore cannot run OCR or an LLM over user documents. Any design has to resolve
this explicitly rather than drift into "encrypted" meaning TLS.

Three postures were considered: strict E2EE (all processing on device), ephemeral
server decryption (real plaintext in server memory), and encrypted-at-rest with
server-held keys (not E2EE at all).

## Decision

E2EE by default, with per-Document opt-in Cloud Assist.

- The server stores ciphertext and wrapped keys only. It cannot read Documents or
  Transactions.
- Extraction runs on device by default and is good enough for the primary use case —
  total, tax, date, merchant from a receipt photo.
- For hard cases, the user may consent per Document to send redacted extracted text —
  never pixels, never audio — for server-side LLM structuring. Consent is
  per-Document, never sticky, and logged.

## Consequences

Good: the privacy claim is a property of the math, not of our policy or our hosting.
A database dump or a compromised object store yields nothing. The default path also
works offline and costs nothing per user to run.

Bad: no server-side search, sort, or aggregation over the Ledger — all of it moves
client-side (affordable at personal-finance scale; see `docs/crypto-design.md`).
Recovery is unforgiving: passphrase plus recovery key lost means data lost, with no
support path. Cross-client crypto must match exactly, which constrains the mobile
framework choice (ADR 0003). Metadata still leaks and we say so rather than
pretending otherwise.

Rejected — ephemeral decryption: it reads as E2EE to users while leaving the server
operator inside the trust boundary. The gap between the perception and the property
is itself the problem.
