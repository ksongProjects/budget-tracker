# budget-tracker

Mobile-first budget and spending tracker with a web companion. Capture spending in
seconds — photograph a receipt, upload a bank statement, speak it, or type it — and
have it land as structured, categorized transaction data.

## Status

Design phase. No code yet. Architecture decisions live in [`docs/adr/`](docs/adr/).

## Shape

- **Mobile** — React Native + Expo (iOS + Android)
- **Web** — Vite + React SPA
- **Server** — FastAPI + Postgres + object storage + Redis queue
- **Extractor** — separate microservice: OCR, PDF rules, speech-to-text, LLM structuring
- **Privacy** — split trust. Receipt images, statement PDFs, and audio are end-to-end
  encrypted and unreadable by the server. Transaction data is encrypted in transit and
  at rest, and is processed and queried on our servers. Cropping on-device is what
  keeps account numbers out of the server-readable path.

## Read next

| Doc | What it settles |
|---|---|
| [CONTEXT.md](CONTEXT.md) | Domain vocabulary — read before writing code |
| [docs/crypto-design.md](docs/crypto-design.md) | Key hierarchy, recovery, what leaks |
| [docs/extraction.md](docs/extraction.md) | How photos/PDFs/audio become transactions |
| [docs/api.md](docs/api.md) | REST surface |
| [docs/data-model.md](docs/data-model.md) | Postgres schema and what is plaintext |
| [docs/adr/](docs/adr/) | Why each choice, and what we gave up. 0001 and 0002 are superseded but kept — they record the full-E2EE design and why it was traded away. |
