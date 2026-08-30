# Milestone report — Phase 5: Google Drive connector

**Dates**: 2026-08-30 → 2026-08-30
**Phase goal**: backups leave the device, encrypted, automatically.
**Outcome**: shipped-with-deviations — everything is built and exercised against
a stand-in that speaks Drive's protocol; nothing has yet talked to Google,
because that needs an OAuth client id tied to the owner's account.

## Tasks

| Task | Status | Evidence |
|---|---|---|
| 5.1 OAuth (`drive.appdata` only), tokens in SecureStore | done, unverified against Google | scope is a constant with a comment forbidding its widening; redirect URI derived from the client id so the two cannot disagree |
| 5.2 Upload/list/prune, resumable upload | done | 24 unit tests plus 11 against a stateful stand-in; on device, a 2.9 MB archive uploaded through three dropped connections |
| 5.3 Enable-backup ceremony | done in Phase 4 | the ceremony gates the first backup and cannot be skipped |
| 5.4 Restore-from-Drive on fresh install | done, verified against the stand-in | archive downloaded, decrypted and merged on device: 10,000 rows already current |
| 5.5 Backup-health nudges | done | 8 tests; a failing connector outranks a stale one |

## Test evidence

405 tests at phase close, CI green on `main`.

New this phase: the archive naming and retention policy (11), the Drive
connector (13), the connector against a stateful stand-in (11), backup health
(8), and the automatic-backup guards extracted so they could be tested at all
(12).

The stand-in is the piece worth naming. `packages/backup/src/fake-drive.ts`
implements the resumable protocol in memory and enforces its rules — uploads
must target `appDataFolder`, a chunk must continue where the last one stopped —
so what the tests check is agreement with a server that holds state, rather than
agreement with our own stubs. `tools/fake-drive.mjs` puts it behind a socket,
which is how the phone exercised the real upload path with no Google account.

## Performance

Android emulator, Pixel 9, 2.9 MB archive, 1 MB chunks:

- Upload over a healthy connection: three chunks, no retries.
- Upload with one connection in two destroyed mid-chunk: completed after three
  resumes.
- Download, decrypt and merge: 10,000 rows, all already current, ~2 s.
- Listing five local archives after the header-only read: 36 ms, down from
  reading ~15 MB of base64.

## Deviations from plan

**5.2's acceptance was "airplane-mode interruption resumes".** It is met against
the stand-in, by destroying the socket rather than the radio, which exercises the
same failure the same way. Against Google it remains unverified.

**Phase exit — "new phone → sign into Drive → everything back" — is not met**,
and cannot be until there is a client id. Everything up to the consent screen is
done and exercised.

## Risks carried forward

- No path has yet touched Google. The consent screen, real quota behaviour, and
  token refresh against the live endpoint are all unproven.
- The scheduled backup registers a job with a **network constraint** that
  expo-background-task sets and its API does not expose. A backup needing no
  network will not fire while the device is offline; backgrounding remains the
  mechanism.
- Documents are not yet uploaded separately: an archive carries them, so a
  restore gets them, but there is no incremental path and a photo-heavy ledger
  will make each upload large.

## Next

Phase 6 shares this connector: `@budget/backup` has no DOM dependency precisely
so `drive.ts` serves the browser too. When a client id exists, the mobile round
trip and Phase 6.3's mobile → web → mobile test can both be closed in one
sitting.
