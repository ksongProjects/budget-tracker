# budget-tracker

Mobile-first budget and spending tracker with a web companion. Capture spending in
seconds — photograph a receipt, upload a bank statement, speak it, or type it — and
have it land as structured, categorized transaction data.

## Status

Architecture is **local-first** ([ADR 0011](docs/adr/0011-local-first.md));
implementation runs per the [implementation plan](docs/implementation-plan.md).

Phases 0–6 are done: the mobile app captures, stores and backs up; archives are
encrypted, restorable and uploadable; the web app opens a phone's backup and
reads, edits and exports the ledger. Phase 7 (bank statements) is in progress.
Work knowingly left undone is listed in [docs/deferred.md](docs/deferred.md) —
most notably that nothing has yet talked to Google or run on iOS.

To run any of it, see [docs/running-locally.md](docs/running-locally.md).

## Shape

- **Local-first** — the device is the system of record. Local SQLite ledger, no
  server, no accounts. Nothing leaves the device in readable form.
- **Mobile** — React Native + Expo (iOS + Android), built first
- **Web** — Vite + React SPA; hydrates from backup files (SQLite WASM + OPFS)
- **Backups** — encrypted single-file archives; Google Drive appDataFolder
  connector; recovery key minted at backup setup
- **Extraction** — on-device: Vision/ML Kit OCR, whisper.cpp, OS-provided LLMs,
  with per-capture opt-in cloud assist (text only, never pixels)

## Read next

| Doc | What it settles |
|---|---|
| [docs/adr/0011-local-first.md](docs/adr/0011-local-first.md) | The architecture — read first |
| [docs/implementation-plan.md](docs/implementation-plan.md) | Phases, tasks, budgets, milestone process |
| [docs/running-locally.md](docs/running-locally.md) | Running the apps and the checks yourself |
| [docs/deferred.md](docs/deferred.md) | Work left undone, why, and what unblocks it |
| [CONTEXT.md](CONTEXT.md) | Domain vocabulary — read before writing code |
| [docs/data-model.md](docs/data-model.md) | Local SQLite schema and the merge rules |
| [docs/crypto-design.md](docs/crypto-design.md) | Key hierarchy, recovery, what leaks |
| [docs/backup-format.md](docs/backup-format.md) | The archive format |
| [docs/drive-connector.md](docs/drive-connector.md) | Google Drive transport |
| [docs/extraction.md](docs/extraction.md) | How photos/PDFs/audio become transactions |
| [docs/adr/](docs/adr/) | Why each choice, and what we gave up. Superseded ADRs are kept — they record designs and why each was traded away. |
