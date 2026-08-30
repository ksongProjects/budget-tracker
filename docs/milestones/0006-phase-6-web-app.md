# Milestone report — Phase 6: web app

**Dates**: 2026-08-30 → 2026-08-30
**Phase goal**: browser session hydrated from a backup, fast.
**Outcome**: shipped-with-deviations — the browser reads the ledger, opens a
phone's backup, edits, and exports. Writing backups from the browser and the
live Drive round trip are deliberately not done; both are explained below.

## Tasks

| Task | Status | Evidence |
|---|---|---|
| 6.1 Vite SPA, SQLite WASM + OPFS in a worker, message layer | done | the shared driver contract runs in headless Chromium in CI: 17 cases including data surviving a reopen |
| 6.2 Backup import, streaming decrypt → OPFS | done | a real archive written and read in a browser; a 24 MB one imports in about a second |
| 6.3 Drive connector, web OAuth | partial | the transport is exercised in-browser against the stand-in; sign-in is built and unverified; the browser reads and does not write |
| 6.4 Views: list, summaries, manual entry, edit/confirm | done | 47 browser tests drive the screens against the real database |
| 6.5 Export CSV/PDF | done | shared `@budget/report`: the phone and the browser emit the same file because they run the same code |
| 6.6 Bundle integrity: CSP, no third-party scripts, size budget | done | strict CSP in the page; CI builds and enforces the budget |

## Test evidence

405 node tests and 47 browser tests at phase close.

The browser suite runs in real Chromium under Playwright, not a simulated DOM.
OPFS, workers and a WASM build do not exist in a shim, and a green suite under
happy-dom would prove nothing about the storage the ledger actually lives in.

`packages/report` is new: the CSV writer, the printable report and the calendar
helpers, shared with mobile. Its 15 tests moved with it. A day boundary that
differed between the two platforms would put one spend on two different days.

## Performance

Chromium, headless, on this machine:

- Full driver contract over OPFS: 17 cases in ~1.9 s.
- 24 MB archive: decrypt, stage, read and merge in roughly a second.
- Bundle, gzipped: **103 KB of JavaScript on every visit**, 286 KB in total,
  384 KB of WebAssembly. The budget check fails CI above 120 / 300 / 450 KB.

Two findings came out of meeting that budget rather than raising it. libsodium
is a third of the JavaScript and only a visitor opening a backup needs it, so it
loads on demand. And the SQLite package's entry drags in a "worker1" promiser
this app never uses — about 200 KB uncompressed — which an alias to the module
we actually use removes. Every visit went from 157 KB to 103 KB.

## Deviations from plan

**The browser reads from Drive and does not write.** Writing needs a Backup
Master Key that survives a reload, and browser storage is a materially different
threat model from a phone's OS keystore. Making that call in passing, in the
last hour of a phase, would be the wrong way to decide where a key that opens
every backup gets kept.

**6.3's acceptance — mobile backup → web edit → web backup → mobile merge —
therefore cannot be run**, and would need a Google client id even if it could.

**No File System Access API handle-remembering.** The plan asked for it on
Chromium with a picker fallback elsewhere; what is built is the picker and
drag-drop, which is the fallback path. Remembering a handle is worth doing when
the browser also writes backups, and pointless before that.

**No framework.** The plan did not name one; this is a note rather than a
deviation. The screens are a list, a form and two file operations, and a
framework would be more code to audit than the app it renders — against a phase
that has to promise no third-party scripts in the bundle.

## Risks carried forward

- Sign-in code has never run against Google. The redirect, the exchange and the
  refresh are all written and unproven.
- Import decrypts on the main thread. It is about a second for 24 MB, which is
  within budget, but it is the first thing to move into the worker if archives
  grow — a photo-heavy ledger will get there.
- The OPFS pool holds its access handles exclusively per origin. Two tabs of
  this app on the same origin have not been tried, and the second one will not
  get durable storage.
- The bundle budget's eager/lazy split reads Vite's manifest. A change in that
  format would need the check updated with it.

## Next

Phase 7 is statements. Before it, the two credential-blocked items — the mobile
Drive round trip and 6.3's cross-device test — can both be closed in one sitting
once a client id exists.
