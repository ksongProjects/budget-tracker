# Data model

Postgres. The rule: **anything the server can read is either operational metadata or
a mistake.** Every column below is marked.

Legend: `PT` = plaintext, server-readable. `CT` = ciphertext, server-opaque.

## users
| Column | | Notes |
|---|---|---|
| id | PT | uuid |
| email | PT | login identifier |
| auth_key_hash | PT | server-side hash of the client-derived `auth_key` |
| kdf_salt, kdf_params | PT | public by design; client needs them to derive the KEK |
| created_at | PT | |

## wrapped_keys
One row per way of unlocking the MK.

| Column | | Notes |
|---|---|---|
| id, user_id | PT | |
| kind | PT | `passphrase` \| `recovery` \| `device` |
| device_id | PT | null unless kind=`device` |
| wrapped_mk | CT | MK wrapped by KEK / recovery key / device key |
| nonce | PT | random, public |

## documents
| Column | | Notes |
|---|---|---|
| id, user_id | PT | |
| kind | PT | `photo` \| `statement` \| `voice` — needed to route jobs |
| blob_key, byte_size | PT | object-store pointer |
| wrapped_dek, nonce | PT/CT | DEK wrapped by MK |
| created_at | PT | unavoidable write timestamp |
| payload | CT | filename, capture time, device, any user note |

## transactions
| Column | | Notes |
|---|---|---|
| id, user_id | PT | |
| document_id | PT | nullable; links back to source Capture |
| wrapped_dek, nonce | PT/CT | |
| payload | CT | amount, currency, occurred_at, merchant, category, account, line items, tax, fees |
| rev, updated_at, deleted_at | PT | sync bookkeeping only |

Line items live **inside** the encrypted payload, not in a separate table. A separate
table would leak the item count of every purchase, and there is no server-side query
that would justify it.

Note what is *not* here: no plaintext `amount`, no plaintext `occurred_at`, no
plaintext `merchant`. That is deliberate and it is why filtering, sorting, and
aggregation all run client-side. Adding a plaintext `occurred_month` "just for
pagination" would leak a spending-timing profile — do not.

Pad `payload` to fixed size buckets before encrypting, so ciphertext length does not
reveal receipt complexity.

## extractions
| Column | | Notes |
|---|---|---|
| id, document_id | PT | |
| tier | PT | `0`–`3`; operational metric, and the user's audit trail |
| posture | PT | `on_device` \| `cloud_assist` |
| status | PT | `pending` \| `done` \| `failed` |
| payload | CT | the candidate fields |

## consent_events
Append-only. Never updated, never deleted.

| Column | | Notes |
|---|---|---|
| id, user_id, document_id | PT | |
| granted_at, scope | PT | what the user allowed to be sent |
| text_sha256 | PT | hash of the exact redacted text sent, so the user can verify later |

## Sync

Clients pull by `updated_at > cursor` and push ciphertext rows with an incrementing
`rev`. Conflicts resolve last-write-wins per Transaction, with the loser retained as
a tombstoned revision — never silently dropped, since it is the user's money data and
they may need to see what was overwritten.
