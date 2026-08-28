# REST API (v1)

JSON over TLS 1.3. Bearer access token, short-lived, plus a rotating refresh token.
Every request body containing user content carries ciphertext; the server validates
shape and size, never content.

## Auth and keys

```
POST   /v1/auth/register      → { user_id, kdf_salt, kdf_params }
POST   /v1/auth/login         { email, auth_key } → { access, refresh, wrapped_keys[] }
POST   /v1/auth/refresh
POST   /v1/auth/logout
GET    /v1/keys               → wrapped_keys[]           (all unlock paths)
POST   /v1/keys               { kind, wrapped_mk, nonce } (register a new device)
PUT    /v1/keys/passphrase    { new_wrapped_mk, kdf_salt, kdf_params, new_auth_key }
DELETE /v1/keys/{id}          (revoke a device)
```

`auth_key` is the HKDF subkey, not the passphrase and not the KEK. The passphrase
never reaches the server in any form.

## Documents

```
POST   /v1/documents          { kind, byte_size, wrapped_dek, nonce, payload }
                              → { id, upload_url }     presigned PUT, direct to object store
GET    /v1/documents?cursor=  → page of metadata
GET    /v1/documents/{id}     → metadata + presigned GET
DELETE /v1/documents/{id}
```

Ciphertext blobs never pass through an API pod.

## Extraction (Cloud Assist only — the on-device path calls nothing)

```
POST   /v1/extract/text       { document_id, redacted_text, consent_token }
                              → { job_id }
POST   /v1/extract/audio      { document_id, audio_ref, consent_token }
                              → { job_id }
GET    /v1/jobs/{job_id}      → { status, result | error }
```

`consent_token` is minted client-side per Document and recorded as a ConsentEvent.
No token, no processing — the server rejects rather than infers consent.

## Ledger

```
POST   /v1/transactions       ciphertext row(s), batched
PATCH  /v1/transactions/{id}
DELETE /v1/transactions/{id}
GET    /v1/sync?since=cursor  → { transactions[], documents[], next_cursor }
```

There is no `GET /v1/transactions?merchant=…&from=…`. The server cannot answer it.
Clients pull the delta and query locally.

## Errors

RFC 9457 problem+json. Rate limits per user and per IP on auth and extraction routes.
