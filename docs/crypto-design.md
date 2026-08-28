# Crypto design

Scope narrowed by [ADR 0006](adr/0006-split-trust-model.md). Two data classes, two
protections. Read that ADR first — this doc is the mechanism, not the reasoning.

| Class | Protection | Server can read? |
|---|---|---|
| Documents — receipt images, statement PDFs, audio | client-side AEAD, keys wrapped under user password | no, except via escrow (ADR 0008) |
| Ledger — transactions, line items, merchants, amounts | TLS in transit, KMS envelope encryption at rest | **yes** |
| Cropped derivatives sent to the extractor | TLS only, 24h scratch lifecycle | yes, transiently |

## Primitives

| Purpose | Algorithm |
|---|---|
| Password stretching | Argon2id, m=64 MiB, t=3, p=1, 16-byte salt |
| Subkey separation | HKDF-SHA256 → `auth_key`, `KEK` |
| Document encryption | XChaCha20-Poly1305, 24-byte random nonce |
| Key wrapping | XChaCha20-Poly1305 |
| Ledger at rest | Postgres + KMS envelope encryption |

`packages/crypto` in TypeScript, one implementation, consumed by React Native and the
web SPA. Smaller than the original design's surface but still the code where a
cross-client mismatch yields unreadable blobs rather than a thrown error, so it gets
test vectors and both clients run them in CI.

## Key hierarchy

```
password
  └─ Argon2id ─ HKDF ─┬─→ auth_key   (login only; server stores a hash of this)
                      └─→ KEK        (never leaves device)

DMK  (Document Master Key, random 32 B, per user, generated at registration)
  ├─ wrapped by KEK        → server-side   (normal unlock)
  ├─ wrapped by KMS escrow → server-side   (support path, ADR 0008; deleted in hard mode)
  └─ wrapped by device key → Keychain / Android Keystore (biometric unlock)

DEK  (random 32 B, per document)
  └─ wrapped by DMK        → stored beside the blob
```

`auth_key` and `KEK` are independent HKDF outputs. The server never receives the
password or anything from which the KEK can be derived. Never collapse them.

Password change rewraps the DMK only. Documents are never re-encrypted.

## Escrow release

Requires all four: authenticated session, email confirmation, push to every registered
device, 72-hour delay. Written to an append-only audit log visible to the user in
settings. Hard mode deletes the escrow-wrapped DMK, after which no release is
possible and the UI says so before the user confirms.

## The crop boundary

Cropping is a security control, not a UI nicety. It is the only thing standing between
a statement's account numbers and the server-readable side.

- Auto-crop runs on-device. The user confirms the crop before anything uploads.
- Statement default crop is conservative: transaction rows only, headers and balance
  blocks excluded.
- Detected PANs, account numbers, and routing numbers are masked in the derivative by
  default, with the user able to unmask deliberately.
- The **original** is encrypted under a per-document DEK and uploaded to the blob
  store. The **cropped derivative** goes to the extractor over TLS and lives in a
  scratch bucket with a 24-hour lifecycle rule.

The extractor holds no key capable of opening an original.

## Blob handling

Presigned PUT straight from client to object storage, so ciphertext never passes
through an API pod.

## What is exposed

Stated plainly here so the privacy page can be written from it:

- **The full ledger.** Every merchant, amount, date, and category is readable by the
  service. A breach, subpoena, or malicious insider gets a complete spending profile.
- **Cropped derivatives**, for up to 24 hours.
- **Document metadata**: count, size, upload time.

Not exposed: original receipt images, original statement PDFs, original audio.

Product copy always ships both halves together — "your documents are end-to-end
encrypted; your transaction data is encrypted in transit and at rest and processed on
our servers." Dropping the second half would be a false claim.

## Operational controls the ledger now depends on

Cryptography no longer protects the ledger, so these are not optional extras:

- Row-level `user_id` scoping enforced at the repository layer (ADR 0009).
- Audit logging on all ledger reads by staff tooling.
- No third-party analytics or error reporters that can receive transaction content.
- Short retention on derived exports and scratch data.
- Least-privilege IAM on the KMS escrow key, separate from application credentials.
