# ADR 0003 — React Native + Expo for mobile

**Status**: accepted · 2026-08-28

## Context

iOS and Android from one codebase, alongside a web app. Flutter and React Native were
both viable. Flutter has the stronger story on UI: Material 3 out of the box, a single
rendering engine, and pixel-identical output across platforms, where React Native
needs more third-party assembly. On REST performance the two are indistinguishable —
the network dominates, and React Native's New Architecture (JSI/TurboModules) closed
most of the remaining CPU gap. Both have solid ML Kit bindings and mature libsodium
access.

## Decision

React Native with Expo.

## Rationale

E2EE requires byte-identical crypto on mobile and web. With Flutter that means one
Dart implementation and one TypeScript implementation of key derivation, wrapping, and
AEAD — two implementations of the code where a bug does not throw an error but instead
produces permanently unreadable user data. With React Native, `packages/crypto` is
written once in TypeScript and consumed by both clients.

That outweighs Flutter's UI advantage. The riskiest, least-recoverable part of this
system is the crypto, and halving its audit surface is worth accepting a less polished
component library.

Expo additionally gives `expo-secure-store` over Keychain/Keystore, OTA updates, and
a routing model close enough to the web app's that navigation concepts transfer.

## Consequences

More UI work than Flutter: component choices to make and maintain, and more effort to
keep iOS and Android visually consistent. Some native modules require config plugins
or a development build. In exchange, one crypto package, one schema package, and one
set of validation rules serve all three clients.

Revisit only if mobile UI quality becomes the binding constraint on the product, and
only with a plan for cross-language crypto test vectors.

## Amendment — 2026-08-28

ADR 0006 shrank the shared-crypto argument that this decision rested on. With a
server-readable ledger, the only crypto shared between mobile and web is document
encryption and key wrapping — a much smaller surface than the original design's
whole-ledger encryption.

The decision stands, on weaker grounds. That surface is still the code where a
cross-client mismatch produces unreadable data rather than a visible error, and
sharing `packages/schema` and validation across three clients is worth real time on
its own. But if mobile UI quality becomes the binding constraint, Flutter is now a
much more reasonable reconsideration than it was.
