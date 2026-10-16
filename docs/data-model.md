# Data model

Local SQLite, one database file per device, canonical
([ADR 0011](adr/0011-local-first.md)). No server tables, no ciphertext columns —
the whole database is plaintext behind the OS's file encryption, and the crypto
applies to Backups ([crypto-design.md](crypto-design.md)).

This doc is the source for the Phase 1 migrations. Where it disagrees with the
code, the code is wrong.

## Conventions

- **Ids** are UUIDv7 text — time-ordered, so they index well and sort usefully.
- **Timestamps** are integer milliseconds UTC. No local-time storage anywhere;
  formatting is a presentation concern.
- **Money** is `amount_minor INTEGER` plus `currency TEXT` (ISO 4217). Never a
  float, never a bare number without its currency.
- **Every user-editable table** carries the merge quartet: `rev`, `updated_at`,
  `deleted_at`, `origin_device`. Anything without it cannot survive a Merge.
- `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000` at every open.

## captures

The provenance record: one row per act of capture, minted on the device that made
it. `capture_id` is the identity that Merge matches on across devices forever.

| Column | Type | Notes |
|---|---|---|
| capture_id | TEXT PK | UUIDv7, minted at capture time |
| kind | TEXT | `photo` \| `statement` \| `voice` \| `manual` |
| captured_at | INTEGER | when the user captured, not when the row was written |
| origin_device | TEXT | device id that minted it |
| document_path | TEXT | app-private path; null for `manual` |
| document_hash | TEXT | content hash; null for `manual` |
| document_bytes | INTEGER | null for `manual` |
| rev, updated_at, deleted_at | | merge quartet |

Documents are files on disk, not blobs in SQLite: keeping multi-megabyte images out
of the database keeps the snapshot small and the archive streamable.

## extractions

One row per extraction run. Kept after confirmation — when a number is wrong, this
is the audit trail that says which tier produced it.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| capture_id | TEXT FK | |
| tier | INTEGER | 0–3, per [extraction.md](extraction.md) |
| engine | TEXT | e.g. `vision`, `mlkit`, `tesseract-wasm`, `whisper-small`, `apple-fm`, `gemini-nano`, `cloud-assist` |
| status | TEXT | `pending` \| `done` \| `failed` |
| candidate | TEXT (JSON) | proposed fields before confirmation |
| confidence | TEXT (JSON) | per-field, 0–1 |
| ran_at, duration_ms | INTEGER | feeds the perf budgets |

`candidate` and `confidence` are JSON because pre-confirmation shape is genuinely
variable — schema-on-read here, schema-on-write everywhere downstream.

## transactions

The working table. This is what every screen reads.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| capture_id | TEXT FK | every write path mints one; nullable only for rows from before it did |
| account_id, merchant_id, category_id | TEXT FK | |
| amount_minor | INTEGER | minor units |
| currency | TEXT | ISO 4217 |
| occurred_at | INTEGER | when the money was spent |
| posted_at | INTEGER | nullable; statements only |
| note | TEXT | |
| source | TEXT | `photo` \| `statement` \| `voice` \| `manual` |
| confirmed_at | INTEGER | null until confirmed; unconfirmed rows are excluded from every total |
| fx_original_minor, fx_original_currency, fx_rate | | nullable; original amount preserved so a later rate revision never rewrites history |
| reconciled | INTEGER | 0/1: do the line items sum to the total |
| rev, updated_at, deleted_at, origin_device | | merge quartet |

Indexes — `occurred_at DESC` is the workhorse because it serves the screen users
live on:

```sql
CREATE INDEX tx_occurred      ON transactions(occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tx_category      ON transactions(category_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tx_merchant      ON transactions(merchant_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tx_capture       ON transactions(capture_id);
CREATE INDEX tx_unconfirmed   ON transactions(occurred_at DESC) WHERE confirmed_at IS NULL AND deleted_at IS NULL;
```

Partial indexes on `deleted_at IS NULL` keep tombstones out of the hot paths.

Full-text search over merchant name and note via an FTS5 virtual table kept in sync
by triggers — SQLite's FTS5 replaces the Postgres trigram index from the old design.

## line_items

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| transaction_id | TEXT FK | |
| kind | TEXT | `item` \| `tax` \| `fee` \| `discount` \| `tip` |
| name | TEXT | |
| quantity, unit_price_minor, total_minor | INTEGER | |
| position | INTEGER | order as printed |
| rev, updated_at, deleted_at, origin_device | | merge quartet |

Tax and fees are rows with a `kind`, not columns on `transactions` — receipts vary
too much for fixed columns. The sum of items is checked against the transaction
total and the mismatch is surfaced via `reconciled`, never silently trusted either
way.

## Records

What every capture path writes and every screen shows is a **record**
(`packages/db/src/records.ts`): the transaction, its merchant's display name, its
items, and its total, written by one function — `RecordRepository.write` — in
one transaction.

| Source | Records per capture | Merchant | Items |
|---|---|---|---|
| `photo` | 1 | as read, editable | the receipt's rows |
| `voice` | one per merchant named | as said | each thing said with a price |
| `statement` | one per row, on the row's date | resolved from the bank description; the description itself is the note | none stored |
| `manual` | 1 | as typed | none stored |

A record with no stored line items reads back **one implied item** for its whole
amount. Implied items are computed, never written: a migration that wrote them
would run once per device, mint different ids for the same purchase, and Merge
would keep both.

## merchants, categories, accounts

Plain reference tables, each with the merge quartet. `merchants` carries
`canonical_name` plus a `merchant_aliases` table (`alias`, `merchant_id`), since one
shop appears as `SQ *BLUE BOTTLE`, `BLUE BOTTLE COFFEE`, and `BLUEBOTTLE.COM`.
Canonicalization is a pure function in `packages/db`, tested against a fixture list
of real-world strings.

## settings

Single-row table: currency default, backup cadence, last successful backup, Drive
connection state, Cloud Assist opt-in default (off). Never merged — settings are
per-device by design.

## Merge

Restore and import both run Merge; neither ever blind-overwrites
([backup-format.md](backup-format.md#restore--merge)).

Rules:

1. Match rows by primary key; `captures` match on `capture_id`, which is stable
   across every device that ever held the row.
2. Higher `rev` wins. Equal `rev` → later `updated_at` wins. Still tied → higher
   `origin_device` wins, so the result is deterministic and order-independent
   (`A ∪ B == B ∪ A`, which is the property the Phase 4 tests assert).
3. The losing revision is written to `tombstones` (`table_name`, `row_id`, `rev`,
   `payload` JSON, `superseded_at`) — never dropped. It is the user's money data;
   an overwrite they did not expect must be recoverable.
4. `deleted_at` is a value like any other: a delete can lose to a later edit.
5. Reference rows (merchants, categories, accounts) merge by id; a merchant present
   only in the incoming archive is inserted with its aliases.

Merge runs in one transaction. A failed merge leaves the Ledger exactly as it was.

## Migrations

Versioned, forward-only, applied at startup inside a transaction; `user_version`
tracks the applied version. Every migration ships with a test that applies it from
zero **and** from each prior version. Backups record `schema_version` in their
header, and restoring an older archive runs its rows through the same migration
chain before Merge.
