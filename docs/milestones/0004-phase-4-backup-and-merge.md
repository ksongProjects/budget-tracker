# Milestone report — Phase 4: Backup, restore, merge

**Dates**: 2026-08-30
**Phase goal**: Durability. The phase where a bug loses data rather than
annoying someone.
**Outcome**: partial — the data-integrity core is built, tested, and reviewed.
The app-level wiring (recovery-key ceremony, scheduled backups, export) is not.

## Tasks

| Task | Status | Evidence |
|---|---|---|
| 4.1 Key hierarchy + published test vectors | done | 23 tests, RFC 5869 and RFC 4231 vectors |
| 4.2 Recovery key ceremony | done (no QR) | verified on device |
| 4.3 Archive format v1 | done | 23 tests incl. tamper, truncation, splice |
| 4.4 Merge on import | done | 17 tests incl. order-independence |
| 4.5 Auto-backup + retention | **not done** | needs `expo-background-task` |
| 4.6 Export CSV + PDF | **not done** | — |
| Restore-from-every-prior-version suite | done | v1 archive frozen at the bytes |

## Test evidence

`pnpm check` green: **328 tests**, up from 253.

**Crypto (23 tests).** HKDF-SHA256 is checked against all three RFC 5869 test
vectors and HMAC against RFC 4231 — expected values come from the standards, not
from our own output, because a test that checks an implementation against itself
proves only that it is self-consistent. Also covered: KEK determinism and
separation by password and by salt, wrap/unwrap round-trips, fresh nonces per
wrap, tamper detection, and recovery-key transcription.

**Archive (23 tests).** Round-trips including multi-frame entries; opens with
either the password or the recovery key; rejects a wrong secret, a flipped bit
anywhere in the body, truncation, a frame spliced in from a different archive, a
non-archive file, an empty file, and a header claiming a length past the file.
One test asserts the ledger is **not** visible in the unencrypted header.

**Merge (17 tests).** The property that matters: merging two backups gives the
same ledger in either order, including when `rev` and `updated_at` both tie.
`chooseWinner` is checked antisymmetric across every combination of its three
inputs. Merging is idempotent — re-importing a backup neither changes the ledger
nor adds tombstone noise — and a failed merge rolls back entirely.

## Decisions worth recording

**HKDF is implemented, not substituted.** libsodium's KDF is BLAKE2b-based, and
its `crypto_auth_hmacsha256` fixes the key at 32 bytes, which HKDF cannot use
since the salt is the HMAC key during extract. HMAC-SHA256 is therefore built on
plain SHA-256 per RFC 2104. Writing it out is what makes the RFC vectors
applicable, and those vectors are the only reason to believe it is right.

**The BMK is carried across archives; the archive key is not.** A fresh archive
key per backup means one compromised key opens one backup rather than all of
them. A stable BMK means a password change never orphans an older archive, and
the recovery key opens every archive ever written. Both are tested.

**Sodium sits behind an interface**, like the SQLite driver: CI runs
libsodium-wrappers under Node, and React Native needs react-native-libsodium
because Hermes cannot run WASM. `CRYPTO_VECTORS` is framework-free data so both
can be held to it. The libsodium backend is a separate package entry point
specifically so a React Native bundle never pulls WASM in.

**The device id is merge's final tie-break** purely for determinism. Two devices
resolving the same conflict independently have to reach the same answer, or they
disagree forever and each keeps overwriting the other.

## Review

`cavecrew-reviewer` at high effort over the crypto, archive, and merge diffs,
directed adversarially at nonce reuse, silent data loss, truncation gaps, and
merge order-dependence. It reported no findings.

A clean first review of crypto code is worth distrusting, so the code was
re-read afterwards. That found two **documentation** defects, now fixed:
`backup-format.md` specified a CBOR header where the implementation uses JSON,
and described a frame count carried in the final frame's body that was never
built. Truncation is genuinely detected — by the final flag in each frame's
associated data, and again by the manifest — so the missing field was redundant
rather than a hole. But a format spec that disagrees with its implementation is
worse than no spec, because the next reader trusts it.

## The frozen archive

`packages/backup/src/fixtures/v1-archive.ts` holds a real v1 archive, frozen at
the bytes, with its password and recovery key. `compatibility.test.ts` proves
every future build can still open it.

**It must never be regenerated once the format ships.** A user's backups are the only copy of their
data; a format change that quietly stops reading them is the worst bug this
project can ship, and nothing else in the suite would notice. The fixture also
pins `KDF_PARAMS`, so changing the Argon2id cost fails the test — which is
correct, because that change would orphan every existing user backup.

## Risks carried forward

- **Restore is not yet verified end to end on a device.** Backup writing is
  (2.87 MB, real ledger and photos). Restore is covered by 47 tests including
  the frozen archive, and the merge batching below was validated by tests, but
  the full restore path has not completed on hardware since that change.
