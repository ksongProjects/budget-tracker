# Crypto design

Scope set by [ADR 0011](adr/0011-local-first.md): our cryptography protects what
**leaves the device** — Backups. Data at rest on the device is protected by OS file
encryption and the device lock, deliberately: duplicating the OS's job buys
complexity, not security. Exports are plaintext by definition and say so in the UI.

| Data | Protection | Who can read it |
|---|---|---|
| Local Ledger + Documents | OS file encryption, device lock | this device, unlocked |
| Backup archives | client-side AEAD before they leave | password or Recovery Key holder |
| Cloud Assist text (opt-in) | TLS to the model provider | the provider, transiently |
| Exports (CSV/PDF) | none — deliberate | anyone with the file |

## Primitives

| Purpose | Algorithm |
|---|---|
| Password stretching | Argon2id, m=64 MiB, t=3, p=1, 16-byte salt |
| Subkey derivation | HKDF-SHA256 |
| Archive encryption | XChaCha20-Poly1305, framed (see [backup-format.md](backup-format.md)) |
| Key wrapping | XChaCha20-Poly1305, 24-byte random nonce |
| Recovery Key | 32 random bytes, encoded Base32 in groups for human transcription |

`packages/crypto` in TypeScript, one implementation, consumed by React Native and
the web SPA. This is the code where a cross-client mismatch yields unreadable
archives rather than a thrown error, so it ships **published test vectors** and both
clients run them in CI. A vector suite covers: KDF outputs for fixed inputs, wrap /
unwrap round-trips, a complete miniature archive.

## Key hierarchy

```
password
  └─ Argon2id ─ HKDF ──→ KEK            (in memory only; never stored, never leaves)

Recovery Key  (random 32 B, generated once at cloud-backup enablement,
               shown once as key file + QR; never stored by the app)

BMK  (Backup Master Key, random 32 B, per user)
  ├─ wrapped by KEK           ─┐  both wraps embedded in every
  └─ wrapped by Recovery Key  ─┘  archive header → archives are self-contained

AK   (Archive Key, random 32 B, fresh per backup)
  └─ wrapped by BMK           → archive header; seals that archive's frames
```

Opening an archive requires the password **or** the Recovery Key. Nothing else
works, no one else can help, and the enable-backup flow says so before the user can
finish it.

**Password change** rewraps the BMK; new archives carry the new wrap. Archives
written before the change still carry the old-password wrap — they open with the
old password or, always, the Recovery Key. The restore UI must try the Recovery Key
path when a password fails on an old archive, and explain why.

**Recovery Key rotation** (user regenerates it): new archives carry the new wrap;
the old key keeps opening old archives. Prune old archives after rotation if the
old key is considered compromised — the UI offers this.

## What is exposed

- **To the storage provider** (Google Drive or wherever the file goes): ciphertext,
  archive byte size, upload timing and count. No filenames of documents, no
  amounts, no merchants — the manifest is inside the encryption.
- **To a Cloud Assist provider**, per opted-in capture only: redacted extracted
  text. Never pixels, never audio, never the Ledger.
- **On the device**: everything, to whoever holds the unlocked device. Same as any
  local app; the OS lock is the boundary.
- **In exports**: everything in the export, plaintext, deliberately.

## Web bundle integrity

On the web, the served JavaScript is the trust boundary: a malicious bundle defeats
client-side crypto regardless of algorithm choice. Controls, all enforced in CI
where possible:

- Strict Content-Security-Policy; no `unsafe-inline`, no `unsafe-eval` outside the
  WASM allowance.
- Subresource integrity on every asset; zero third-party scripts, period.
- Static hosting with immutable, hash-named assets; the deploy pipeline is the
  attack surface, so it gets 2FA and review like code does.
- The mobile app is the higher-integrity surface and the docs say so rather than
  pretending parity.

## Rules that do not bend

- The password and KEK never leave the device, never touch a backup, never appear
  in logs.
- No home-rolled constructions: libsodium (`react-native-libsodium`, `libsodium-wrappers`
  for WASM) for every primitive.
- Every archive format change bumps the version byte and keeps the
  restore-from-every-prior-version test green ([backup-format.md](backup-format.md)).
- New crypto code lands only with vectors both clients pass in CI.
