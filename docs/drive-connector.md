# Google Drive connector

First (and for the MVP, only) cloud transport for Backups
([ADR 0011](adr/0011-local-first.md) §3). Drive stores ciphertext it cannot read;
the connector is plumbing, not trust.

## Scope and auth

- OAuth scope: **`https://www.googleapis.com/auth/drive.appdata` only.** Never the
  broader `drive` or `drive.file` scopes — the consent screen showing the narrowest
  possible grant is part of the privacy story.
- `appDataFolder` is app-private, invisible in the Drive UI, not shareable, and
  deleted when the user removes the app's access — all acceptable, since Drive is a
  transport for self-contained archives, not the system of record.
- Mobile: authorization-code flow with PKCE via the system browser
  (`expo-auth-session`); tokens in SecureStore. Web (Phase 6): same flow, tokens in
  memory + refresh, never `localStorage`.
- Losing Drive access loses nothing but convenience: local data is untouched and
  archives are ordinary files the user can move any other way.

## Operations

| Op | Detail |
|---|---|
| Upload | Resumable upload session; survives app suspend and network loss; verifies uploaded size + checksum before recording success |
| List | `spaces=appDataFolder`, fields: name, size, createdTime; names parse per [backup-format.md](backup-format.md#naming-and-retention) |
| Prune | Applies the retention policy after each successful upload; per-device by name prefix |
| Restore | List → pick newest (or user-chosen) → download → decrypt/verify → Merge |

Backup-health surface: last successful upload time is shown in settings and drives
the nudge badge (implementation plan 5.5). A configured-but-failing connector is
worse than none because it feels safe — failures louder than absence.

## Enable-backup ceremony

Enabling the connector is the moment the Recovery Key is minted
([ADR 0011](adr/0011-local-first.md) §6): generate, display as key file + QR,
require a verification step (re-enter a slice / rescan) before the first upload.
Cannot be skipped; can be re-run later from settings (rotation, per
[crypto-design.md](crypto-design.md)).

## What Google learns

Archive byte sizes, upload timing and frequency, archive count, and the account
identity. Not: contents, document names, merchants, amounts. Backup cadence being
observable is accepted metadata leakage, consistent with the (superseded but still
honest) reasoning of ADR 0010 — we say it rather than pad it.

## Later connectors

Dropbox and WebDAV fit the same interface: upload/list/prune/download over opaque
files. Kept as an interface boundary in `packages/backup` from the start; not built
until asked for.
