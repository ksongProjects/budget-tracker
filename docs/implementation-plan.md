# Implementation plan

Executes [ADR 0011](adr/0011-local-first.md). Mobile is established first (Phases
0–5); web follows (Phase 6); remaining capture kinds and Tier 3 after that. Every
phase ends with a milestone report in [`docs/milestones/`](milestones/).

## How work runs

**Task granularity.** Every task below is scoped for one agent session: touches one
package or one screen, has explicit acceptance criteria, and lands as 1–3 commits.
If a task turns out to need more, split it and note the split in the milestone
report — never let a task balloon silently.

**The loop per task:**

1. **Investigate** — read the relevant docs section and existing code before
   writing. For pure lookups, delegate to `cavecrew-investigator`.
2. **Build** — implement with tests in the same commit-series. Small mechanical
   edits can go to `cavecrew-builder`.
3. **Test** — the task's listed tests pass locally; no task is done with a red
   suite. New code without tests is an automatic review rejection.
4. **Review** — `cavecrew-reviewer` (or `/code-review`) over the diff before it is
   considered done. Findings fixed or explicitly waived in the milestone report.
5. **Commit** — Conventional Commits, subject ≤ 50 chars, one logical change per
   commit. Schema change, its migration, and its tests = one commit. Unrelated
   drive-by fixes = separate commit.

**Review gates.** End of each phase: full test suite green, `/code-review` over the
phase's whole diff, exit criteria checked off, milestone report written from
[`milestones/TEMPLATE.md`](milestones/TEMPLATE.md). No starting the next phase with
open CRITICAL findings.

**Repo layout** (pnpm workspaces monorepo):

```
apps/mobile        Expo app
apps/web           Vite SPA (Phase 6)
packages/schema    zod domain types, shared everywhere
packages/db        SQLite schema, migrations, repository layer
packages/crypto    backup encryption, key derivation, wrapping
packages/backup    archive format, snapshot, merge-on-import
packages/extract   tiers, rules, heuristics (pure TS, platform adapters inject OCR/STT)
```

Pure-TS packages are where the logic lives; apps stay thin. This is what makes the
code testable in CI without a device and reusable across mobile and web.

---

## Phase 0 — Docs reconciliation + repo scaffolding

Goal: docs tell one coherent story (ADR 0011); toolchain runs.

| # | Task | Acceptance |
|---|---|---|
| 0.1 | Rewrite `CONTEXT.md` for local-first: Ledger = local SQLite; retire Derivative/DMK/DEK/Escrow/Hard-mode entries; add BMK, Recovery Key, Backup, Merge | No term in CONTEXT.md contradicts ADR 0011 |
| 0.2 | Rewrite `crypto-design.md`: BMK wrapped by password-KEK + recovery key; backup archive AEAD; web-bundle integrity section | Key hierarchy diagram matches ADR 0011 §6 |
| 0.3 | Replace `api.md` with `backup-format.md` (archive layout, versioning, streaming-friendly framing) + `drive-connector.md` (OAuth scope, appDataFolder flow) | Old api.md deleted; new docs cover Phase 4–5 needs |
| 0.4 | Update `data-model.md`: local SQLite schema, `capture_id`, `rev`/tombstone merge rules; drop PT/CT legend and server tables | Schema doc is the source for Phase 1 migrations |
| 0.5 | Update `extraction.md` + `README.md` for on-device pipeline and new doc map | README "Shape" matches ADR 0011 |
| 0.6 | Scaffold monorepo: pnpm workspaces, TS strict, ESLint, Vitest, CI (lint + typecheck + test), empty packages with placeholder tests | `pnpm -r test` green in CI |

Exit: a newcomer reading README → CONTEXT → ADR 0011 gets the true architecture.

## Phase 1 — Domain core (`packages/schema`, `packages/db`)

Goal: the ledger exists as tested code, no UI.

| # | Task | Acceptance |
|---|---|---|
| 1.1 | `schema`: zod types for Transaction, LineItem, Merchant, Category, Account, Capture; money as `amount_minor` bigint + currency — never float | Round-trip parse/serialize tests; float rejection tested |
| 1.2 | `db`: SQLite DDL + migration runner (versioned, forward-only), indexes `(occurred_at DESC)`, `(category_id, occurred_at)`, `(merchant_id, occurred_at)` | Migrations apply from zero and from each prior version |
| 1.3 | `db`: repository layer — CRUD, list with filters (date/merchant/category/amount), summary aggregates (by category/merchant/month), unconfirmed rows excluded from totals | Repo tests incl. confirmed/unconfirmed totals; runs against in-memory SQLite in CI |
| 1.4 | `db`: soft delete, `rev` bookkeeping, tombstones | Overwrite retains losing revision; tested |
| 1.5 | Merchant canonicalization + alias table (`SQ *BLUE BOTTLE` → `Blue Bottle Coffee`) as pure functions | Fixture list of real-world merchant strings passes |

Exit: `packages/db` test suite is the executable spec of the ledger.

## Phase 2 — Mobile shell + manual capture (first usable app)

