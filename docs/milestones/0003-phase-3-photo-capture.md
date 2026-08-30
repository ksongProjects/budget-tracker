# Milestone report — Phase 3: Photo capture

**Dates**: 2026-08-30
**Phase goal**: Photograph a receipt, see the total, confirm, done.
**Outcome**: shipped-with-deviations — capture and confirm work on device; OCR
itself is unverified because it needs a development build.

## Tasks

| Task | Status | Evidence |
|---|---|---|
| 3.0 Device run (Phase 2 exit condition) | done | emulator; found a launch-blocking bug |
| 3.1 Camera + document storage | done | photo captured and stored on device |
| 3.2 On-device OCR adapter | done, unverified | interface + ML Kit adapter; no engine in Expo Go |
| 3.3 Tier 2 receipt heuristics | done | 34 tests |
| 3.4 Confirm screen | done | verified on device |
| 3.5 Redaction masking | done | 25 tests |
| 3.5 Auto-crop / crop adjust | **not done** | deferred |
| 2.6 Perf harness (carried) | **not done** | deferred again |

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

`pnpm check` green: **232 tests**, up from 174.

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

## What is still unverified

**OCR has never run.** Text recognition is a native module, absent from Expo Go,
so the confirm screen took its no-engine path in every device test. The
heuristics are tested against fixture OCR text, but the seam between a real
engine's output and those rules is untested. Closing it needs
`npx expo run:android` and a development build.

The graceful degradation was verified, and it is the right behaviour rather than
a workaround: a photo plus a hand-typed total is a complete, correct
transaction. OCR only saves typing.

## Deviations from plan

- **Auto-crop and crop adjustment were not built.** Under ADR 0011 cropping is a
  UX control, not a security boundary, so it ranks below getting capture working
  end to end. Redaction — the part that is still security-relevant, because it
  gates what opt-in Cloud Assist may send — was built and tested instead.
- **The perf harness slipped again.** It needs sustained device access, and this
  phase's device time went to the crypto bug and the capture flow.
- **`expo-file-system/legacy`** is used in `documents.ts`. SDK 54 introduced a
  File/Directory API; migrating is worth doing when there is another reason to
  touch that file.

## Risks carried forward

- **OCR is the unverified seam**, and it is the one the phase was named for.
- **Emulator sessions are unstable here** — the emulator was killed several
  times mid-run by process reaping, which cost real time. Launch it detached via
  `Start-Process`, not from a shell job.
- **Perf budgets remain entirely unmeasured** four phases in.
- **Merchant-merge, currency picker** still carried from Phases 1 and 2.
- **Captures are not deletable from the UI.** `deleteDocument` exists and is
  unused; deleting a transaction currently leaves its photo on disk.

## Next

A development build, to verify OCR against a real engine and finally run the
perf harness. Then Phase 4 (backup, restore, merge) — the highest-stakes phase
in the plan, and the one where a bug loses user data rather than annoying them.
