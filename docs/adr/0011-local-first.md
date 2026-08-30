# ADR 0011 — Local-first: the device is the system of record

**Status**: accepted · 2026-08-29 · supersedes [ADR 0005](0005-server-stack.md),
[ADR 0006](0006-split-trust-model.md), [ADR 0007](0007-server-side-processing.md),
[ADR 0008](0008-recovery-and-signup.md), [ADR 0009](0009-server-side-ledger-queries.md),
[ADR 0010](0010-metadata-hardening-deferred.md)

## Context

ADR 0006 split trust: E2EE documents, server-readable ledger. That bought server-side
queries and a soft recovery story, and charged for it in the one place that matters
most — the ledger, the actual sensitive data, was readable by the operator, and every
control protecting it was policy rather than math.

This ADR reverses the trade. The full spending history never leaves the user's
hardware in readable form. There is no server ledger, no account system, and no
operator who can be breached, subpoenaed, or compelled into exposing a user's
financial life.

The superseded ADRs are kept, as always, because they record real analysis: ADR 0001
and 0002 turn out to have been mostly right, and ADR 0009's honest note — that
on-device SQLite at personal-finance scale answers in single-digit milliseconds —
is now a supporting argument rather than a concession.

## Decision

**1. The device is the system of record.** The canonical store is a local SQLite
database on each device (`expo-sqlite` on mobile). No server ledger. No accounts. No
live sync service. A fresh install has an empty database: no local data, no data.

Documents (receipt photos, statement PDFs, audio) live in app-private storage beside
the database, referenced by path. At rest they are protected by OS file encryption
and the device lock; the crypto we build ourselves applies to what leaves the device.

**2. Backups are the durability and portability story.** A backup is a single
encrypted archive: a consistent database snapshot (`VACUUM INTO`) plus the document
files. Produced automatically on app background/exit (cheap at this scale) and by a
best-effort scheduled background task — iOS background execution is opportunistic,
so the promise is "on every exit, plus roughly daily when the OS allows," never a
guaranteed timetable.

Exports (CSV of transactions and line items; PDF report) are plaintext by definition.
The export screen says so before writing the file.

**3. Cross-device movement is file-mediated, user-controlled.** Devices do not sync.
A backup file moves between them — manually (share sheet, USB, any cloud app the
user already has) or via the built-in connector: **Google Drive `appDataFolder`**,
an app-private, narrowly-scoped OAuth folder invisible in the Drive UI. The archive
is encrypted client-side before upload, so Drive holds only ciphertext — the E2EE
property costs Google nothing in trust. Additional connectors (Dropbox, WebDAV) and
an optional first-party blob store can come later without changing the model.

Import is a merge, not a file-load: rows match on a stable `capture_id` (UUID minted
at capture), last-write-wins by `updated_at`, losing revisions retained as
tombstones. Money data is never silently overwritten.

**4. Web is a reader/companion that hydrates from backups.** The Vite SPA
(ADR 0004, now mandatory rather than preferred — there is no server to render from)
loads a backup via file picker or the Drive connector, decrypts in the browser, and
works from **official SQLite WASM over OPFS**, run in a Web Worker. OPFS is a
per-origin cache that the browser may evict; the backup file remains the durability
story, which is exactly the model everywhere else. Strict CSP, subresource
integrity, and zero third-party scripts, because on the web the served JavaScript
*is* the trust boundary and a compromised bundle defeats client-side crypto.

**5. Extraction runs on-device.** The tiered pipeline from `docs/extraction.md`
survives intact; only its location moves:

- **OCR**: iOS Vision / Android ML Kit (100–300 ms). Web: PDF text layer first;
  Tesseract.js WASM with client-side deskew/threshold preprocessing for images.
- **STT**: `whisper.cpp` quantized on-device (voice notes are seconds long; the
  battery cost of continuous transcription is irrelevant here).
- **Tier 3 LLM structuring** (line items, free-form voice): the OS-provided
  on-device models where available — Apple Foundation Models (~3B, built for
  extraction), Gemini Nano via LiteRT-LM — at zero download and zero cloud. For hard
  cases, a **per-capture, opt-in** cloud call sending redacted extracted *text*,
  never pixels or audio: ADR 0001's "Cloud Assist by consent," revived. Devices
  without an OS model get Tiers 0–2 (total, date, merchant — the primary use case)
  plus the opt-in path.

Nothing enters the ledger unconfirmed. With a small model proposing numbers, the
confirm-before-commit rule matters more than ever, not less.

**6. Recovery: a recovery key, minted when cloud backup is enabled.** No signup
exists, so there is no signup ceremony — the moment of truth is enabling cloud
backup, and that is when the app generates a random recovery key, shown once as a
key file and QR to print or drop in a password manager. The backup master key (BMK)
is wrapped twice: by the password-derived KEK (Argon2id → HKDF, parameters per
`docs/crypto-design.md`) and by the recovery key. No escrow, no operator path, no
72-hour clock — there is no operator. Losing both the password and the recovery key
means the backups are unreadable, and the UI says exactly that at setup.

## What remains server-side

Nothing, for the MVP. The only candidate is a tiny stateless proxy for the opt-in
Tier 3 cloud call (or a user-supplied API key and no server at all). FastAPI,
Postgres, Redis, the extractor service, presigned blob storage: all dissolved.

## What this protects

Everything, by construction. There is no server copy of the ledger to breach,
subpoena, or read. Cloud-stored backups are ciphertext to the storage provider.
The operator cannot be compelled to produce what the operator cannot read.

## What this does not protect

- **The user from themselves.** A dead phone with no backup configured is total
  loss — ledger and documents both, a strictly worse worst case than ADR 0006's.
  The app must push toward enabling cloud backup early and repeatedly; "user has
  full control" and "user loses everything" are the same property.
- **Plaintext exports** sitting on disks.
- **The web bundle.** Served JS integrity is a policy property, as it is for every
  E2EE web client (Proton, Bitwarden). Mobile remains the higher-integrity surface.
- **The local device itself.** OS encryption and device lock are the guarantee;
  a seized unlocked phone yields the ledger, as it does for any local app.

## Effects on standing ADRs

- **ADR 0003 (React Native + Expo)** — stands, grounds *strengthened*: the shared
  TypeScript crypto surface (backup encryption, key wrapping) grows again, and
  `packages/schema`/`packages/db` are now shared across both clients wholesale.
- **ADR 0004 (Vite SPA)** — stands, grounds *strengthened*: client-side rendering
  is now structural. There is no server to render from.

## Consequences

Good: maximal privacy with no policy asterisks; zero infrastructure cost and
nothing to operate; offline is the default mode rather than a fallback; the entire
ADR 0009 performance concession inverts — every query is a local SQLite read.

Bad: data-loss risk moves onto the user (mitigated by aggressive backup nudges and
the recovery key); no live multi-device sync, and none promised; import-merge is
real engineering; the web app is a second-class citizen by design; Tier 3 quality
varies by device generation.

Revisit if: users demonstrably lose data despite the nudges (a first-party storage
service with the same E2EE properties is the escape hatch), or live multi-device
sync becomes the binding product constraint (CRDT-over-encrypted-blobs is the shape
of that answer, and it is a major undertaking — do not drift into it).
