# Milestone report — Phase 0: Docs reconciliation + repo scaffolding

**Dates**: 2026-08-29 → 2026-08-29
**Phase goal**: Docs tell one coherent story (ADR 0011); toolchain runs.
**Outcome**: shipped

## Tasks

| Task | Status | Commits | Evidence |
|---|---|---|---|
| 0.1 Rewrite `CONTEXT.md` for local-first | done | `45454cf` | No term contradicts ADR 0011 (review confirmed) |
| 0.2 Rewrite `crypto-design.md` | done | `ad45446` | Key hierarchy matches ADR 0011 §6 |
| 0.3 Replace `api.md` with `backup-format.md` + `drive-connector.md` | done | `6fe9b0b`, `26a0e5a` | `api.md` deleted, no surviving references |
| 0.4 Update `data-model.md` | done | `c9222b4` | Concrete enough to drive Phase 1 migrations |
| 0.5 Update `extraction.md` + `README.md` | done | `753e769` | README "Shape" matches ADR 0011 |
| 0.6 Scaffold monorepo + CI | done | `b8e686c` | `pnpm check` green locally |

ADR 0011 itself and the implementation plan landed earlier in `4ecb11e`, which is
the baseline this phase builds on.

## Test evidence

`pnpm check` (lint → typecheck → test) passes clean:

```
eslint .            no findings
tsc --build         no errors
vitest run          5 test files, 5 tests passed (479ms)
```

Five smoke tests, one per package, asserting each package is wired into the
workspace build and test run. They exist to prove the toolchain, not the domain —
real coverage starts in Phase 1.

CI (`.github/workflows/ci.yml`) runs the same three steps on push and PR with
`--frozen-lockfile`. Not yet observed green on a real runner: there is no remote,
so the workflow is unexercised. First push validates it.

## Performance

None budgeted this phase. The perf harness lands in Phase 2.6.

## Review

`cavecrew-reviewer` over the full phase diff (`4ecb11e..753e769`), checking doc
contradictions against ADR 0011, internal link integrity, crypto/backup spec
soundness, and scaffold correctness.

- **Fixed**: `backup-format.md` frame-nonce spec referenced a per-archive random
  prefix that the header field list never declared, leaving implementors without a
  defined place to read it from. Now declared as `nonce_prefix: bytes(16)` in the
  header (`26a0e5a`).
- **Clean**: no doc still assumes a server, accounts, server-readable ledger,
  escrow, or the DMK/DEK hierarchy. No broken internal links; the `api.md` deletion
  left no dangling references. Scaffold config correct.

## Deviations from plan

- **ESLint configuration reworked mid-task.** The planned single type-aware config
  failed on the root config files, which belong to no package tsconfig and so
  resolved against a default project without `strictNullChecks`. Settled on
  type-aware linting scoped to `packages/**` and `apps/**`, with
  `disableTypeChecked` for root config files. No scope change.
- **`.gitattributes` added, not in the plan.** The repo is developed on Windows
  against LF-normalized files; without it every commit emitted CRLF warnings and
  line endings would eventually diverge across contributors.
- **pnpm 10 build-script allowlist.** `esbuild`'s postinstall is blocked by default
  in pnpm 10, which silently breaks vitest. Allowlisted via
  `pnpm.onlyBuiltDependencies`.

## Risks carried forward

- **Test files compile into `dist`.** Package tsconfigs include `src/**/*`, so
  `*.test.ts` is type-checked and linted (wanted) but also emitted (not wanted).
  Harmless while nothing consumes `dist`; fix with a build-specific tsconfig in
  Phase 1, when apps start importing these packages.
- **CI is unverified.** No git remote exists, so the workflow has never run. Push
  before trusting it.
- **Docs now describe an unbuilt system.** `data-model.md` and `backup-format.md`
  are specifications, not descriptions. Phase 1 and Phase 4 will find things they
  got wrong; the expectation is that those phases amend the docs rather than let
  code drift from them.
- **No dependency-vulnerability scanning yet.** Worth adding to CI before crypto
  dependencies land in Phase 4.

## Next

Phase 1 (domain core: `packages/schema`, `packages/db`) proceeds as planned, with
one addition to task 1.2: split build and lint tsconfigs so tests stop emitting to
`dist`. `data-model.md` is the source of truth for the migrations; where the schema
doc turns out to be wrong, amend the doc in the same commit as the code.
