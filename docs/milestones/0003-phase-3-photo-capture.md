# Milestone report — Phase 3: Photo capture

**Dates**: 2026-08-30
**Phase goal**: Photograph a receipt, see the total, confirm, done.
**Outcome**: shipped — capture, extraction, and confirmation all verified on a
device, and the performance budgets are finally measured. Auto-crop deferred.

## Tasks

| Task | Status | Evidence |
|---|---|---|
| 3.0 Device run (Phase 2 exit condition) | done | emulator; found a launch-blocking bug |
| 3.1 Camera + document storage | done | photo captured and stored on device |
| 3.2 On-device OCR adapter | done, verified | ML Kit on a dev build; found the column-split bug |
| 3.3 Tier 2 receipt heuristics | done | 34 tests |
| 3.4 Confirm screen | done | verified on device |
| 3.5 Redaction masking | done | 25 tests |
| 3.5 Auto-crop / crop adjust | **not done** | deferred |
| 2.6 Perf harness (carried) | done | all budgets measured, all passing |

## The device run, and what it caught

Phase 2 closed insisting the next phase begin on a device. It did, and the app
**failed on the first launch**:

```
Could not open your ledger
Property 'crypto' doesn't exist
```

`uuidv7()` calls `crypto.getRandomValues`, which Hermes does not provide. The
database could not be opened at all — every screen, every write, dead. Typecheck,
lint, and 174 tests had all been green; nothing but running it could have found
this. Fixed with `react-native-get-random-values`, imported in the app rather
than the package so `@budget/schema` stays platform-agnostic.

The Phase 2 error screen did its job: it named the failure instead of spinning.

**Verified on device after the fix**, on a Pixel 9 emulator via Expo Go:

- Migrations run on a fresh install; the empty state renders.
- Manual entry: keypad reads 12.34 from 1-2-3-4, saves, and appears under
  `August 2026 / Today` with a correct day total.
- Photo capture: camera permission gate, shutter, downscale, store, and the
  confirm screen with the photo preview.
- Saving from the confirm screen writes a `photo`-sourced transaction that lands
  in the ledger.
- **Data survives app reloads and emulator restarts** — the local-first promise,
  observed rather than assumed.
- **`DRIVER_CONTRACT` passes 13/13 against real expo-sqlite**, including
  transaction rollback, nested-transaction refusal, and integers surviving to
  the safe-integer boundary. The mobile driver provably behaves like the
  `node:sqlite` driver CI tests against.

## Test evidence

`pnpm check` green: **253 tests**, up from 174.

- **Receipt heuristics (34 tests).** Prefers an explicit "amount due" over a
  bare "total"; is not fooled by subtotal, tax, tip, cash, or change lines;
  rejects numbers that are not money (quantities, phone numbers, street
  addresses); reads thousands separators and comma decimals. Falls back to the
  largest amount only at confidence 0.3, so the confirm screen can say it is a
  guess. Every candidate carries the line it was read from.
- **Redaction (25 tests).** Masks Luhn-valid card numbers, ABA-valid routing
  numbers, labelled account numbers, and IBANs, while leaving prices, totals,
  and merchant names untouched. Unlabelled nine-digit numbers are left alone —
  they are far more often dates or order ids, and masking them would eat real
  data.

## OCR, verified on a development build

A development build (`npx expo run:android`) was produced and ML Kit ran against
a known receipt on the device. **This immediately found a real bug that no
fixture test could have.**

ML Kit emits a receipt's label column and amount column as **separate lines**:
`TAX` and `0.85` arrive apart, not as `TAX 0.85`. Every rule was written against
fixture text with them on one line, so against real output the extractor found
**no tax at all**, and got the total only by falling through to its
largest-amount guess — right on this receipt by luck, and wrong on any receipt
with one large line item.

The fix, `mergeColumns`, pairs an amount-only line with the label sharing its
row using bounding boxes. Its tolerance is a fraction of the median line height
rather than of the page, because engines report boxes in different units — ML
Kit in pixels, others normalized. Without boxes the lines are left untouched:
guessing at pairing would invent numbers.