Goal: a daily-driver for typed entry. This is the earliest dogfood point — use it.

| # | Task | Acceptance |
|---|---|---|
| 2.1 | Expo app: navigation (expo-router), theme, `expo-sqlite` wired to `packages/db`, migrations on launch | Fresh install → empty ledger; relaunch persists |
| 2.2 | Manual capture screen: amount-first entry, category/merchant pickers with create-inline | New transaction in ≤ 4 taps + amount |
| 2.3 | Transaction list: FlashList virtualized, day grouping, month header totals | 10k-row seeded DB scrolls at 60 fps on mid-range Android |
| 2.4 | Summary screen: by-category and by-month from repo aggregates | Matches repo test fixtures |
| 2.5 | Edit/delete/confirm flows | Soft delete + tombstone visible in DB tests |
| 2.6 | Perf harness: cold-start and query timing captured in dev builds | Budgets (below) measured, numbers in milestone report |

Exit: team member tracks a real week of spending with it.

## Phase 3 — Photo capture (OCR path)

Goal: photograph a receipt, see the total instantly, confirm, done.

| # | Task | Acceptance |
|---|---|---|
| 3.1 | Camera + document storage: capture, downscale, save to app storage, `documents` row linked by `capture_id` | Photo persists; visible from transaction detail |
| 3.2 | On-device OCR adapter: iOS Vision / ML Kit behind one interface in `packages/extract` | Adapter contract tests with recorded OCR output fixtures |
| 3.3 | Tier 2 heuristics in `packages/extract` (pure TS): total, date, merchant, tax, card last-4 from OCR text | Fixture corpus (local, gitignored, per extraction.md) hit-rates tracked; regressions fail CI |
| 3.4 | Confirm screen: candidate fields editable, confidence-flagged, provisional total shown < 500 ms after shutter | Timed on device; unconfirmed row until user confirms |
| 3.5 | Auto-crop + user crop-adjust (UX quality now, not security — but keep the redaction masking of detected PANs/account numbers: it feeds the Phase 9 opt-in cloud path) | Crop UI ships; masking unit-tested |

Exit: receipt → confirmed transaction in under 10 s of user time.

## Phase 4 — Backup, restore, export (`packages/crypto`, `packages/backup`)

Goal: durability. Highest-stakes phase — this is the code where a bug loses data.

| # | Task | Acceptance |
|---|---|---|
| 4.1 | `crypto`: Argon2id → HKDF → KEK; BMK generation; wrap/unwrap (XChaCha20-Poly1305); **published test vectors** run on mobile and web CI | Cross-platform vector suite green |
| 4.2 | Recovery key: generate, render as key-file + QR, verify-before-continue flow; BMK wrapped by both KEK and recovery key | Restore succeeds with either secret; tested |
| 4.3 | `backup`: archive format v1 — `VACUUM INTO` snapshot + documents, framed for streaming, encrypted | Byte-level format test; corrupt-archive detection test |
| 4.4 | Restore + **merge-on-import**: match by `capture_id`, LWW by `updated_at`, tombstones for losers | Property-based merge tests: A∪B == B∪A on divergent edits |
| 4.5 | Auto-backup: on app background/exit + `expo-background-task` best-effort schedule; retention (keep last N) | Backgrounding writes a valid restorable archive |
| 4.6 | Export CSV + PDF report with plaintext warning | Exports open in Excel / PDF reader; warning shown |

Review gate is stricter here: `/code-review high` minimum over crypto/backup diffs,
plus a restore-from-every-prior-format-version test that never gets deleted.

Exit: wipe a device, restore from backup, byte-identical ledger.

## Phase 5 — Google Drive connector (mobile)

Goal: backups leave the device, encrypted, automatically.

| # | Task | Acceptance |
|---|---|---|
| 5.1 | OAuth (`drive.appdata` scope only), token storage in SecureStore | Consent screen shows narrowest scope |
| 5.2 | Upload/list/prune backups in appDataFolder; resumable upload | Airplane-mode interruption resumes |
| 5.3 | Enable-backup flow = the recovery-key ceremony (ADR 0011 §6), with loud lost-both-secrets warning | Cannot enable without confirming recovery key saved |
| 5.4 | Restore-from-Drive on fresh install | Fresh install → Drive → full ledger |
| 5.5 | Backup-health nudges: badge when no recent backup / not configured | Nudge fires per ADR 0011 "protects user from themselves" |

Exit: **mobile is established.** New phone → sign into Drive → everything back.

## Phase 6 — Web app (`apps/web`)

Goal: browser session hydrated from a backup, fast.

