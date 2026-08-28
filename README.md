# budget-tracker

Mobile-first budget and spending tracker with a web companion. Capture spending in
seconds — photograph a receipt, upload a bank statement, speak it, or type it — and
have it land as structured, categorized, end-to-end-encrypted transaction data.

## Status

Design phase. No code yet. Architecture decisions live in [`docs/adr/`](docs/adr/).

## Shape

- **Mobile** — React Native + Expo (iOS + Android)
- **Web** — Vite + React SPA
- **Server** — FastAPI + Postgres + object storage + Redis queue
- **Privacy** — E2EE by default; server stores ciphertext and cannot read documents
  or transactions. Per-document opt-in "cloud assist" for hard extractions.

## Read next

| Doc | What it settles |
|---|---|
| [CONTEXT.md](CONTEXT.md) | Domain vocabulary — read before writing code |
| [docs/crypto-design.md](docs/crypto-design.md) | Key hierarchy, recovery, what leaks |
| [docs/extraction.md](docs/extraction.md) | How photos/PDFs/audio become transactions |
| [docs/api.md](docs/api.md) | REST surface |
| [docs/data-model.md](docs/data-model.md) | Postgres schema and what is plaintext |
| [docs/adr/](docs/adr/) | Why each choice, and what we gave up |
