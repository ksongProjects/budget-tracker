# REST API (v1)

JSON over TLS 1.3. Short-lived bearer access token plus rotating refresh token.

Two services behind one gateway: `api` (auth, keys, documents, ledger) and
`extractor` (extraction jobs, [ADR 0007](adr/0007-server-side-processing.md)). Clients
talk only to the gateway.

## Auth and keys

```
POST   /v1/auth/register      { email, auth_key, kdf_salt, kdf_params, wrapped_dmk[] }
POST   /v1/auth/login         { email, auth_key } → { access, refresh, wrapped_keys[] }
POST   /v1/auth/refresh
POST   /v1/auth/logout
POST   /v1/auth/password      { new_auth_key, new_wrapped_dmk, kdf_salt, kdf_params }
GET    /v1/keys               → wrapped_keys[]
POST   /v1/keys               { kind, wrapped_dmk, nonce }   register a device
DELETE /v1/keys/{id}                                         revoke a device
```

`auth_key` is the HKDF subkey. The password never reaches the server in any form.

## Recovery (ADR 0008)

```
POST   /v1/recovery/request   → { release_id, eligible_at }   starts the 72h clock
POST   /v1/recovery/confirm   { release_id, email_token }
POST   /v1/recovery/cancel    { release_id }                  any device, any time before release
GET    /v1/recovery/{id}      → { status, eligible_at, notified_devices[] }
DELETE /v1/keys/escrow        → hard mode; irreversible, requires re-auth
```

Password reset for the **ledger** is the ordinary flow and is immediate. Document
recovery is the above. The client must show the user which of the two they are
getting — a reset that silently orphans their receipts is a support disaster.

## Documents

```
POST   /v1/documents          { kind, byte_size, wrapped_dek, nonce, payload }
                              → { id, upload_url }      presigned PUT, client → object store
GET    /v1/documents?cursor=
GET    /v1/documents/{id}     → metadata + presigned GET
DELETE /v1/documents/{id}
```

Ciphertext never transits an API pod.

## Extraction

```
POST   /v1/extractions        { document_id, derivative_upload }  cropped derivative
                              → { extraction_id }
GET    /v1/extractions/{id}   → { status, tier, confidence, payload }
POST   /v1/extractions/{id}/confirm  { edits } → committed transaction(s)
```

The derivative is the cropped, redacted image or the PDF page range — never the
original. Scratch storage expires in 24 hours.

## Ledger (ADR 0009)

```
GET    /v1/transactions?from=&to=&merchant_id=&category_id=&account_id=
                        &min_amount=&max_amount=&q=&cursor=&limit=
GET    /v1/transactions/{id}
POST   /v1/transactions            manual entry
PATCH  /v1/transactions/{id}
DELETE /v1/transactions/{id}       soft delete
POST   /v1/transactions/batch      bulk confirm / bulk categorize

GET    /v1/summary?group_by=category|merchant|month&from=&to=
GET    /v1/summary/trends?window=
GET    /v1/search?q=               merchant + note full-text

GET    /v1/merchants   /v1/categories   /v1/accounts    CRUD
GET    /v1/sync?since=cursor       delta for the client-side cache
```

Every ledger query is scoped to `user_id` at the repository layer, not at the handler.
A missing scope here is a cross-tenant leak rather than an empty result — enforce it
structurally and test for it directly.

## Audit

```
GET    /v1/audit?cursor=      the user's own log: escrow releases, staff reads, device changes
```

## Errors

RFC 9457 problem+json. Rate limits per user and per IP on auth, recovery, and
extraction routes. Recovery endpoints additionally rate-limit per account regardless
of source IP.
