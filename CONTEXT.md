# CONTEXT

Shared vocabulary for budget-tracker. Use these words exactly in code, schemas, and
docs. If a concept is not here, it is not yet real.

## Core nouns

**Capture** — one act of recording spending. Four kinds: `photo` (receipt),
`statement` (bank PDF/CSV), `voice` (audio), `manual` (typed). The user-facing unit:
"I captured lunch." Every Capture mints a `capture_id` (UUID) on the device that
made it — the stable identity that [[merge]] matches on forever after.

**Document** — the raw artifact behind a Capture: receipt image, statement PDF,
audio file. Lives in app-private storage on the device, protected at rest by OS file
encryption and the device lock. Leaves the device only inside an encrypted Backup.

**Extraction** — the on-device pipeline turning a Document into candidate data, and
the record of that run. Carries the `tier` that produced it and per-field
confidence, so any wrong number is traceable.

**Transaction** — one settled spend: amount, currency, occurred-at, merchant,
category, account. The ledger row.

**LineItem** — a row within a Transaction. Tax, fees, discounts, and tips are
LineItems with a `kind`, not columns on Transaction.

**Ledger** — the full set of Transactions in the local SQLite database. The device
is the system of record ([ADR 0011](docs/adr/0011-local-first.md)); there is no
server copy. Each device has its own Ledger; Backups move data between them.

**Confirm** — the user accepting or editing candidate data. Nothing counts toward a
total before this; unconfirmed rows have a null `confirmed_at`.

**Crop** — the user-adjustable region of a photo that feeds Extraction. A UX
control for OCR quality. Redaction masking (detected PANs, account numbers) is kept
on the crop because its output is what an opt-in Cloud Assist call may send.

## Backup and movement

**Backup** — a single encrypted archive: a consistent snapshot of the Ledger plus
the Documents. Written automatically on app background/exit and on a best-effort
schedule. The durability story and the only way data crosses devices. Format in
[docs/backup-format.md](docs/backup-format.md).

**Restore** — opening a Backup on a device. Never a blind overwrite: restore runs
Merge.

**Merge** — combining a Backup's rows with the local Ledger. Rows match on
`capture_id`; latest `updated_at` wins; the losing revision is kept as a tombstone.
Money data is never silently overwritten.

**Export** — plaintext CSV or PDF written for the user, with a warning that it is
unprotected. Exports are for spreadsheets and taxes, not for backup.

## Keys and recovery

**BMK** — Backup Master Key, random 32 bytes, per user. Wrapped two ways: by the
password-derived KEK and by the Recovery Key. Both wraps travel inside every Backup,
so an archive is self-contained — password or Recovery Key opens it, nothing else
does.

**Recovery Key** — random key generated once, when the user enables cloud backup.
Shown as a key file and QR to print or store in a password manager. Losing both the
password and the Recovery Key means Backups are unreadable; the UI says exactly
that at setup. There is no escrow and no operator who can help.

## Cloud Assist

The per-capture, opt-in cloud call for hard extractions: redacted extracted *text* —
never pixels, never audio — sent for LLM structuring on the user's explicit tap,
that capture only. Off by default, never sticky. The only feature that sends
content anywhere.

## Verbs

**capture** → record spending. **crop** → adjust what feeds OCR. **extract** →
Document becomes candidate data, on-device. **confirm** → candidate becomes a
Transaction. **back up** → snapshot and encrypt. **restore** / **merge** → bring a
Backup into the local Ledger. **export** → plaintext out, eyes open.

## What leaves the device

- **Backups** — ciphertext, to Google Drive `appDataFolder` or wherever the user
  puts the file. The storage provider sees size, timing, and count; never content.
- **Cloud Assist text** — only per-capture, only on explicit opt-in, only redacted
  text.
- **Exports** — plaintext, deliberately, by the user's hand.

Nothing else. There is no telemetry, no analytics, no account, no server of ours.

## Non-goals

Live multi-device sync. Server-side anything. Accounts. Plaid-style bank
connections. Shared or multi-user budgets. Investment tracking. Bill prediction.
Each reopens the privacy design.
