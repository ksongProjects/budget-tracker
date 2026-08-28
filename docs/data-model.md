# Data model

Postgres. Under [ADR 0006](adr/0006-split-trust-model.md) the ledger is plaintext and
the documents are ciphertext.

Legend: `PT` = plaintext, server-readable. `CT` = ciphertext, server-opaque.

## users
| Column | | Notes |
|---|---|---|
| id, email | PT | |
| auth_key_hash | PT | hash of the client-derived `auth_key`, never the password |
| kdf_salt, kdf_params | PT | public by design |
| hard_mode | PT | true = escrow-wrapped DMK deleted (ADR 0008) |
| created_at | PT | |

## wrapped_keys
One row per unlock path for the DMK.

| Column | | Notes |
|---|---|---|
| id, user_id | PT | |
| kind | PT | `password` \| `escrow` \| `device` |
| device_id | PT | null unless kind=`device` |
| wrapped_dmk, nonce | CT/PT | escrow row is deleted on hard mode |

## documents
| Column | | Notes |
|---|---|---|
| id, user_id | PT | |
| kind | PT | `photo` \| `statement` \| `voice` |
| blob_key, byte_size | PT | object-store pointer |
| wrapped_dek, nonce | PT | DEK wrapped by DMK |
| created_at | PT | |
| payload | CT | filename, capture time, device, user note |

## transactions
Plaintext. This is the working table.

| Column | | Notes |
|---|---|---|
| id, user_id | PT | |
| document_id | PT | nullable; link back to the source Capture |
| account_id, merchant_id, category_id | PT | FKs |
| amount_minor, currency | PT | integer minor units — never floats for money |
| occurred_at, posted_at | PT | |
| note | PT | |
| source | PT | `photo` \| `statement` \| `voice` \| `manual` |
| confirmed_at | PT | null until the user confirms; unconfirmed rows stay out of totals |
| rev, created_at, updated_at, deleted_at | PT | soft delete, sync bookkeeping |

Indexes, all leading with `user_id` (ADR 0009):

```sql
(user_id, occurred_at DESC)                  -- workhorse
(user_id, category_id, occurred_at DESC)
(user_id, merchant_id, occurred_at DESC)
(user_id, document_id)
GIN trigram on merchants.name                -- search
```

## line_items
| Column | | Notes |
|---|---|---|
| id, transaction_id | PT | |
| kind | PT | `item` \| `tax` \| `fee` \| `discount` \| `tip` |
| name, quantity, unit_price_minor, total_minor | PT | |
| position | PT | order as printed on the receipt |

Tax and fees are line items with a `kind`, not dedicated columns on `transactions`.
Receipts vary too much for fixed columns, and the sum of line items should reconcile
against the transaction total — store a `reconciled` boolean and surface the mismatch
rather than silently trusting either number.

## merchants, categories, accounts
Per-user rows. `merchants` carries a `canonical_name` plus an alias table, since the
same shop appears as `SQ *BLUE BOTTLE`, `BLUE BOTTLE COFFEE`, and `BLUEBOTTLE.COM`.
Canonicalization is an extractor job, not a client one.

## extractions
| Column | | Notes |
|---|---|---|
| id, document_id | PT | |
| tier | PT | which stage produced the result; the audit trail for a wrong number |
| status | PT | `pending` \| `done` \| `failed` |
| confidence | PT | per-field, JSONB |
| payload | PT | candidate fields before the user confirms |
| derivative_key, derivative_expires_at | PT | scratch bucket, 24h lifecycle |

## audit_log
Append-only. Never updated, never deleted.

| Column | | Notes |
|---|---|---|
| id, user_id, actor | PT | `user` \| `staff` \| `system` |
| action | PT | includes every escrow release step and every staff ledger read |
| occurred_at, detail | PT | |

## Money

Integer minor units everywhere (`amount_minor bigint`), currency code alongside.
Never floating point, never a bare `numeric` without a currency. Multi-currency
transactions store the original amount and currency plus the converted amount and the
rate used, so a later rate revision never silently rewrites history.

## Sync

Clients pull by `updated_at > cursor` for their local cache (ADR 0009) and push with
an incrementing `rev`. Last-write-wins per transaction, with the losing revision
retained as a tombstone — it is the user's money data, and an overwrite they did not
expect must be recoverable.
