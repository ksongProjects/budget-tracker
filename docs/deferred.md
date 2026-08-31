# Deferred work

Everything knowingly left undone, with the reason and what would unblock it.
Kept in one file because the alternative is a promise remembered by whoever was
in the room — and the items here are exactly the ones that look finished from
the outside.

Ordinary future phases are not listed; the implementation plan already holds
those. This is for work inside phases that are otherwise closed.

## Blocked on a Google account

Nothing in the repository carries a Google identity, and none of this can be
checked without one. See [drive-connector.md](drive-connector.md#setting-one-up)
for exactly what to create.

- **The consent screen has never been shown.** Scope, branding, and the
  unverified-app warning are unproven.
- **No token has ever come from Google.** The exchange, the refresh, and the
  behaviour of an expired refresh token are written and untested against the
  real endpoint.
- **Phase 5's exit criterion — new phone → sign into Drive → everything back —
  is not met.** Everything up to the consent screen is exercised against the
  stand-in.
- **Phase 6.3's acceptance — mobile backup → web edit → web backup → mobile
  merge — cannot be run**, and additionally needs the browser to write backups
  (below).

## Backups and the cloud

- **The browser cannot write a backup.** It reads and restores only. Writing
  needs a Backup Master Key that survives a reload, and browser storage is a
  materially different threat model from a phone's OS keystore. That decision
  deserves its own design rather than being made in passing.
- **No incremental archives.** Every backup carries every document again. The
  manifest already records content hashes so a future format can skip unchanged
  ones; a photo-heavy ledger will want this before it wants anything else here.
- **Documents are not restored in the browser.** The web import reads the ledger
  out of an archive and counts the documents it carried, but does not write them
  anywhere — there is no capture story on the web yet for them to belong to.
- **The scheduled backup's job carries a network constraint** that
  `expo-background-task` sets and its API does not expose. A backup needing no
  network will not fire while the device is offline. Backgrounding remains the
  mechanism; the schedule is the second chance.
- **The OS schedule has only ever been forced.** It was run through
  `adb shell cmd jobscheduler run -f`, which exercises the same code path, but
  no run has been observed happening on its own twelve hours later.
- **The recovery key is shown as text only.** Phase 4.2 asked for a key file and
  a QR code; what exists is the printed key and a copy button. A user without a
  password manager has nowhere good to put it.
- **Nothing has run on iOS.** SecureStore accessibility while the device is
  locked is the specific unknown: a scheduled backup that cannot read the key
  material at 3am fails silently on that platform.

## Web app

- **Import decrypts on the main thread.** 24 MB takes about a second, which is
  within budget, but this is the first thing to move into the worker when
  archives grow.
- **Two tabs on one origin are not handled.** The OPFS pool holds its access
  handles exclusively, so a second tab silently gets in-memory storage. It says
  so on screen, which is the floor rather than an answer.
- **No File System Access API handle-remembering.** Phase 6.2 asked for it on
  Chromium with a picker fallback; the picker is what exists. It is worth doing
  when the browser also writes backups, and pointless before that.
- **The app has no styling.** It is semantic HTML with no stylesheet. Every
  screen works and none of them are pleasant.
- **The summary totals in JavaScript** over the newest 5,000 rows rather than in
  SQL. Correct at any size a browser will hold, wasteful past that.
- **The bundle budget's eager/lazy split reads Vite's manifest format.** A change
  there needs the check updated with it, and the failure mode is a budget that
  silently measures the wrong thing.

## Mobile

- **A stray empty `restore.db`** may sit in the SQLite directory of any device
  that ran a build from before the restore-path fix. Cosmetic; cleared by a
  reinstall.
- **No management screens** for accounts, categories or merchants. Rows carry
  those columns and imports will populate them; nothing edits them yet.

## Statements

- **No rule set has met a real statement.** The two that ship are synthetic
  examples proving the format; the fixtures are layouts with invented amounts,
  because real statements are personal documents and the corpus is gitignored.
  The first real file will likely need a third rule set and find something in
  the layout code.
- **Scanned PDFs are not read.** There is no text layer in an image, and OCR for
  PDFs is Tier 2 work this phase did not take on. The screen says so rather than
  showing an empty table.
- **Statement import is web-only.** The phone has no import screen; rows reach it
  through a backup. Nothing about the parsing is web-specific, so the work is a
  screen rather than a pipeline.
- **Column detection assumes a tabular layout.** A gap recurring on most lines is
  a column — right for the common case, wrong for statements that use ruled
  boxes or wrap a description across lines.

## Voice

- **No physical device has heard this.** The emulator's microphone is silence,
  so the pipeline is proven — record, encode, transcribe, parse — and the
  accuracy is not. A phone run is the cheapest next check and would produce the
  first real word error rate.
- **Only English.** Transcription is pinned to it because the parser reads
  English number words. Another language needs both halves changed together.
- **The PCM recorder is an old-architecture native module.** It reaches the app
  through React Native's interop layer; a release that drops that layer takes
  voice capture with it.
- **`whisper.rn` resolves only as `whisper.rn/index`.** Its export map declares
  no "." entry, so the bare specifier fails and a tsconfig path points
  TypeScript at the shipped declarations. Both revert when upstream fixes it.
- **A spoken merchant loses its branch number.** The merchant phrase stops at
  the first number, which is right when the amount follows the name — "at
  Tartine, eighteen fifty" — and wrong for "at Safeway 0421".

## Reading with a model

- **No on-device model adapter exists.** Apple Foundation Models needs an iOS 26
  device and a Mac to build for; Gemini Nano needs AICore on recent Pixel
  hardware, and an x86 emulator has neither. The seam is
  `apps/mobile/src/llm/engines.ts`, which returns an empty list today, and the
  scoring harness will mark whatever it returns. Writing the adapters blind
  would put unmeasured engines into a suite whose numbers are the point.
- **So line items need Cloud Assist.** That means a user-supplied key and a tap
  per capture. Every other field — total, tax, date, merchant — still comes from
  the rules with no model and no network.
- **The rules floor of 77% is measured against fixtures we wrote.** Eight
  invented texts with the shapes that break parsers. A real corpus will move the
  number, and that is the point of keeping the harness.
- **Reconciliation has no tolerance.** Items plus tax plus tip must equal the
  total exactly, so a discount line always reads as unbalanced. Right for now —
  the gap is shown, not hidden — but a flag that fires on every grocery receipt
  will stop being read.
- **Cloud Assist has no cost display.** It spends the user's own quota with no
  running total, which is one more reason it is a per-capture tap rather than a
  setting.

## Testing

- **The frozen v1 archive fixture is not a real SQLite file.** It holds marker
  text, so it proves the *format* still opens and cannot prove a real ledger
  still restores. A second frozen fixture containing an actual snapshot would
  close that.
- **No mobile UI tests.** The screens are checked by driving a device by hand;
  only the logic beneath them is under test. The web app's screens *are* tested,
  which is the shape mobile should copy.
