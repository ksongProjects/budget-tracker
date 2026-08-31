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

## Setting one up

Nothing in the repository carries a Google identity, and the app is fully usable
without one — the connector simply reports itself unconfigured and backups stay
local. To turn it on for a build:

1. A Google Cloud project with the **Drive API** enabled.
2. An OAuth consent screen requesting **only**
   `https://www.googleapis.com/auth/drive.appdata`. That is a *sensitive* scope:
   publishing requires Google's app verification (name, logo, privacy policy,
   homepage, demo video). The broader `drive` scope is *restricted* and adds an
   annual third-party security assessment — avoiding that is much of why this
   design uses appdata.
3. An **Android OAuth client id**: package `com.ksongprojects.txns` plus
   the SHA-1 of the signing certificate. Register both the debug certificate and
   the Play upload certificate, or the flow works in development and fails in
   release. iOS and web clients are separate ids, added when those ship.
4. No client secret. The flow is authorization-code with PKCE for a public
   client, because a secret shipped inside an app is not a secret.
5. Give the build the id, either as `EXPO_PUBLIC_GOOGLE_CLIENT_ID` or as
   `expo.extra.googleClientId` in `app.json`, and add the reverse-DNS redirect
   scheme `com.googleusercontent.apps.<id>` to `expo.scheme`.

While the consent screen is unverified, Google caps testers at around 100 and
expires refresh tokens after about a week. Fine for development; not something
to ship on.

## The web half

Same connector, same `appDataFolder`, different platform pieces: the browser
supplies `fetch` and holds tokens **in memory only** — not `localStorage`, not a
cookie. A token in storage survives the tab and is readable by anything that can
run script on the origin; signing in again after a reload is the right price for
a key to someone's Drive. The PKCE verifier is the one exception, since it has
to survive the redirect, and it is deleted the moment the code is exchanged.

The browser **reads** from Drive and does not write. Writing needs a Backup
Master Key that outlives a reload, and browser storage is a materially different
threat model from a phone's OS keystore — that decision deserves its own design
rather than being made in passing. The phone writes; the browser restores.

## Testing without an account

`packages/backup/src/fake-drive.ts` implements the protocol in memory — sessions,
`308` with a `Range`, the file JSON — and enforces its rules: uploads must target
`appDataFolder`, a chunk must continue where the last one stopped. The connector
is tested against it, so what is checked is agreement with a server that holds
state rather than agreement with our own stubs.

`tools/fake-drive.mjs` puts it behind a socket, which is how the phone exercises
the real upload path with nothing leaving the machine:

```
pnpm --filter @budget/backup build
node tools/fake-drive.mjs --fail-every=2
cd apps/mobile && EXPO_PUBLIC_FAKE_DRIVE_URL=http://10.0.2.2:8787 npx expo start
```

`--fail-every=N` drops one chunk in every N by destroying the connection, which
is what the resume path exists for. The override is ignored unless `__DEV__`, so
a release build cannot be pointed elsewhere by an inherited environment.

## Later connectors

Dropbox and WebDAV fit the same interface: upload/list/prune/download over opaque
files. Kept as an interface boundary in `packages/backup` from the start; not built
until asked for.
