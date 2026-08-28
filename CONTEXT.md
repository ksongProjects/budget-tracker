# CONTEXT

Shared vocabulary for budget-tracker. Use these words exactly in code, schemas, and
docs. If a concept is not here, it is not yet real.

## Core nouns

**Capture** — one act of the user recording spending. Four kinds: `photo`
(receipt), `statement` (bank PDF/CSV), `voice` (audio), `manual` (typed). A Capture
is the user-facing unit: "I captured lunch."

**Document** — the raw artifact behind a Capture: the receipt image, the statement
PDF, the audio file. Stored as an encrypted blob in object storage. The server never
holds the plaintext of a Document.

**Extraction** — the process turning a Document into candidate structured data, and
also the record of that process. An Extraction records which *tier* produced the
result (see `docs/extraction.md`) and its confidence. Extractions are auditable: for
money data, we always know whether a number came from a regex or a model.

**Transaction** — one settled spend: amount, currency, occurred-at, merchant,
category, account. The ledger row. Produced by an Extraction or entered manually.

**LineItem** — one row within a Transaction: item name, quantity, unit price, total.
Optional — a Transaction is valid with only a total. Tax and fees are LineItems with
`kind` of `tax` / `fee`, not special columns.

**Ledger** — the user's full set of Transactions. Because it is encrypted, the
Ledger is assembled and queried **on the client**. There is no server-side ledger
query.

## Crypto nouns

**KEK** — key-encryption key, derived from the user's passphrase via Argon2id. Never
transmitted.

**MK** — master key, random, generated once per user. Wrapped by the KEK, by the
recovery key, and optionally by a device key. The wrapped forms live server-side.

**DEK** — data-encryption key, random and per-object (per Document, per Transaction).
Wrapped by the MK. Rotating a passphrase rewraps the MK only, never the DEKs.

**Cloud Assist** — explicit, per-Document user consent to send *redacted extracted
text* (never pixels, never audio) to the server for LLM structuring. Off by default.
Every grant is logged as a ConsentEvent.

**Posture** — which privacy mode a given Capture ran under: `on_device` (default) or
`cloud_assist`. Stored on the Extraction so the user can always see what left their
phone.

## Verbs

**capture** → user records spending. **extract** → Document becomes candidate data.
**confirm** → user accepts or edits candidate data, creating a Transaction. **sync**
→ client pushes/pulls ciphertext rows.

Nothing becomes a Transaction without a confirm. Extraction proposes; the user
disposes.

## Non-goals (for now)

Bank API / Plaid-style direct connections. Multi-user shared budgets. Investment
tracking. Bill prediction. Each would reopen the privacy design.
