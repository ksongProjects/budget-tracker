# Release checklist

Ordered so that the things that cannot be undone come last. Everything here is
either done, or listed with what would finish it — nothing is assumed.

## Before a build

- [ ] `pnpm check` green on `main` (typecheck, lint, 636 node tests, 64 browser
      tests, web build, bundle budget).
- [ ] Benchmarks run on a **physical** phone, not the emulator, and recorded in
      the milestone report. The one budget currently missed — shutter to
      provisional total — is ML Kit on an x86 emulator and needs a real device
      to judge.
- [ ] Failure injection run on a device: corrupt archive, damaged header,
      truncation, downgrade, wrong password, interrupted write. All six refused,
      ledger untouched.
- [ ] Restore rehearsed end to end on a **wiped** device, from a backup made by
      the build being shipped.
- [ ] `app.json` version bumped, and `APP_VERSION` in
      `apps/mobile/src/backup/service.ts` bumped with it. They are written into
      every archive header; if they disagree, a support conversation about a
      backup starts with the wrong number.
- [ ] The archive format version is unchanged, or a new frozen fixture was added
      to `packages/backup/src/fixtures/` and the compatibility suite passes with
      every earlier one still in it.

## Store metadata

- [ ] Listing copy from [store-listing.md](store-listing.md), unedited claims.
- [ ] Privacy labels from [privacy.md](privacy.md), answered on both forms.
- [ ] Screenshots captured on a device, no real spending visible.
- [ ] **Blocked**: a support URL and a privacy policy URL. Both stores require
      them and neither exists yet. The policy has to say what privacy.md says,
      in public, at a stable address.

## Signing and accounts

- [ ] **Blocked**: an Apple Developer Program membership and an App Store Connect
      app record.
- [ ] **Blocked**: a Google Play Console account and an app record.
- [ ] Android upload key generated and backed up somewhere that survives this
      laptop. A lost upload key means a new listing.
- [ ] iOS distribution certificate and provisioning profile, or EAS managing
      both.
- [ ] **Blocked**: iOS has never been built. There is no Mac in this project's
      history; the app has run on Android only. Before any iOS submission the
      whole device-verification list above has to be repeated there, and
      whisper.rn, expo-sqlite, libsodium and the PCM recorder each have an iOS
      path that has never executed.

## Beta

- [ ] TestFlight / Play internal testing with the beta group.
- [ ] A tester restores a backup onto a second device and confirms the ledger
      matches.
- [ ] A tester turns on automatic backups and confirms one runs overnight —
      `expo-background-task` refuses to run while foregrounded, so this cannot
      be checked any other way.
- [ ] A week with no crash reports and no "where did my data go".

## Release

- [ ] Staged rollout on Play (10% → 50% → 100%), phased release on iOS.
- [ ] The milestone report for this phase updated with what the beta found.
- [ ] `docs/deferred.md` re-read: anything on it that a real user would hit in
      week one gets fixed before the rollout widens.

## Not required, and deliberately so

- No crash reporter, no analytics, no attribution SDK. Adding one would make
  every line of [privacy.md](privacy.md) false, and the labels are a legal
  claim. If one is ever added it is opt-in, it carries no ledger content, and
  the labels change in the same commit.
