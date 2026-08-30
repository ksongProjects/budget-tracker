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
| 4.2 Recovery key ceremony (generate, QR, verify-before-continue) | **not done** | key rendering built; the UI flow is not |
| 4.3 Archive format v1 | done | 23 tests incl. tamper, truncation, splice |
| 4.4 Merge on import | done | 17 tests incl. order-independence |
| 4.5 Auto-backup + retention | **not done** | needs `expo-background-task` |
| 4.6 Export CSV + PDF | **not done** | — |
| Restore-from-every-prior-version suite | done | v1 archive frozen at the bytes |

## Test evidence

`pnpm check` green: **319 tests**, up from 253.

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

**It must never be regenerated.** A user's backups are the only copy of their
data; a format change that quietly stops reading them is the worst bug this
project can ship, and nothing else in the suite would notice. The fixture also
pins `KDF_PARAMS`, so changing the Argon2id cost fails the test — which is
correct, because that change would orphan every existing user backup.

## Risks carried forward

- **Nothing is wired into the app.** No backup has been written or restored on a
  device. The archive code has never met a real `VACUUM INTO` snapshot or a real
  photo, and merge has never met a real archive. This is the same gap that hid
  two bugs in Phase 3, and it is the first thing to close.
- **react-native-libsodium has never run.** `CRYPTO_VECTORS` exists to check it
  and has only ever run against libsodium-wrappers. Until it runs on a device,
  "the mobile crypto matches" is an assumption — and if it is wrong, archives
  written on a phone may be unopenable.
- **Argon2id cost is unmeasured on a phone.** 64 MiB and t=3 is a deliberate
  cost, but if it takes ten seconds on a mid-range Android the enable-backup
  flow needs to say so rather than appear frozen.
- **No key material is stored yet.** The BMK has nowhere to live between
  sessions; that belongs with the recovery-key ceremony in 4.2.

## Next

Wire it into the app: the recovery-key ceremony (4.2), a real snapshot-and-store
backup, restore-and-merge, then scheduled backups (4.5) and export (4.6). Begin
by running `CRYPTO_VECTORS` on a device through the diagnostics screen, before
building anything on top of crypto that has never executed there.
