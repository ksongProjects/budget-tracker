# Milestone report — Phase 2: Mobile shell + manual capture

**Dates**: 2026-08-29 → 2026-08-30
**Phase goal**: A daily-driver for typed entry. Earliest dogfood point.
**Outcome**: shipped-with-deviations — the code is complete and CI-green, but
**nothing in this phase has run on a phone yet**. See "The verification gap".

## Tasks

| Task | Status | Commits | Evidence |
|---|---|---|---|
| 2.0 Category + account repositories (Phase 1 debt) | done | `be495b6` | 16 tests |
| 2.0b Driver contract as shared data | done (added) | `be495b6` | 14 cases, node driver green |
| 2.1 Expo app, router, expo-sqlite, migrate on launch | done | `e6d1889` | Metro bundles; app mounts |
| 2.2 Manual capture, amount-first | done | `e6d1889` | 19 keypad tests |
| 2.3 Ledger list, day grouping, month headers | done | `e6d1889` | 11 grouping tests |
| 2.4 Summary by category and month | done | `e6d1889` | repo aggregates from Phase 1 |
| 2.5 Edit / confirm / soft delete | done | `e6d1889` | repository tests from Phase 1 |
| 2.6 Perf harness | **not done** | — | deferred, see deviations |
| Merchant-merge action (Phase 1 risk) | **not done** | — | deferred to Phase 3 |

## Test evidence

`pnpm check` green: typecheck (packages, test config, and the Expo app), lint,
and **174 tests**, up from 112.

New coverage this phase, all of it the logic that can silently produce a wrong
number:

- **Amount keypad (19 tests).** Digits accumulate into integer minor units —
  1, 2, 3, 4 walks 0.01 → 0.12 → 1.23 → 12.34 — so no decimal string is ever
  parsed and no float is ever involved. Backspace bottoms out at zero rather
  than going negative; entry stops at 12 digits rather than overflowing.
- **Day grouping (11 tests).** Local-day keys, so an 11pm coffee stays on that
  evening. Unconfirmed rows render but never enter a day total. A day mixing
  currencies reports **no** total rather than adding numbers that mean nothing
  together.
- **Category and account repositories (16 tests).** Soft delete leaves
  transactions' attribution intact — tidying a category list must not rewrite
  what past spending says.
- **Driver contract (14 cases).** Including integers surviving to
  `Number.MAX_SAFE_INTEGER`, since a driver that routes integers through a float
  makes every large amount wrong.

## The verification gap

This is the honest part of this report.

**Verified here**: Metro bundles the whole app; the React tree mounts; the app
typechecks under `strict` plus `exactOptionalPropertyTypes`; all pure logic is
tested in CI.

**Not verified**: everything touching `expo-sqlite`. No screen has been seen
with real data, no query has run against the database that actually ships, and
the ≤4-taps and 60fps acceptance criteria are unmeasured.

Running the app under Expo's web target was attempted to close some of this gap.
It did catch one real bug (below), but `expo-sqlite` on web needs OPFS with
COOP/COEP headers the dev server does not set, so the app hangs at "opening the
database" there. Chasing that further was rejected: Expo-web is not the
product's web story — Phase 6 is a separate Vite SPA with its own SQLite WASM
setup — so the effort would have bought a screenshot, not confidence.

Two things were built instead of faking verification:

1. **A diagnostics screen** (`app/diagnostics.tsx`) that runs `DRIVER_CONTRACT`
   against the real expo-sqlite driver on a device. CI proves the contract
   against `node:sqlite`, which is not the database that ships; this is how the
   mobile driver gets checked on real hardware.
2. **A timeout on database open.** A hung open is indistinguishable from a slow
   one on screen, and "spinner forever" tells the user nothing about their own
   data.

**Phase 3 must begin by running the app on a device or emulator** — opening
diagnostics, entering a spend, and confirming it lands. Until that happens,
treat this phase's UI as unverified.

## Bugs found

**Metro does not resolve `.js` specifiers onto `.tsx` sources** the way
TypeScript's `bundler` resolution does. The app typechecked cleanly and then
failed to bundle. App-internal imports are now extensionless; packages keep
their `.js` extensions, which are correct there because `tsc` emits real `.js`.
Two toolchains, two conventions, and only running the bundler surfaced it.

**Aggregates summed across currencies.** Writing the risk list for this report
surfaced it: `summary()` and `total()` added `amount_minor` with no currency
grouping, so 100 USD + 200 EUR read as 300 — a wrong total that looks exactly
like a right one. Fixed rather than carried: `summary()` now groups by currency,
`totals()` returns one row per currency, and `total()` requires a named
currency. The summary screen renders a line per currency instead of labelling
everything USD. Two tests pin it.

## Performance

Not measured. Task 2.6's harness needs a device, so it moves to Phase 3 with the
rest of the on-device work. The budgets in the implementation plan stand
unverified.

## Deviations from plan

- **Task 2.6 (perf harness) deferred to Phase 3**, because every budget in it is
  a device measurement.
- **The merchant-merge action** carried from Phase 1 was not built. It needs a
  merchant picker that manual entry does not yet have; it belongs with photo
  capture in Phase 3, where merchants first arrive automatically.
- **A driver contract was added** beyond the plan. Three drivers must behave
  identically and only one runs in CI; without it, that is an assumption.
- **`node-linker=hoisted`** is now set for pnpm. Metro does not follow pnpm's
  isolated symlink layout reliably.
- **Node pinned to 24** and the repo moved to vitest 4 / vite 7 during Phase 1
  for `node:sqlite`; the app inherits that.

## Risks carried forward

- **The whole UI is unverified on device.** Highest risk in the project right
  now, and it compounds: Phase 3 builds capture flows on top of screens nobody
  has used.
- **`useQuery` refetches on focus and on a version counter**, which is adequate
  for one device and a few thousand rows and will not survive a large ledger or
  background writes. Replace when it hurts, not before — but know it is there.
- **No `eslint-plugin-react-hooks`.** A stale disable comment for a rule that
  was never configured was removed this phase; the plugin itself should be added
  before the app grows more hooks.
- **Currency is still hardcoded to USD on the entry screen.** There is no UI to
  pick one, though the data model and every aggregate are now multi-currency.

## Next

Phase 3 (photo capture), starting with a device run to close the verification
gap, then the perf harness. Add to its scope: the merchant-merge action, and a
currency picker on the entry screen.
