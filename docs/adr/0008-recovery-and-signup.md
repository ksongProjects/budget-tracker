# ADR 0008 — Escrowed document keys, no signup ceremony

**Status**: accepted · 2026-08-28

## Context

ADR 0001 required a 12-word recovery phrase at registration, with permanent data loss
as the failure mode. That is friction at the worst possible moment and a support
burden with no support path.

Under ADR 0006 the stakes changed. The ledger is server-readable, so losing document
keys costs the user their original scans — not their financial history. Recovery moved
from catastrophic to annoying, which justifies a much lighter mechanism.

## Decision

**Signup is email and password. Nothing else.** No phrase, no ceremony, no
verification quiz.

Document key handling:

- Client generates a Document Master Key (DMK) at registration.
- DMK is wrapped by a key-encryption key derived from the password via Argon2id, and
  that wrapped copy is stored server-side. Normal login unlocks it.
- DMK is **also** wrapped under a KMS-held escrow key. This is the support path.

Escrow release requires all of: an authenticated session, email confirmation, a push
notification to every registered device, and a 72-hour delay. Every release is written
to an append-only audit log the user can read in settings. The delay and the
notifications are the protection — a silent release is not possible, and a user who
did not initiate one has three days to cancel it.

**Hard mode** in settings deletes the escrow copy. From then on a forgotten password
means the documents are gone, and the UI says exactly that before the user confirms.
The ledger is unaffected either way.

## Password reset

Two outcomes, and the UI must distinguish them:

- **Ledger**: always recoverable. Ordinary reset flow, immediate.
- **Documents**: recoverable via escrow with the 72-hour path, or lost if the user
  enabled hard mode.

A reset that silently orphans a user's receipt images without telling them is a
support disaster. The reset screen states which of the two the user is getting.

## Consequences

Good: signup converts. Support has a real path. The worst case for a normal user is a
three-day wait, not permanent loss.

Bad: for escrowed users the operator can, through a logged and notified procedure,
decrypt documents. That is a genuine reduction and the privacy page says so in those
words. Hard mode exists for users who want the ADR 0001 guarantee, and it is a
setting rather than the default because most people should not be handed an
irreversible decision on day one.

Build cost: KMS integration, an audit log, a delayed-job pipeline, and device push
fan-out. Meaningfully cheaper than an HSM enclave, meaningfully more than nothing.
