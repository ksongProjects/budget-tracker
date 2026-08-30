# Milestone report — Phase 1: Domain core

**Dates**: 2026-08-29 → 2026-08-29
**Phase goal**: The ledger exists as tested code, no UI.
**Outcome**: shipped

## Tasks

| Task | Status | Commits | Evidence |
|---|---|---|---|
| 1.0 Split build/lint tsconfigs (Phase 0 debt) | done | `35803f8` | `dist` holds no test output |
| 1.1 `schema`: zod types, money, ids | done | `88b56e6` | 47 tests |
| 1.2 `db`: driver, migrations, DDL, indexes | done | `e0689d9` | 12 tests incl. every intermediate version |
| 1.3 `db`: repository, filters, aggregates | done | `7af586e` | 39 tests |
| 1.4 `db`: soft delete, rev, tombstones | done | `7af586e` | folded into 1.3, see deviations |
| 1.5 Merchant canonicalization + aliases | done | `1e1496e`, `2c83620` | 22 tests |

## Test evidence

`pnpm check` green: lint clean, typecheck clean, **112 tests passing** across 6
files. Every test runs against real SQLite via `node:sqlite` — no mocks, no
device, no native build.

What the suite actually pins down:

- **Money never touches a float.** `12.34` parses through string arithmetic to
  `1234`; the round-trip property is asserted over a set of amounts, and excess
  precision (`12.345` USD) is rejected rather than rounded. Zero-decimal (JPY)
  and three-decimal (KWD) currencies are covered.
- **Unconfirmed rows never reach a total.** Asserted on `summary()` and
  `total()` directly, with an unconfirmed 9999 sitting in the same category.
- **Migrations apply from zero and from every intermediate version**, roll back
  on failure leaving `user_version` untouched, and refuse a database newer than
  the build.
- **Failed writes leave nothing behind.** An invalid patch rolls back both the
  row and the tombstone it had already written.
- **Merchant normalization does not over-merge.** `Apple Store` ≠ `Apple`,
  `Target Optical` ≠ `Target`, `7-Eleven` keeps its digit.

## Performance

Not budgeted this phase; the harness lands in Phase 2.6. Incidental datapoint:
the full 112-test suite, including ~30 real SQLite databases created and
migrated, runs in about 0.6 s.

## Review

`cavecrew-reviewer` over the full phase diff, weighted toward money handling, SQL
correctness, rollback semantics, and data loss. Three defects found, all in
merchant writes, all fixed in `2c83620`:

- **`resolve()` was not atomic** — merchant and alias were separate statements,
  so a failure between them orphaned a merchant `resolve` could never find
  again, and the next occurrence would create a duplicate. Now one transaction.
- **`rename()` and `addAlias()` overwrote rows without a tombstone**, breaking
  the merge contract Phase 4 depends on and losing the prior value.
- **A fourth defect surfaced while fixing the third**: normalization stripped a
  bare trailing `store`, folding `Apple Store` into `Apple`. This is the
  over-merge failure mode the review was asked to hunt — a total attributed to
  the wrong merchant is invisible, where a duplicate is obvious. The pattern now
  requires the store number that makes it noise.

No findings against `packages/schema`.

## Deviations from plan

- **1.3 and 1.4 shipped as one commit.** Rev bookkeeping, soft delete, and
  tombstones are properties of the write path, not a layer on top of it;
  building the repository without them would have meant writing the write path
  twice. Tests cover them separately.
- **Money is `number`, not `bigint`** as the plan said. The safe-integer ceiling
  is ~90 trillion dollars in minor units, and `bigint` breaks the JSON
  round-trips that extraction payloads and backup manifests need. Every value is
  range-checked; `MoneyError` is thrown rather than silently wrapping.
- **Toolchain moved to vitest 4 / vite 7.** Vite 5 does not recognize the
  `node:sqlite` builtin and strips the prefix, which broke every db test. Node
  is now pinned to 24 in `engines` and CI.
- **ESLint switched from `projectService` to an explicit project list**, because
  the Phase 0 debt fix (tests excluded from package tsconfigs) left the service
  unable to find test files.

## Risks carried forward

- **`toTransaction` validates every row through zod on read.** Correct — a
  restored backup may predate the current schema — but it is per-row work on the
  list path. Phase 2.6 measures it; if the 10k-row budget is threatened, the fix
  is validating at the page boundary, not dropping validation.
- **Merchant normalization is a heuristic and will be wrong sometimes.** It errs
  toward under-merging by design. It needs a user-facing "these are the same
  merchant" merge action, which is not yet in any phase — worth adding to
  Phase 2.
- **Only `transactions` has a repository.** Line items, categories, accounts,
  and captures have schema and DDL but no repository yet; Phase 2 will need at
  least categories and accounts.
- **`node:sqlite` is still flagged experimental** and prints a warning on every
  run. It is a test-time dependency only — mobile uses expo-sqlite, web uses
  WASM — so the blast radius is CI, but a Node change could break the suite.
- **CI remains unverified.** No remote yet, so the workflow has never run.

## Next

Phase 2 (mobile shell + manual capture). Add to its task list: repositories for
categories and accounts, and a merchant-merge UI action for the risk noted
above.
