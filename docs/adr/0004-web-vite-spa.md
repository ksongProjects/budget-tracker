# ADR 0004 — Vite SPA for web, not Next.js

**Status**: accepted · 2026-08-28

## Context

Next.js is the default reach for a React web app. Its main advantages are server-side
rendering, server components, image optimization, and API routes.

## Decision

Vite + React, as a client-rendered SPA.

## Rationale

Under ADR 0001 the server cannot decrypt user data, so it cannot server-render any of
it. Every authenticated screen must render after the client unlocks the MK and
decrypts locally. SSR and server components have nothing to act on. Next.js API routes
are also redundant — the API is a separate FastAPI service, and adding a BFF hop would
only put another process near data we are trying to keep no process near.

What remains is routing and bundling, which Vite does with less machinery, faster dev
startup, and a smaller mental model. "Lightweight" was an explicit requirement.

## Consequences

No SEO and no SSR — irrelevant for a private ledger behind a login. If public
marketing pages are wanted later, host them separately as static or Next pages; do not
retrofit the app shell to gain them.

Client-side rendering means the unlock step is visible: the user logs in, derives the
KEK, and the ledger populates. Design for that explicitly rather than hiding it — it
is a truthful signal that decryption is happening locally.

## Amendment — 2026-08-28

The original rationale was that the server could not render encrypted data. ADR 0006
made the ledger server-readable, so that argument is gone — Next.js could now
server-render dashboards and transaction lists perfectly well.

Sticking with Vite regardless, on the remaining grounds: the API is a separate FastAPI
service, so Next's server layer would be a redundant hop, and "lightweight" was an
explicit requirement. This is now a preference rather than a constraint, and it is a
cheap decision to revisit before the web app has screens.
