# ADR 0010 — Metadata hardening deferred

**Status**: accepted · 2026-08-28

## Context

ADR 0001 called for padding ciphertext to size buckets, batching sync on a jitter
timer, and trimming access logs, so the server could not infer spending patterns from
traffic shape.

## Decision

Do none of it for now. Document the exposure instead.

## Rationale

Those measures assume the content is already protected. Under ADR 0006 the server
reads the ledger directly, so inferring a spending pattern from ciphertext sizes is
work no adversary would bother doing — the amounts are right there in a table.
Building it would be effort spent on the least significant channel.

## What we say instead

The privacy page states plainly that transaction data is readable by our servers and
that document metadata — count, size, upload time — is retained alongside the
encrypted blobs.

## Revisit when

Hard mode (ADR 0008) grows a meaningful user base, or if a future mode makes the
ledger blind again. At that point padding and sync jitter become worth their cost,
and this ADR gets superseded rather than quietly ignored.