The committed fixture now reproduces real ML Kit output rather than idealized
text. Verified on device after the fix: total 10.60, tax 0.85, merchant
`BLUE BOTTLE COFFEE`, card 4242, date Mar 14 2026 — every field correct, where
tax previously read "not found". Recognition takes 519–1154 ms.

Getting there needed three build fixes, all recorded in the repo:
`react-native-worklets` pinned to a version `expo-modules-core` compiles against,
and `react-native-reanimated` plus `react-native-gesture-handler` excluded from
autolinking — neither is used, and gesture-handler's generated paths exceed the
Windows 260-character limit.

Graceful degradation in Expo Go was also verified, and it is the right behaviour
rather than a workaround: a photo plus a hand-typed total is a complete, correct
transaction. OCR only saves typing.

## Performance — measured at last

The harness carried since Phase 2 now exists and has run. Numbers from a Pixel 9
emulator with **10,000 transactions** seeded, so the indexes do real work:

| Metric | Measured | Budget |
|---|---|---|
| Cold start to interactive ledger | **565 ms** | 1500 ms |
| Ledger page query (50 rows) | **9 ms** | 50 ms |
| Ledger page query over 10k rows | **8 ms** | 50 ms |
| Summary by category over 10k rows | **9 ms** | 50 ms |
| Summary by month | **12 ms** | 50 ms |
| Full-text search | **9 ms** | 50 ms |
| Seed 10k transactions | 22.4 s | 60 s |

**All within budget**, most by a factor of five or more. ADR 0009's claim that
on-device SQLite answers in single-digit milliseconds at this scale is now
measured rather than asserted — and the page query barely moves between a
handful of rows and 10,000, which is the partial indexes doing their job.

The harness had a bug of its own on the first run: cold start ran from bundle
load to whenever the tester pressed the button, and reported **71 seconds**. It
now ends when the ledger first paints. That error was in the alarming direction,
which is how it got caught; the same mistake in the flattering direction would
still be sitting there.

Not measured yet: shutter-to-preview, list scroll frame rate, and backup write.
The first two need frame instrumentation rather than a timer.

## Deviations from plan

- **Auto-crop and crop adjustment were not built.** Under ADR 0011 cropping is a
  UX control, not a security boundary, so it ranks below getting capture working
  end to end. Redaction — the part that is still security-relevant, because it
  gates what opt-in Cloud Assist may send — was built and tested instead.
- **Three native dependencies are pinned or excluded** to make the Android build
  work: `react-native-worklets` pinned to what `expo-modules-core` compiles
  against, and `react-native-reanimated` and `react-native-gesture-handler`
  excluded from autolinking. Nothing uses either; gesture-handler's generated
  paths also exceed the Windows 260-character limit.
- **`expo-file-system/legacy`** is used in `documents.ts`. SDK 54 introduced a
  File/Directory API; migrating is worth doing when there is another reason to
  touch that file.

## Risks carried forward

- **OCR is verified against one synthetic receipt, on one engine.** Crisp
  rendered text is the easy case; real photos bring skew, glare, and crumpled
  paper, and iOS Vision has not been run at all. The gitignored corpus of real
  scans is what would turn this into a real accuracy number.
- **Coordinate before touching the emulator.** Two runs were lost when the
  emulator was closed while tests were in flight. Nothing was wrong with how it
  was launched — an earlier version of this report guessed at process reaping
  and was wrong.
- **Merchant-merge, currency picker** still carried from Phases 1 and 2.
- **Captures are not deletable from the UI.** `deleteDocument` exists and is
  unused; deleting a transaction currently leaves its photo on disk.

## Next

Phase 4: backup, restore, and merge — the highest-stakes phase in the plan, and
the one where a bug loses user data rather than annoying someone. Still carried:
auto-crop, merchant-merge, a currency picker, and deleting a transaction's photo
when the transaction goes.
