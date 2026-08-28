# CONTEXT

Shared vocabulary for budget-tracker. Use these words exactly in code, schemas, and
docs. If a concept is not here, it is not yet real.

## Core nouns

**Capture** — one act of recording spending. Four kinds: `photo` (receipt),
`statement` (bank PDF/CSV), `voice` (audio), `manual` (typed). The user-facing unit:
"I captured lunch."

**Document** — the raw artifact behind a Capture: receipt image, statement PDF, audio
file. Encrypted client-side, stored as an opaque blob. The server cannot read it.

**Derivative** — the cropped, redacted version of a Document that is sent to the
extractor. Server-readable, scratch storage, 24-hour lifetime. The Document/Derivative
split is the central privacy boundary of the system — see
[ADR 0006](docs/adr/0006-split-trust-model.md).

**Crop** — the user-confirmed region of a Document that becomes the Derivative. A
security control, not a UI nicety: it is what keeps account numbers and balances out
of the server-readable side.

**Extraction** — the extractor service turning a Derivative into candidate data, and
the record of that run. Carries the `tier` that produced it and per-field confidence,
so any wrong number is traceable.

**Transaction** — one settled spend: amount, currency, occurred-at, merchant,
category, account. The ledger row. Plaintext and server-queryable.

**LineItem** — a row within a Transaction. Tax, fees, discounts, and tips are
LineItems with a `kind`, not columns on Transaction.

**Ledger** — the user's full set of Transactions. Server-side, indexed, queryable.
Clients keep a local SQLite cache of the recent window for fast paint and offline
reads, but the server is the system of record.

**Confirm** — the user accepting or editing candidate data. Nothing counts toward a
total before this; unconfirmed rows have a null `confirmed_at`.

## Keys and recovery

**DMK** — Document Master Key, per user. Wrapped three ways: by the password-derived
KEK, by the KMS escrow key, and by a per-device key.

**DEK** — per-document key, wrapped by the DMK.

**Escrow** — the KMS-wrapped DMK copy that makes support-assisted recovery possible.
Release needs email confirmation, device notification, and a 72-hour delay, all
logged.

**Hard mode** — user setting that deletes the escrow copy. Forgotten password then
means the Documents are unrecoverable. The Ledger is unaffected either way.

## Verbs

**capture** → record spending. **crop** → mark what may leave the device.
**extract** → Derivative becomes candidate data. **confirm** → candidate becomes a
Transaction. **sync** → refresh the local cache.

## What the server can and cannot read

Cannot: original receipt images, statement PDFs, audio.

Can: the entire Ledger — every merchant, amount, and date — plus Derivatives for 24
hours and document metadata. Say both halves whenever describing the product. "Your
documents are end-to-end encrypted; your transaction data is encrypted in transit and
at rest and processed on our servers."

## Non-goals

Plaid-style bank connections. Shared or multi-user budgets. Investment tracking. Bill
prediction. Each reopens the privacy design.
