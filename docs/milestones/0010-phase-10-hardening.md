# Milestone report — Phase 10: hardening and release

**Dates**: 2026-08-30
**Phase goal**: measure every budget, break backup and restore on purpose, make
the app usable by people the developer is not, and get the release paperwork
honest.
**Outcome**: shipped-with-deviations — the audit, the failure injection and the
accessibility pass are done, and they found four real defects. Release itself is
blocked on accounts, URLs and a Mac, all named.

## Tasks

| Task | Status | Evidence |
|---|---|---|
| Perf audit against all budgets | done, one miss | measured on device; 8 of 9 within budget |
| Failure injection on backup/restore | done, two defects fixed | six ways broken on a 10,000-row ledger, all refused |
| Accessibility pass | done, two defects fixed | contrast pinned by test; roles, targets and live regions across both apps |
| Store metadata and privacy labels | done | [store-listing.md](../release/store-listing.md), [privacy.md](../release/privacy.md) |
| Beta → release | blocked | [checklist.md](../release/checklist.md) names every blocker |

## Perf, measured

On the Android emulator, against a seeded 10,000-row ledger:

| Metric | Budget | Measured |
|---|---|---|
| Cold start → interactive ledger | 1500 ms | **842 ms** |
| Ledger page query (50 rows) | 50 ms | **9.5 ms** |
| Summary by category over 10k | 50 ms | **9 ms** |
| Summary by month | 50 ms | **11 ms** |
| Full-text search | 50 ms | **12 ms** |
| Insert one transaction | 50 ms | **8 ms** |
| Backup write | 2000 ms | **1134 ms** |
| Shutter → provisional total | 500 ms | **532 ms** ✗ |

The miss is split rather than left red: OCR 477 ms, the rules 1 ms. It is ML Kit
on an x86 emulator with no NPU, and none of the time is code this project
controls. Recorded as a miss to be re-measured on a phone rather than quietly
widened — a budget that moves when it is inconvenient is not a budget.

Web budgets were already covered by the browser suite: a 24 MB archive imports
in under 20 s, and the bundle check runs in CI on every push.

## What breaking it on purpose found

Two defects, both in the path where a user has least room to recover:

**The archive header was never signed.** Frames bound the format version, their
position and the final flag — not the header. So the salt, the creation time,
the app version and the schema version could each be edited in place and every
frame would still authenticate. The device showed it bluntly: a flipped header
byte produced a raw SQLite error from the middle of a restore, because as far as
the reader was concerned the archive had opened. Format 2 seals the header's own
bytes into every frame's associated data. Version 1 archives still open, and
there is a frozen v2 fixture beside the v1 one.

**A restore accepted an archive from a newer app.** Nothing compared the
archive's schema version to this build's, so rows from a newer schema would
merge into an older ledger — a downgrade whose damage surfaces much later as
data that quietly went missing. The web app had this guard; mobile did not.

Also fixed: an unreadable snapshot now fails with a sentence rather than
`Call to function 'NativeDatabase.execAsync' has been rejected`, and interrupted
`.partial` files are swept *before* a write rather than after, because on a full
device the write is what fails and the sweep afterwards never ran.

On device, against a real 10,000-row ledger, all six refusals hold and the row
count is identical afterwards.

## What the accessibility pass found

**Contrast.** `textFaint` was 3.0:1 on a raised surface — under AA, and it is
the colour used for evidence lines and dates, the small print someone reads
exactly when checking a number. Now 5.0:1 at worst, pinned by a test that
computes the ratios from the palette.

**Roles.** 58 `Pressable`s were announced as text rather than buttons.

**Targets.** The quiet controls were ~36dp; they are 48 now.

**Announcements.** Errors are live regions in both apps; on the web, inputs have
names that survive typing and the notice line is a status region.

## Deviations from plan

**No release.** The checklist names four blockers: no support or privacy-policy
URL, no store accounts, no signing keys, and no iOS build — this project has
never had a Mac, and whisper.rn, expo-sqlite, libsodium and the PCM recorder
each have an iOS path that has never executed.

**Benchmarks are emulator numbers.** Every figure above should be re-taken on a
mid-range phone before release; the plan says to measure on cheap hardware, and
an x86 emulator is neither.

## Risks carried forward

- **iOS is entirely unproven.** Not "probably fine" — unrun.
- **The one budget miss is unattributed to real hardware.** It may vanish on a
  phone with an NPU, or it may not.
- **Format 2 is new.** Every archive written from here binds its header; a bug
  in that binding would make new archives unreadable, which is why the frozen v2
  fixture exists and must never be regenerated.
- **No crash reporting.** Deliberate, and it means the first release's failures
  arrive as store reviews rather than stack traces.

## Next

Nothing in the plan follows this phase. The work that would matter most is the
first real device: physical-phone benchmarks, a restore rehearsal on wiped
hardware, and the accuracy numbers that neither voice nor Tier 3 has yet.