- **No automatic backups yet (4.5), and no export (4.6).** Every backup is
  manual.
- **The recovery key has no QR rendering**, only text and clipboard.

## Addendum — the vectors ran on a device, and found three bugs

Before building anything on top of crypto that had never executed on a phone,
`CRYPTO_VECTORS` was wired into the diagnostics screen and run against native
libsodium. It found three problems, none of which CI could have caught:

1. **react-native-libsodium does not expose `crypto_hash_sha256`** — only
   BLAKE2b. Found by reading its API before writing the backend. Deriving keys
   differently per platform would have made phone-written backups unopenable on
   the web, so HKDF now uses a TypeScript SHA-256 that is identical everywhere,
   checked against the FIPS 180-4 examples and the 55/56/64-byte padding
   boundaries. `SodiumBackend` no longer needs a hash at all.
2. **AEAD associated data must be a string on device.** Four vectors failed with
   "input type not yet implemented". Frame associated data is now an ASCII
   string, identical under both libraries' UTF-8 encoding.
3. **Two Windows build defects**: the library's Gradle passes a backslashed path
   into CMake (which reads `C:` as an escape), fixed with a committed pnpm
   patch; and its postinstall — which extracts the prebuilt libsodium binaries —
   was blocked by pnpm 10, the same gotcha already recorded for esbuild.

Fixing (2) changed the archive format, so the frozen v1 fixture was regenerated.
That is the one time it is permissible and it is recorded in the fixture's own
header: nothing has shipped, and the old byte-packed associated data could never
have been produced on a phone, so no archive in that shape has ever existed
outside this repository.

**All 11 vectors now pass against native libsodium on the device.** The mobile
and CI crypto provably agree.

A full archive round-trip was then run on the device as well, because the
vectors only prove the primitives — not the format built on them, which is the
first thing here to use BigInt and `DataView.setBigUint64` for its frame nonces.
On Hermes (confirmed at runtime, not from config): a 5914-byte multi-frame
archive round-trips byte for byte, opens with the recovery key, and rejects a
tampered copy.

**Argon2id at 64 MiB and t=3 takes 196 ms**, which retires the risk that the
enable-backup flow would appear frozen. No warning UI is needed.

## Addendum 2 — wired into the app, and what that found

The backup service (VACUUM INTO snapshot, documents, archive) and the
recovery-key ceremony were built and driven on the device. **A real 2.87 MB
backup was written** from the seeded ledger.

Three defects surfaced that only appear once real data flows through:

1. **Restore of 10,000 rows did not finish in five minutes.** `mergeTable`
   issued a SELECT per row, so every row crossed the native bridge twice. The
   archive and merge tests never saw it because they run in-process with a
   handful of rows. Existing rows are now loaded in chunks of 400 and compared
   from a map, with tests for a batch carrying two revisions of one row.
2. **A dynamic `import()` sat in the restore path**, adding an async boundary in
   data-critical code and reaching back to Metro at runtime in a dev build. Now
   static.
3. **The backup screen did not reflect persisted state.** Reopening it offered
   to set up backup again, which would have minted a second recovery key against
   the same master key — leaving the user holding a key that opens nothing they
   were told it would. `hasKeyMaterial` existed and was never called.

A design point worth recording: the recovery key is never stored, but its
**wrap** is. The wrap is ciphertext and useless without the key, and keeping it
is what lets later backups carry a recovery path without the key being on the
device.

## Addendum 3 — restore proven on a device that had never seen the data

The gap left open above is closed. The run was deliberately the disaster case
rather than the convenient one: seed 10,000 rows, set up backup, write an
archive, copy it off, **wipe the app completely** — ledger, keystore, archives —
and restore onto an install with nothing on it, using only the password.

**10,000 rows restored in 25.8 s**, from a file chosen out of Downloads. The
batched merge holds at scale on real hardware. Restoring the same archive a
second time onto the now-populated ledger took **2.0 s** and reported 10,000
rows already current — order-independent merge doing exactly nothing, quickly.

Four defects, each of which only a device could show:

1. **Restore could not work on a fresh device at all.** The KEK was derived with
   a salt minted locally, not the salt in the archive's own header, so a phone
   with no prior key material produced a key that opened nothing. The archive
   has carried its salt since v1 precisely so this case works; nothing read it.
   Now `deriveArchiveSecret` reads the header.
2. **Restore was unreachable before setup.** It lived behind the "backup is on"
   screen — the door it is meant to open. It is now offered on the first screen,
   with a file picker, because the device that needs it most is a new one.
3. **The snapshot was opened by name, not by path.** expo-sqlite resolves a bare
   name against its own directory, so `restore.db` was written to the backups
   folder and a different, empty `restore.db` was opened beside the real ledger:
   `no such table: merchants`. This is what the earlier "tangled in Metro
   reloads" run was actually hitting. The directory is now passed explicitly.
