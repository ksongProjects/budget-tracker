# ADR 0009 — Server-side ledger queries

**Status**: accepted · 2026-08-28

## Context

With the ledger plaintext (ADR 0006), the server can index and query it. ADR 0001 had
forced every filter and aggregate onto the client.

Worth recording honestly: at personal-finance scale the client-side approach was not
slower. Ten thousand transactions is a few megabytes, and an on-device SQLite query
answers in single-digit milliseconds, where a network round trip costs 50–200 ms on
mobile. Server-side query wins on flexibility and on not shipping the whole ledger to
every device, not on raw latency.

## Decision

The API exposes real query endpoints — filter by date range, merchant, category,
account, and amount; server-computed aggregates for the dashboards; full-text search
over merchant and note fields.

Indexes: `(user_id, occurred_at DESC)` as the workhorse, plus `(user_id, category_id,
occurred_at)`, `(user_id, merchant_id, occurred_at)`, and a GIN trigram index on
merchant name for search. Every index leads with `user_id`; there is no query in this
system that legitimately crosses users.

## Keep the local cache anyway

Clients still hold a local SQLite mirror of recent transactions, synced by cursor.
It serves the initial paint, offline browsing, and optimistic writes. The server is
the system of record and owns anything beyond the cached window or any aggregate the
cache cannot answer.

This is the part most likely to be dropped as "extra work." Do not drop it — without
it, every app open blocks on the network and the app feels slow in exactly the moment
users judge it.

## Consequences

Good: arbitrary reporting without shipping the ledger to the device. New analytics
ship server-side without an app release. Large ledgers stay usable on cheap phones.

Bad: every query is a row-level authorization decision, and a missing `user_id`
predicate is a cross-tenant data leak rather than an empty result. Enforce it at the
repository layer so no handler can construct a ledger query without a user scope, and
test for it directly.

Postgres is now on the hot path for every screen. Watch the aggregate endpoints;
pre-compute monthly rollups if the dashboards get slow rather than adding read
replicas first.
