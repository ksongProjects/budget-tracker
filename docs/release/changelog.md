# Changelog

Sideload builds for device testing, published as GitHub prereleases on
`ksongProjects/budget-tracker`. Each one is signed with the TXNS release key, so
it installs over the last one and keeps the ledger. Newest first.

## 0.2.0 build fd9d330 — 2026-11-02

First version bump: 0.2.0, versionCode 2. Installs over 0.1.0 and keeps the
ledger (same signing key). No database migration.

### Receipt photos read properly

A real service invoice, photographed tilted with the card slip in frame, used
to read the slip as the merchant, guess the total from the largest amount,
flag the date as ambiguous and list 95 rows of checklist as items. Now:

- **Merchant** is the name printed over the address, not whatever is first in
  frame.
- **Date and time** come from the line labelled DATE, with the printed time
  kept. Before, every receipt was saved at 12:00. When day and month could be
  either way round, the day the photo was taken settles it.
- **Total** is read from the TOTAL line on tilted photos too.
- **Items** are the rows whose prices stand in the receipt's price column.
  Checklists, card slips and anything after the total are left out, and wrapped
  descriptions are joined. Quantity columns are read.
- **Tax** adds every tax line (PST and QST are now recognised beside GST and
  HST), and discounts are stored as negative amounts. The breakdown balances
  against the printed total.

### Fixes

- Uploading a CSV after a PDF no longer reads every row as unreadable: the
  PDF's date order and currency were carried over to the next file.

### Testing

- Mobile screen tests (Jest + Testing Library) render every route against a
  real SQLite ledger in CI, including backup and restore onto a wiped device.
- Four end-to-end flows run the release build on the emulator before each
  release: core ledger, capture with real OCR and the camera, uploading a CSV,
  a text PDF and a scanned PDF, and backup and restore.
- Coverage floors on every suite; CI fails below them.

Checked before publishing:
- 803 node, 69 browser and 22 screen tests pass.
- All 4 end-to-end flows pass on an x86_64 release build of this commit.
- On that build, the invoice photo read VALVOLINE EXPRESS CARE, 2026-11-01,
  263.16, and 19 rows that add up.

### Known, not fixed

Listed in [deferred.md](../deferred.md):
- **A backup cannot leave the phone without Google Drive.** The backup screen's
  "share sheet or cable" advice has no button behind it.
- **Imported rows show the bank's description in the home list**, not the
  merchant.
- **Nothing links to the Summary screen.** It is reached at `txns://summary`.

## 0.1.0 build 166dd78 — 2026-10-16

Fixes for build 50c4add. Install this one instead.

- **`/perf` no longer crashes.** It ran to the full-text search, then the app
  closed as it threw away its scratch database. The cause was an expo-sqlite
  double free on closing a connection that has used the full-text index. Your
  ledger was not affected: the crash came after every write had gone to the
  scratch database.
- **`/perf` now reaches the backup timing in release builds.** The receipt
  benchmark can't open its test image in a release build. It now says so and
  the run carries on, instead of stopping there.
- Two web tests updated: the ledger now shows the merchant ("Blue Bottle
  Coffee") instead of the bank's description.

Checked on the emulator with a release build of this commit:
- added 3 records, then ran `/perf` to the end
- the home screen still showed 3 records and no backup
- all 6 failure checks were refused, on the scratch ledger
- the driver contract passed 13 of 13

Emulator results, 10,000 rows:
- page query 5 ms
- summaries 7–10 ms
- search 7 ms
- insert 5 ms
- backup write 1.5 s

## 0.1.0 build 50c4add — 2026-10-15

**Superseded by the build above:** `/perf` crashes in this build.

Everything merged since build 64c33a5. No database migration: the ledger on the
phone is read as it is.

### Safety

- **`/perf` no longer touches your ledger or your backups.** The benchmark used to
  seed 10,000 fake transactions into the open ledger and time a real backup,
  whose retention then deleted your oldest real archive. It now runs in a
  separate `benchmark.db`, deleted afterwards. The backup timing uses throwaway
  keys and its own folder. The only thing it does to your ledger is one read.
- **Diagnostics' failure checks restore into a scratch ledger** instead of the
  real one. The driver-contract run no longer leaves a database file behind for
  every case.
- Code that writes test rows only accepts a scratch ledger, so pointing it at the
  real one is a compile error.

### Every record has the same shape

- Every saved spend is a **record**: a date, a merchant, its items and a total.
  Photo, voice, typed and statement entries all save through the same code, in
  one database transaction.
- A record with no breakdown shows one item for the whole amount. That item is
  worked out when read, never stored, so two devices can't each create one and
  have a backup merge keep both.
- The detail screen shows the merchant and always lists the items.
- What read each capture — camera OCR, rules, a model, CSV or PDF — is now
  recorded.

### Voice

- One recording can become **several records, grouped by merchant**. "Coffee
  4.50 and a muffin 3 at Blue Bottle, and 40 on gas at Shell" gives Blue Bottle
  with two items and Shell with one. Several are shown together and saved
  together; a single one goes to the add form as before.
- Saved as source `voice`, and the day you said ("yesterday") is kept instead of
  being replaced with today.
- After **Use this**, saving lands on the ledger instead of going back to the
  voice results.

### Add form and photo

- The add form has **merchant and date** fields.
- The photo confirm screen has a **category picker**, and the record, merchant
  and items are saved together, so an interrupted save can't leave a record
  without its items.

### Upload a file (replaces "Import a statement")

- **CSV** → statement import.
- **PDF** → read on the phone by pdf.js in a hidden WebView, the same reader and
  layout code as the web app. The page can't make any network request.
- **Scanned PDF** → a page with no text layer is drawn and read by on-device
  OCR, then goes through the same layout. On test scans, a JPEG page read all 8
  rows exactly; a black-and-white fax page read 7 of 8 and flagged the one it
  skipped. Up to 30 pages are read.
- **Image** → the receipt confirm screen, like a camera photo.

### Statements

- Each bank row becomes its own record on its own date.
- The merchant is taken from the bank description, and the original description
  is kept as the note. Re-importing the same file still flags duplicates.
- Optional posted-date column and optional account.

### Known limits

Listed in [deferred.md](../deferred.md):

- Merchants read from bank descriptions are a guess.
- No exchange rates on import.
- "One coffee and one tea" reads "one" as a price.
- Scanned PDFs are read on the phone only, not in the web app.

### Docs

- [next-steps.md](../next-steps.md): the step-by-step plan after phase 10.
- CONTEXT, data model and deferred list updated for records.

## 0.1.0 build 64c33a5 — 2026-10-15

First sideload build, published so the app can be installed on a phone without
USB. Everything up to phase 10, plus the TXNS rename, profile and home screen.
