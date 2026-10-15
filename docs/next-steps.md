# Next steps: from a working app to a released one

Phases 0–10 of the [implementation plan](implementation-plan.md) are closed.
Nothing in that plan follows Phase 10, so this guide is what does. It is built
from [deferred.md](deferred.md), the [release checklist](release/checklist.md),
the Phase 10 [milestone report](milestones/0010-phase-10-hardening.md), and a
pass over the code as of `64c33a5` (2026-10-15).

The work runs the same way as every earlier phase — the loop, the review gates
and the milestone reports in [implementation-plan.md](implementation-plan.md#how-work-runs)
all still apply. Each task below is scoped for one session and lands as 1–3
commits.

## What changed since Phase 10 closed

- The app is **TXNS**, `com.ksongprojects.txns`, with a profile, a home screen
  and every way in from an empty ledger.
- Receipts are read as a table; currencies only where one is printed; a café
  order ticket reads correctly; the confirm screen shows what a record needs
  and folds the rest.
- Since 2026-09-01 a release-signed APK runs on a **physical Pixel 8a**. Its
  ledger is real data. None of that phone's results are in the docs yet — every
  number in the milestone reports is still an emulator number.
- Since 2026-10-15 the repository is **public**, and sideload builds are
  published as GitHub prereleases
  (`v0.1.0-build.<sha>`, arm64 APK attached).

## Order, and why

| Phase | Theme | Needs from outside | Unblocks |
|---|---|---|---|
| 11 | Safe, repeatable release builds | nothing | every later phone run |
| 12 | Real-device baseline | nothing | the release checklist's device rows |
| 13 | Accuracy from real captures | nothing | trusting the rules and Tier 3 numbers |
| 14 | Daily-driver gaps on mobile | nothing | a beta someone else can use |
| 15 | Drive, for real | a Google Cloud project | Phase 5 and 6.3 exit criteria |
| 16 | Play Store | Play Console account, privacy-policy URL | a release |
| 17 | iOS | a Mac and an iPhone | an iOS release |
| 18 | Web polish | nothing | a web app worth opening |

Phases 11–14 need nothing but this machine and the phone, so they come first.
Phase 11 comes before 12 because of the first problem below.

---

## Phase 11 — Safe, repeatable release builds

Goal: a release build can be made, signed, published and installed by one
command, and nothing in it can damage the real ledger on the phone.

### 11.1 Keep test tools away from a real ledger

**Problem.** `apps/mobile/app/perf.tsx` seeds 10,000 transactions into
whatever ledger `useLedger()` returns whenever that ledger holds fewer than
10,000 rows, and it also inserts benchmark rows. The route ships in release
builds and is reachable at `txns://perf`. Running the benchmarks on the Pixel
today would write 10,000 fake rows into the user's real ledger, and the next
automatic backup would carry them.

Steps:

1. Open the benchmark ledger as its **own database** — e.g. `perf.db`,
   opened with `useNewConnection: true` (expo-sqlite caches connections by
   name; see the driver notes in `apps/mobile/src/db/`). Run migrations on it,
   seed it, measure against it, and close it. The user's ledger is never
   touched.
2. Keep cold start measured from the real launch (`coldStart()`), since that is
   what a user feels; label it as measured against the real ledger and show its
   row count.
3. The backup-write benchmark must write to a scratch directory and must not
   touch retention, the stored wraps, or the Drive connector.
4. Audit `diagnostics.tsx` the same way: every check that writes must write to
   its own database or files, and say so on screen.
5. Test: a unit test over the perf module asserting the seed path never
   receives the app's ledger (inject the driver; assert the name).

Acceptance: on the emulator, run `/perf` against a ledger with 3 rows; the row
count on the home screen is still 3 afterwards, and the benchmark results are
for 10,000 rows.

### 11.2 Make release signing survive `expo prebuild --clean`

**Problem.** Release signing is a hand edit in the generated, gitignored
`apps/mobile/android/app/build.gradle`. `expo prebuild --clean` erases it, and
the build then falls back to **debug signing without saying so**. A
debug-signed APK cannot install over the phone's app without uninstalling it,
and uninstalling wipes the ledger.

Steps:

1. Add a config plugin, `apps/mobile/plugins/with-release-signing.js`, using
   `withAppBuildGradle` from `expo/config-plugins`. It inserts a `release`
   signing config that reads `TXNS_RELEASE_STORE_FILE`,
   `TXNS_RELEASE_STORE_PASSWORD`, `TXNS_RELEASE_KEY_ALIAS` and
   `TXNS_RELEASE_KEY_PASSWORD` from Gradle properties — the same names already
   in `~/.gradle/gradle.properties`. Passwords never enter the repository.
2. Make the release build type **fail** when those properties are missing,
   instead of falling back to debug signing. A loud failure is better than an
   APK that cannot be installed without losing data.
3. Register it in `app.json` → `expo.plugins`.
4. Verify: `npx expo prebuild --clean -p android`, then
   `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`, then
   `apksigner verify --print-certs` shows
   `CN=Kyung Min Song, O=ksongProjects, OU=TXNS`. Repeat with the properties
   removed and confirm the build fails.

Acceptance: a clean prebuild produces a release-signed APK with no hand edits.

### 11.3 One version, written in one place

**Problem.** The version lives in `app.json` (`0.1.0`), in
`APP_VERSION` in `apps/mobile/src/backup/service.ts` (`0.1.0`), and in
`versionCode` (still `1`, set only in the generated Gradle file). The version
goes into every backup header, so a mismatch makes support conversations about
a backup start from the wrong number. Play refuses an upload whose
`versionCode` is not higher than the last one.

Steps:

1. Set `expo.android.versionCode` in `app.json` (start at 2) so prebuild owns
   it.
2. Read the backup header's app version from `app.json` through
   `expo-constants` (`Constants.expoConfig?.version`) rather than a second
   literal, or keep the literal and add a test that reads `app.json` and fails
   when they differ. The test is simpler and cannot fail at runtime.
3. Update the release checklist's version row to match.

Acceptance: changing the version in `app.json` alone either updates every
consumer or turns a test red.

### 11.4 A release script

Steps:

1. Add `tools/release-apk.mjs` (Node, matching `tools/bundle-budget.mjs`). It:
   - refuses to run with a dirty tree, or with `HEAD` not on `origin/main`;
   - runs `pnpm check`;
   - runs the Gradle release build with Android Studio's JBR as `JAVA_HOME`;
   - copies the APK to `dist/txns-<version>-arm64.apk`;
   - runs `apksigner verify --print-certs` and refuses unless the certificate
     is the TXNS release certificate (compare the SHA-256 digest);
   - creates the GitHub prerelease `v<version>-build.<short sha>` with the
     commit, the ABI and the APK's SHA-256 in its notes;
   - optionally, with `--prune N`, deletes all but the newest N build
     prereleases and their tags.
2. Document it in [running-locally.md](running-locally.md), including how to
   install from the phone (Releases → asset → open → Update).

Acceptance: `node tools/release-apk.mjs` on a clean `main` publishes an
installable build, and the APK installs over the phone's app with its ledger
intact.

### 11.5 Public-repository hygiene

The repository became public on 2026-10-15. A scan of the full history found no
keystores, `.env` files, Gradle properties, Google credentials, API keys or
private keys.

Steps:

1. **Decide on a licence** — this is the owner's call, not a task to guess at.
   With no `LICENSE` file the code is "all rights reserved": readable, not
   reusable. Add one if reuse is intended.
2. Add a secret scan to CI so the scan that was done by hand keeps happening
   (e.g. gitleaks over the pushed range). It has to pass on the current
   history before it is made a required check.
3. Add a short "Install a test build" section to the README pointing at the
   Releases page, stating that builds are unreviewed sideloads, not store
   releases.
4. Re-read [docs/release/privacy.md](release/privacy.md) as something the public
   can now read, and correct anything that only made sense privately.

Acceptance: CI runs the secret scan on every push; the README says how to
install a test build and what one is.

Exit for Phase 11: a fresh prebuild, one command, a signed build on the phone,
and nothing on the phone that could write test data into a real ledger.

---

## Phase 12 — Real-device baseline

Goal: replace every emulator number that matters with a Pixel 8a number, and run
the device rows of the release checklist.

The phone's ledger is real. Every step here either runs against a separate
database (11.1) or against the emulator acting as a second device.

### 12.1 Benchmarks on the Pixel 8a

1. Install the Phase 11 build with the release script.
2. Open `txns://perf` and run it. Record every row.
3. Run it three times from a cold start, since one run is not a measurement.
4. Write the numbers into
   [the Phase 10 report](milestones/0010-phase-10-hardening.md) next to the
   emulator numbers — do not replace them; the comparison is the point.
5. Settle the one miss: shutter → provisional total was 532 ms against 500 ms
   on the emulator, 477 ms of it ML Kit. If the phone is under budget, close it.
   If it is still over, split OCR time from rules time again and decide whether
   to make a smaller image the default for OCR.

Acceptance: the milestone report has a Pixel 8a column, and every budget is
either met on the phone or has a named owner and plan.

### 12.2 Failure injection on the phone's build, safely

The checklist asks for the six refusals (corrupt archive, damaged header,
truncation, downgrade, wrong password, interrupted write) on a device.

1. Run them on the **emulator** with the same release build — it is a device,
   and its ledger is disposable.
2. On the phone, run only the read-only cases: open a damaged archive and a
   wrong password, and confirm the refusals and that the row count is unchanged.

Acceptance: all six refused on the emulator; the read-only cases refused on the
phone; ledger row counts identical before and after.

### 12.3 Restore rehearsal onto a wiped device

This is the release checklist's "restore on a **wiped** device, from a backup
made by the build being shipped", and the case that found four bugs in Phase 4.

1. On the phone: make a backup to a file with the current release build.
2. Move the archive to the PC (`adb pull` from the shared folder the backup was
   saved to, or share it).
3. Wipe the emulator (`-wipe-data`), install the same release APK, and restore
   from the file with **only the password**. Then again with **only the
   recovery key**.
4. Compare: transaction count, sum of `amount_minor` per currency, count of
   documents, and five transactions picked at random, field by field.
5. On the emulator, make a new backup after the restore, and confirm it opens
   with the original password — this checks the "adopt the archive's wraps"
   rule.

Acceptance: identical counts and sums with each secret; the post-restore backup
opens.

### 12.4 First real voice accuracy number

1. Add a voice harness to diagnostics: it shows the utterances from
   `packages/extract/src/voice/utterances.ts` one at a time, records each,
   transcribes it on the device, and stores nothing.
2. Score each transcript against its expected text (word error rate) and the
   parsed amount, merchant and category against the expected fields.
3. Run it on the Pixel 8a in a quiet room and once with background noise.
4. Record word error rate and field accuracy in the Phase 8 report.

Acceptance: the Phase 8 report has a measured word error rate from a physical
microphone.

### 12.5 Let the background backup run unforced

1. Turn on automatic backup on the phone, leave it on a charger overnight.
2. Next day, confirm a backup exists with an overnight timestamp — not one
   forced through `adb shell cmd jobscheduler run -f`.

Acceptance: one unforced scheduled backup observed; deferred.md updated.

Exit for Phase 12: the release checklist's "Before a build" rows are ticked with
phone evidence, and deferred.md no longer says "no physical device".

---

## Phase 13 — Accuracy from real captures

Goal: the extraction numbers are measured against real receipts, not only
against the texts written to break the parser.

### 13.1 A redacted real-receipt corpus

1. For each receipt photographed on the phone, use diagnostics → "Run OCR on my
   latest capture" and read the engine output off the screen (uiautomator dump).
2. Redact before anything is written to the repository: card digits, names,
   addresses, phone numbers, loyalty and order numbers, and any line that would
   identify a person. Keep layout, amounts, dates, tax lines and merchant names
   (merchant names are what the rules have to read).
3. Commit each as a fixture in `packages/extract/src/fixtures/real/` with the
   expected fields beside it, in the same format as the existing receipt tests.
4. Add a scoring test that reports a per-field hit rate over the real corpus
   and fails CI if it drops below the last committed floor.

Acceptance: at least 15 real receipts in the corpus, across groceries,
restaurants, cafés and a fuel or pharmacy receipt; the floor is committed.

### 13.2 Make the unbalanced flag mean something

**Problem.** Reconciliation is exact (`packages/extract/src/table.ts`
`balanced`; `packages/extract/src/llm/read.ts` `reconcile`). Receipt tables now
count discount rows, but a gap caused by an unread row and a gap caused by a
misread number look the same, and a flag that fires on most grocery receipts
stops being read.

1. Keep exactness. A difference of one cent is still a difference.
2. Classify the gap: explained by rows with no amount, explained by one row
   whose correction would close it, or unexplained. Say which on the confirm
   screen's fold summary.
3. Measure against the real corpus how often each case occurs, before deciding
   whether the fold should open on its own for the explained cases.

Acceptance: on the real corpus, every unbalanced receipt gets one of the three
labels, and each label is covered by a test.

### 13.3 Gemini Nano on the Pixel 8a: find out first

The adapter seam is `deviceEngines()` in `apps/mobile/src/llm/engines.ts`,
which returns an empty list today. Whether the Pixel 8a can run Gemini Nano
through Google's on-device GenAI APIs is not known, and the code is right to
refuse to guess.

1. Spike, on a branch: a small Expo native module that asks the on-device GenAI
   API whether the feature is available on this phone, and shows the answer in
   diagnostics. Stop here if it says unavailable, and record that in
   deferred.md.
2. If it is available: implement a `StructuringEngine` over it with the same
   prompt and schema as Cloud Assist (`packages/extract/src/llm/prompt.ts`,
   `schema.ts`), return it from `deviceEngines()`, and update `deviceModel()`.
3. Score it with the existing harness against both the written fixtures and the
   real corpus from 13.1. Publish the numbers in the Phase 9 report, next to
   the rules floor.

Acceptance: either a recorded "unavailable on this hardware", or an engine with
measured scores. Never an adapter with no scores.

Exit for Phase 13: the extraction numbers in the reports are real-corpus
numbers.

---

## Phase 14 — Daily-driver gaps on mobile

Goal: someone other than the developer can use the app for a month without
needing the web app or a database tool.

### 14.1 Manage categories, accounts and merchants

Rows carry these columns and imports fill them; nothing on the phone edits them.

1. A "Manage" section on the profile screen, with a list screen per entity:
   rename, archive and create.
2. **Merchant merge** (carried since the Phase 1 report): pick two merchants,
   choose the surviving name, re-point transactions and aliases in one
   transaction, and keep the losing merchant as a tombstone so backup merge
   stays correct.
3. Repository functions and tests in `packages/db` first; the screens only call
   them.

Acceptance: merge is order-independent under the existing merge property tests,
and a merged merchant shows one row in summaries.

### 14.2 Statement CSV import on the phone

Parsing is already platform-independent (`packages/extract/src/statement/`).

1. Pick a file with `expo-document-picker`.
2. Reuse the web column-mapping flow's logic; build a mobile column-mapping
   screen and bulk confirm screen.
3. Dedupe through the existing `statement/dedupe.ts`.
4. PDFs stay on the web for now; the screen says so.

Acceptance: re-importing the same CSV creates zero duplicates, same as the web.

### 14.3 Recovery key as a QR code and a file

Phase 4.2 asked for both; the app shows text and a copy button
(`apps/mobile/app/backup.tsx`).

1. Render the formatted key as a QR code (an in-repo or zero-network library).
2. Offer "Save as file" through the share sheet: a small text file with the key,
   the date, and one sentence on what it unlocks.
3. Keep verify-before-continue unchanged: the user still types the last group.

Acceptance: the key round-trips through a QR scan and through the saved file
into a restore on the emulator.

### 14.4 Mobile UI tests

Screens are checked by hand today; only the logic under them is tested.

1. Add Maestro flows (YAML, run against the emulator) for: first launch → manual
   entry → appears in list; photo capture with the bundled receipt → confirm;
   backup to file → wipe → restore.
2. Document how to run them in running-locally.md. They run locally before a
   release build, not in CI (CI has no emulator).

Acceptance: the three flows pass on the emulator against a release build.

Exit for Phase 14: a beta tester can manage their own categories, import a
statement, and store their recovery key somewhere sensible.

---

## Phase 15 — Drive, for real

Needs: a Google Cloud project. Everything up to the consent screen is already
built and tested against a stand-in.

### 15.1 Set up the Google side

Follow [drive-connector.md → Setting one up](drive-connector.md#setting-one-up):

1. Cloud project with the Drive API enabled.
2. Consent screen requesting **only** `drive.appdata`. Test users: the owner.
3. Android OAuth client for `com.ksongprojects.txns` with the SHA-1 of the
   **release** certificate (the phone runs release builds) and of the debug
   certificate. Get each with
   `keytool -list -v -keystore <keystore> -alias <alias>`.
4. Put the client id in `app.json` (`expo.extra.googleClientId`) and add the
   `com.googleusercontent.apps.<id>` scheme to `expo.scheme`. A client id is not
   a secret; it is fine in a public repository.

### 15.2 Run the exit criteria that have never run

1. Phone: enable Drive backup; watch the consent screen; confirm the scope.
2. Emulator, wiped: sign into Drive, restore, and compare as in 12.3.
3. Leave the phone a week and confirm the refresh token still works or that
   the app asks to sign in again in words, not with an error code. While the
   consent screen is unverified, Google expires refresh tokens after about a
   week, so this is expected to need re-consent.

Acceptance: Phase 5's exit — new device → sign into Drive → everything back —
met and recorded in the Phase 5 report.

### 15.3 Design web-side backup writing before building it

The browser reads backups and cannot write them, because the Backup Master Key
would have to outlive a reload in browser storage. Write
`docs/adr/0012-web-backup-writing.md` comparing at least: re-deriving the key
from the password on every session (nothing stored), a non-extractable
WebCrypto key in IndexedDB, and staying read-only. Build only after the ADR is
accepted. Phase 6.3's round trip waits on this.

Exit for Phase 15: Drive works with a real Google account, and the web-writing
question has a written answer.

---

## Phase 16 — Play Store release (Android)

Needs: a Play Console account, a privacy-policy URL and a support URL.

1. **URLs.** The repository is public, so GitHub Pages can host them: publish
   `docs/release/privacy.md` as the privacy policy, and use the repository's
   Issues page or a short page as the support URL. The policy must say in
   public exactly what privacy.md says.
2. **Upload key.** Use the existing release keystore as the upload key and
   enrol in Play App Signing. Back the keystore up somewhere other than this
   PC before uploading anything — a lost upload key can be reset through Play,
   but only with Play App Signing on.
3. **Build an AAB**: `./gradlew bundleRelease`. Play needs a bundle, not an APK.
4. **Data safety form** from privacy.md; **listing** from
   [store-listing.md](release/store-listing.md); **screenshots** from the
   emulator with seeded fake data, never the phone.
5. **Google OAuth**: add the Play App Signing certificate's SHA-1 to the Android
   OAuth client, or Drive works in sideloads and fails from the store. Submit
   the consent screen for verification.
6. **Internal testing → closed testing.** New personal Play accounts must run a
   closed test with a minimum number of testers for a minimum period before
   production; check the current requirement in Play Console when the account
   is created.
7. Work the **Beta** and **Release** sections of the
   [release checklist](release/checklist.md), including the staged rollout.

Acceptance: the app is on Play's production track at a staged percentage.

---

## Phase 17 — iOS

Needs: a Mac with Xcode and an iPhone. iOS has never been built.

1. `npx expo prebuild -p ios`, `pod install`, build to a device.
2. Prove each native seam that has never run on iOS, in diagnostics, before
   anything else: expo-sqlite (the driver contract), react-native-libsodium (the
   11 crypto vectors), the PCM recorder and whisper.rn (one transcription),
   Vision OCR (the known receipt).
3. **SecureStore while locked**: schedule a backup, lock the phone, and confirm
   it ran. This is the specific unknown in deferred.md.
4. Repeat Phase 12 on the iPhone.
5. Apple Foundation Models adapter, the same way as 13.3: spike, then score.
6. TestFlight, then App Store, from the same checklist.

---

## Phase 18 — Web polish

Can run in parallel with anything above, since it touches only `apps/web`.

1. A stylesheet. The app is semantic HTML with none; keep it zero-dependency
   and inside the bundle budget.
2. Summaries in SQL rather than in JavaScript over the newest 5,000 rows.
3. Move archive decryption into the worker.
4. Detect a second tab and say so clearly. Use a `BroadcastChannel` to hand the
   database to the newest tab rather than silently falling back to memory.

Acceptance: the existing browser suite stays green, the bundle budget holds,
and every screen has been looked at on a phone-sized viewport.

---

## Keeping this file honest

When a task closes, record it in that phase's milestone report and remove or
update its line in [deferred.md](deferred.md). When a step here turns out to be
wrong, fix this file in the same commit as the code — a plan that disagrees with
the code is how the deferred list started.
