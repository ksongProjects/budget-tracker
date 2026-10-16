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
- **Scanned PDFs are read by OCR on the phone only.** A page with no text layer
  is drawn in the WebView, read by ML Kit and turned back into page positions
  (`pageFromOcr`), then goes through the generic layout — never a bank's rule
  set, whose positions were measured on generated PDFs. The web app still says
  a scan has no text layer. Expo Go has no ML Kit, so there too. Quality follows
  the scan: on a 200 dpi black-and-white fax test page one row of eight was
  skipped and `*` read as `"`; a JPEG scan of the same page read perfectly. At
  most 30 pages are drawn. pdf.js's CCITT/JBIG2 and JPEG 2000 decoders are
  WebAssembly, handed to it from the app's assets rather than fetched.
- **PDFs on the phone are read by pdf.js in a WebView.** The same library and the
  same `readStatementDocument` as the web app, so the two cannot disagree about
  a file — but it is a second runtime to keep alive: pdf.js is copied into the
  app's assets on install (`apps/mobile/scripts/vendor-pdfjs.mjs`), and a
  pdfjs-dist upgrade that changes its build file names breaks that copy loudly
  rather than quietly.
- **A merchant read from a bank description is a guess.** Normalization strips
  the usual noise ("SQ *", store numbers), but a description like
  "POS 4412 PURCHASE" becomes a merchant called "Pos 4412 Purchase". The raw
  description is kept as the note, and the row stays unconfirmed until accepted.
- **No FX on import.** `fx_original_*` stays empty everywhere: nothing on the
  device knows a rate, and inventing one would rewrite history the column exists
  to protect. Needs a statement format that prints the original amount.
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
- **Several spends in one recording are split by rule, not by a model.** A
  clause is cut off only where both sides name an amount, and grouped by the
  merchant it names or the next one named. A model reads one spend per call, so
  it is used only when the rules find one record. "One coffee and one tea" reads
  "one" as an amount — the price of an item said in words collides with a
  quantity said in words.
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

## Release

- **No iOS build has ever run.** Not a port that needs polish — an untested one.
  whisper.rn, expo-sqlite, react-native-libsodium and the PCM recorder each have
  an iOS path this project has never executed, and there has never been a Mac in
  it.
- **Every benchmark is an emulator number.** The plan says to measure on cheap
  hardware; an x86 emulator is neither cheap hardware nor a phone. The one budget
  currently missed — shutter to provisional total, 532 ms against 500 — is
  477 ms of ML Kit and 1 ms of our own code, and may not be a miss at all on a
  device with an NPU.
- **No support URL and no privacy policy.** Both stores require them; neither
  exists. The policy has to say in public what docs/release/privacy.md says.
- **No store accounts and no signing keys.** Including an Android upload key,
  whose loss would mean a new listing.
- **No crash reporting, deliberately.** It keeps the privacy labels true and it
  means the first release's failures arrive as store reviews rather than stack
  traces.

## Testing

- **The frozen v1 archive fixture is not a real SQLite file.** It holds marker
  text, so it proves the *format* still opens and cannot prove a real ledger
  still restores. A second frozen fixture containing an actual snapshot would
  close that.
- **No mobile UI tests.** The screens are checked by driving a device by hand;
  only the logic beneath them is under test. The web app's screens *are* tested,
  which is the shape mobile should copy.