| # | Task | Acceptance |
|---|---|---|
| 6.1 | Vite SPA scaffold; SQLite WASM + OPFS in a Web Worker; Comlink-style message layer to `packages/db` | Repo suite passes against WASM build in CI (headless) |
| 6.2 | Backup import: file picker + drag-drop; streaming decrypt → OPFS; File System Access API handle-remembering on Chromium, picker fallback elsewhere | 50 MB archive imports without main-thread jank |
| 6.3 | Drive connector (web OAuth) — same appDataFolder, read + write | Round-trip: mobile backup → web edit → web backup → mobile merge |
| 6.4 | Views: list, summaries, manual entry, edit/confirm — shared logic from packages, web UI | Feature parity with Phase 2 mobile screens |
| 6.5 | Export CSV/PDF from browser | Same outputs as mobile |
| 6.6 | Bundle integrity: strict CSP, SRI, zero third-party scripts, bundle-size budget in CI | CSP violations fail CI; budget enforced |

Exit: cross-device story works end-to-end through Drive with no server of ours.

Work knowingly left undone inside closed phases is listed in
[deferred.md](deferred.md), with what would unblock each item.

## Phase 7 — Statements (Tier 0 CSV + Tier 1 PDF)

| # | Task | Acceptance |
|---|---|---|
| 7.1 | CSV import with column-mapping UI, dedupe against existing rows by amount+date+merchant fuzz | Re-importing same file creates zero duplicates |
| 7.2 | PDF text-layer extraction (on-device / in-browser) | Text layer read without cloud |
| 7.3 | Per-bank rule sets, versioned, one fixture PDF each (gitignored corpus) | Each rule set has a fixture test |
| 7.4 | Bulk confirm UI for imported rows | 50-row statement confirmed in one screen |

## Phase 8 — Voice capture

| # | Task | Acceptance |
|---|---|---|
| 8.1 | `whisper.rn` (whisper.cpp) integration, quantized small model, on-demand only | Voice note transcribed on-device, airplane mode |
| 8.2 | Transcript → Tier 3 route (Phase 9) with Tier 2-style regex fallback ("$12 coffee at Blue Bottle") for MVP | Fallback parses the fixture utterance set |

## Phase 9 — Tier 3 LLM structuring

| # | Task | Acceptance |
|---|---|---|
| 9.1 | OS-model adapters: Apple Foundation Models / Gemini Nano behind one `packages/extract` interface with structured-output schema | Same fixture suite scores both adapters |
| 9.2 | Line-item extraction prompt + schema validation; confidence surfaced per field | Sum-of-line-items reconciliation flag works |
| 9.3 | Opt-in cloud assist: per-capture consent UI, redacted text only, user-supplied API key first (proxy service deferred until demand) | No network call without explicit per-capture tap; tested at adapter layer |
| 9.4 | Device-capability gating: no OS model → Tiers 0–2 + opt-in path only | Graceful on old devices |

## Phase 10 — Hardening + release

Perf audit against all budgets · failure-injection on backup/restore (kill mid-write,
corrupt archive, downgrade attempt) · accessibility pass · store metadata + privacy
labels (the easiest privacy label ever written) · beta → release.

## After Phase 10

Phases 11–18 — safe release builds, real-device numbers, real-receipt accuracy,
mobile gaps, Drive, Play, iOS and web polish — are in
[next-steps.md](next-steps.md).

---

## Blazing fast: performance budgets

Local-first *is* the performance strategy — no request leaves the device on any hot
path. The budgets keep it honest; Phase 2.6's harness measures them from the start,
because retrofitting speed later never works.

| Metric | Budget | How |
|---|---|---|
| Cold start → interactive ledger | < 1.5 s (mid-range Android) | Hermes + New Architecture; open SQLite and paint first list page before anything else; lazy-load every non-home screen |
| Warm start | < 400 ms | Nothing to fetch; render from SQLite directly |
| Shutter → provisional total | < 500 ms | Vision/ML Kit OCR is 100–300 ms; heuristics are pure TS on a small string |
| List scroll, 10k rows | 60 fps | FlashList virtualization; query pages of 50 by `(occurred_at DESC)` index; never load-all |
| Summary screens | < 50 ms query | SQLite aggregates over indexed columns; if ever slow, add a monthly-rollup table maintained on write — not caching layers |
| Backup write | < 2 s typical ledger | `VACUUM INTO` is ms at this scale; documents copied incrementally; runs off the UI thread |
| Web: 50 MB backup import | no jank, < 15 s | Streaming decrypt in a Worker straight into OPFS; main thread only gets progress events |
| Web first paint after import | < 1 s | OPFS-cached DB from the previous session; import only on first visit or newer-backup detection |
| Web bundle | < 300 KB gz initial | Code-split WASM + OCR behind capture routes; SQLite WASM loaded by the worker, not the main bundle |

Principles behind every row: the network is never on a hot path; the UI thread never
does I/O, crypto, or OCR (workers/native threads do); the `occurred_at DESC` index
serves the screen users actually live on; and measure on cheap hardware, because a
flagship hides every regression.

## Milestone reports

One per phase in `docs/milestones/NNNN-phase-name.md`, from the
[template](milestones/TEMPLATE.md): tasks with commit hashes, test evidence, perf
numbers where budgeted, review findings and their resolutions, deviations from this
plan, risks carried forward. The report is written by whoever closes the phase and
is the input for re-planning the next one — this plan is expected to change; the
reports are how it changes honestly.