4. **The decrypted snapshot was left on disk.** A plaintext copy of the entire
   ledger sat in app storage after every restore, undoing the point of shipping
   the data encrypted. It is deleted in a `finally`, journal files included.

## Addendum 4 — automatic backups (4.5) and export (4.6)

**Automatic backup.** Backgrounding the app writes an archive; a best-effort
`expo-background-task` schedule is a second chance, not the mechanism. Two
guards keep it from encrypting megabytes every time the user switches apps: a
6-hour minimum since the last archive, and a check that any row actually changed
since then. Retention keeps the newest 5 and deletes interrupted `.partial`
files. Verified on device: with the archives cleared, sending the app to the
background wrote a complete 2.94 MB archive unattended.

This needed one format change. `writeArchive` now takes the password side as
either the KEK or a **stored wrap**, symmetrically with the recovery side. No
secret is stored — a wrap is ciphertext, and the BMK it protects is already in
the same keystore — but it is what lets a backup run with nobody present to type
a password. The consequence with teeth is recorded in
[backup-format.md](../backup-format.md): a restore must adopt the restored
archive's wraps, or the next automatic backup seals a file whose wraps hand back
the wrong master key. Verified on device: an archive written after a restore
opens with the original password.

**Export.** CSV and a PDF report, both plaintext, with the warning above the
buttons rather than after the fact. Totals cover every row but are computed from
confirmed entries only — an unconfirmed row is a guess the user has not agreed
with. Two things the tests caught before the device did: the spreadsheet-formula
guard was mangling negative amounts into text (it now applies to free text only,
never to the amount column), and a merchant name a spreadsheet would execute is
defused with a leading apostrophe.

The device caught the third: **rendering 10,000 entries into the print WebView
took the emulator down hard enough to need a kill.** The report now lists the
newest 500 and says where the rest are; the CSV, which no WebView touches, stays
complete. A 10,000-row ledger exports a 599 KB CSV and an 18-page, 87 KB PDF.

## Addendum 5 — closing what the first pass left unproven

Four seams were named as verified-by-reasoning rather than by running them. All
four are now exercised, and two of them were hiding defects.

**The OS-scheduled backup does run.** Forced through the real path —
`adb shell cmd jobscheduler run -f <package> <job id>` — the headless task opened
its own ledger, wrote a 2,941,682-byte archive, and recorded
`{"outcome":"written"}`. The hazards feared for that path (no `getRandomValues`
polyfill, an unreadable keystore) did not materialise on Android.

Two things about it are worth knowing rather than rediscovering:

- **expo-background-task refuses to run tasks while the app is foregrounded** —
  `runTasks: App is in the foreground` — and merely reschedules.
  `triggerTaskWorkerForTestingAsync()` therefore returns `null` and does
  nothing from a screen you are looking at. The diagnostics entry says so
  instead of pretending to trigger it.
- **The job it registers carries a network constraint** the API does not let us
  configure. A backup that needs no network will not fire while the device is
  offline. Backgrounding remains the mechanism; the schedule is the second
  chance, exactly as documented.

**A scheduled backup was breaking the running app.** expo-sqlite caches
connections *by database name*, so the headless task's `openDatabaseAsync`
returned the same native handle the app was holding — and closing it at the end
of the task closed the app's ledger. Every query afterwards failed with
`Call to function 'NativeDatabase.execAsync' has been rejected → NullPointerException`.
The task now opens with `useNewConnection: true`. Found by running six manual
backups after a scheduled one, which is not what that test was looking for.

**Retention only ran on automatic backups.** `pruneBackups` hung off the
scheduler, so a user who backed up by hand accumulated 2.9 MB archives forever.
It now runs inside `createBackup`, on every write. Verified: six manual backups
in a row, the count climbs 1→5 and stops, the oldest is the one deleted, and the
screen says "Removed 1 older".

**Listing archives no longer reads them.** `listBackups` read every archive in
full to parse a header at the front of it — tens of megabytes of base64 on the
JS heap, during backgrounding, when the OS is trying to freeze the process. It
now reads the first 64 KB: five archives listed in 36 ms on device.

**The share sheet and export deletion work.** The chooser resolves the file out
of the cache directory (the FileProvider root is configured), and deleting
removes both files.

**And the guards have tests.** `runScheduledBackup` and `ledgerChangedSince`
moved to `schedule.ts`, free of React Native imports, with the device seams
passed in. Twelve tests against a real SQLite ledger, including the boundary
that matters: a row whose `updated_at` equals the last backup's timestamp counts
as changed. The comparison was exclusive; had the two ever landed in the same
millisecond the wrong way round, that row would have been left out of every
future backup until something unrelated touched it.

## Next

Phase 4 is complete. Phase 5 is the Drive connector, where retention becomes
per-device and archives from several devices land in one place.
