# Crypto design

Goal: the server operator, a database dump, and a compromised object store all yield
nothing readable. Achieved for Document and Transaction *content*. Not achieved for
metadata — see "What still leaks".

## Primitives

| Purpose | Algorithm | Notes |
|---|---|---|
| Passphrase stretching | Argon2id, m=64 MiB, t=3, p=1, 16-byte salt | salt stored server-side, public |
| Subkey separation | HKDF-SHA256 over Argon2 output | yields `auth_key` and `KEK`, 32 B each |
| Content encryption | XChaCha20-Poly1305 (AEAD), 24-byte random nonce | libsodium `crypto_aead_xchacha20poly1305_ietf` |
| Key wrapping | XChaCha20-Poly1305 | same primitive, no second implementation to audit |
| Recovery key | 128-bit random, rendered as 12 BIP39 words | |

One TypeScript package (`packages/crypto`) implements all of this and is consumed by
both React Native and the web SPA. This is the whole reason the mobile framework is
React Native — see ADR 0003. A divergence between two crypto implementations
produces unreadable user data, which is unrecoverable, so there must only be one.

## Key hierarchy

```
passphrase
  └─ Argon2id ─→ 64 B ─ HKDF ─┬─→ auth_key   (sent to server for login, only this)
                              └─→ KEK        (never leaves device)

MK  (random 32 B, generated once at registration)
  ├─ wrapped by KEK           → stored server-side  (normal unlock)
  ├─ wrapped by recovery key  → stored server-side  (passphrase loss)
  └─ wrapped by device key    → stored in Keychain / Android Keystore (biometric unlock)

DEK (random 32 B, per Document and per Transaction)
  └─ wrapped by MK            → stored server-side beside the ciphertext
```

Two properties this buys:

- **Passphrase change is cheap.** Rewrap the MK. Zero re-encryption of content.
- **Login secret ≠ encryption secret.** The server sees `auth_key` and can never
  derive the KEK from it, because HKDF is one-way and the two subkeys are
  independent. Never collapse these into one value.

## Recovery — decide this before writing any code

If the user loses both the passphrase and the recovery key, **their data is
permanently gone.** The server cannot reset it. This is the cost of E2EE and it must
be stated in the registration flow in plain language, not buried in a tooltip.

Registration flow, non-skippable:

1. Generate MK and recovery key.
2. Show the 12-word recovery phrase. Require the user to re-enter 3 random words
   before continuing.
3. Offer biometric unlock, wrapping MK with a device key.

Add a per-device wrapped MK on each new device login, so a single device loss is
never a data loss event.

## Cloud Assist boundary

When the user consents on a specific Document:

- The client sends **redacted extracted text only**. Never the image. Never the
  audio. Text is redactable and reviewable; pixels are not.
- The client shows the exact text before it is sent, with detected account numbers,
  card PANs, and addresses masked by default.
- The server holds the text in memory for the duration of the job, returns structured
  JSON, and persists nothing but a ConsentEvent row.
- The result comes back, the client encrypts it, and the ciphertext is stored.

Default posture is `on_device`. Cloud Assist is per-Document and never sticky — no
"always allow" switch, because the sensitivity varies per document, not per user.

## Blob handling

Uploads go client → object storage directly via presigned PUT. Ciphertext never
transits an API pod, so API pods stay small and stateless and there is no plaintext
in application memory on the default path.

## What still leaks

Be honest about this in the privacy policy:

- **Metadata**: account existence, login times, device count, number of Documents and
  Transactions, their sizes, and their creation timestamps.
- **Timing**: a burst of captures on a Saturday night is visible as a pattern even
  though the content is not.
- **Ciphertext size**: a 40-line-item receipt is bigger than a coffee. Pad
  Transaction ciphertext to fixed buckets (e.g. 256 B / 1 KiB / 4 KiB) to blunt this.

We do **not** attempt to hide metadata. Claiming otherwise would be false.

## Consequence for product features

The server cannot sort, filter, aggregate, or search the Ledger. All of that runs
client-side over the decrypted set. This is fine at personal-finance scale: 10k
transactions at ~200 B each is ~2 MB, which decrypts in well under a second and fits
in memory on any phone from the last decade. Sync deltas keep it from being refetched.

If server-side search ever becomes necessary, the option is blind indexing (HMAC of
normalized merchant name under a client-held key) for equality lookups only. Do not
add it speculatively — it leaks a merchant-frequency histogram.
