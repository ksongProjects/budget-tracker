/**
 * @budget/extract — the tiered pipeline that turns captures into candidate
 * transactions, on device. See docs/extraction.md.
 *
 * Engines live behind the interfaces in types.ts; everything here is pure
 * TypeScript so the rules are testable in CI without a device.
 */
export * from './types.js';
export * from './receipt.js';
export * from './redact.js';
export * from './statement/csv.js';
export * from './statement/layout.js';
export * from './statement/rows.js';
export * from './statement/dedupe.js';
export * from './statement/rules.js';
export * from './voice/wav.js';
export * from './voice/utterance.js';
export * from './voice/utterances.js';
