# Changelog

Sideload builds for device testing, published as GitHub prereleases on
`ksongProjects/budget-tracker`. Each one is signed with the TXNS release key, so
it installs over the last one and keeps the ledger. Newest first.

## 0.1.0 build 50c4add — 2026-10-15

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
