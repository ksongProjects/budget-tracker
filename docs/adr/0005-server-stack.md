# ADR 0005 — FastAPI, Postgres, object storage, Redis queue

**Status**: accepted · 2026-08-28

## Context

The server's jobs are narrow by design: authentication, wrapped-key custody,
ciphertext storage and sync, and consented text/audio structuring. It is deliberately
not the extraction engine (ADR 0002).

## Decision

- **FastAPI (Python)** — the consented extraction work (PDF rules, `faster-whisper`,
  LLM orchestration) lives in Python's ecosystem. Async I/O suits a service that is
  mostly waiting on Postgres and object storage.
- **Postgres** — ciphertext rows, wrapped keys, sync cursors, append-only consent log.
- **Object storage (S3 / MinIO)** — encrypted blobs, written by clients through
  presigned URLs so ciphertext never transits an API pod.
- **Redis + arq** — async extraction jobs, kept off the request path.

## Scaling

API pods are stateless and horizontally scalable; they do no heavy lifting, since
image work is on the client and blob transfer bypasses them. Workers scale
independently and only handle consented traffic, which is a fraction of total volume.
Postgres is the one stateful component and, holding opaque blobs with simple
`updated_at` cursor reads, it will not be the bottleneck for a long time.

## On local models

Rejected for now. A local model only pays off if the server is doing bulk inference,
which contradicts ADR 0001 and ADR 0002 — the server's inference load is the consented
minority path. The dev machine is also AMD without CUDA, making local GPU serving
awkward. Cloud LLM (Claude) for Tier 3 text structuring, `faster-whisper` on CPU int8
for the audio fallback.

Revisit if consented volume grows enough that per-call LLM cost dominates, or if a
customer requires no third-party processor at all.
