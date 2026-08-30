# ADR 0006 — Split trust: E2EE documents, server-readable ledger

**Status**: superseded by [ADR 0011](0011-local-first.md) · 2026-08-29 · supersedes [ADR 0001](0001-privacy-posture.md)

## Context

ADR 0001 put the whole system behind E2EE. That bought a strong privacy property and
charged for it in three places we decided we were not willing to pay: a recovery
ceremony at signup, no server-side ledger queries, and a processing engine confined to
the device.

Full E2EE remains the strongest option and is documented in ADR 0001 for the record.
This ADR trades some of it deliberately.

## Decision

Split the data into two classes with different protections.

**Documents — E2EE.** Receipt images, statement PDFs, and audio blobs are encrypted
client-side with keys the server cannot use without invoking escrow (ADR 0008). The
server stores opaque bytes.

**Ledger — server-readable.** Transactions, line items, merchants, amounts, dates, and
categories are stored plaintext in Postgres, encrypted at rest via KMS envelope
encryption and in transit via TLS. The server queries, aggregates, and processes them
freely.

The bridge between them: the client crops and redacts, then the extracted content
crosses into the server-readable side. The raw artifact never does.

## What this actually protects

A statement PDF contains far more than the transactions on it — account and routing
numbers, running balances, the institution's own metadata, the account holder's
address, sometimes a second person on a joint account. A receipt photo contains
whatever else was on the table and, in a storefront, whoever was behind the counter.
Keeping those blind is worth real money in breach exposure, and none of it is needed
to run a budget app.

## What this does not protect

The ledger is the sensitive part, and it is readable. After a perfect crop the server
still knows every merchant, every amount, and every date. A breach, a subpoena, or a
malicious insider gets a complete picture of the user's life from the ledger alone.

We accept this. It is the same posture as every mainstream budgeting product. What we
do not do is describe it as end-to-end encrypted, because for the data that matters
most it is not. Product copy says "your documents are end-to-end encrypted; your
transaction data is encrypted in transit and at rest and processed on our servers."
Both halves of that sentence ship together, always.

## Consequences

Good: real server-side ledger queries (ADR 0009), a server-side processing engine
(ADR 0007), ordinary password reset for the ledger, no signup ceremony (ADR 0008), and
a much softer worst case — losing document keys costs the original scans, not the
financial history.

Bad: the privacy claim is now partly policy rather than math, so it needs the
operational backing that policy claims require — tight IAM, audit logging on ledger
access, no third-party analytics touching transaction content, and short retention on
anything derived. Metadata hardening is dropped (ADR 0010) because it would be
protecting the container while the contents are readable.
