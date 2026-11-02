/**
 * Screen tests: the real routes, the real layout and a real SQLite ledger,
 * rendered without a device.
 *
 * Only what cannot exist off-device is replaced (test/setup.ts): expo-sqlite
 * becomes node:sqlite behind the same driver contract, native libsodium becomes
 * the WASM build CI already trusts, and the OS keystore becomes a map. Anything
 * that depends on a native engine — ML Kit, Whisper, the PDF WebView — is
 * checked on the emulator by the Maestro flows in e2e/, not here.
 *
 * The logic tests next to the sources (*.test.ts) belong to Vitest at the
 * repository root; this runner only picks up *.test.tsx.
 */
module.exports = {
  preset: 'jest-expo/android',
  testMatch: ['<rootDir>/test/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  // The first render of a file loads every route module under app/. With a
  // warm transform cache that is seconds; on a fresh CI runner, where every
  // worker compiles the whole app at once, it took 70 s and failed at 30.
  testTimeout: 120_000,
  // The workspace packages are ESM, linked in from packages/*/dist; React
  // Native's own packages ship untranspiled Flow. Both need Babel.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@shopify/flash-list|lucide-react-native|react-native-svg|@budget/.*|standard-navigation))',
  ],
  // Some dependencies publish their React Native build as .mjs only.
  transform: { '^.+\\.mjs$': 'babel-jest' },
  moduleNameMapper: { '\\.txt$': '<rootDir>/test/asset-stub.js' },
  collectCoverageFrom: ['app/**/*.tsx', 'src/**/*.tsx', '!**/*.d.ts'],
  coverageReporters: ['text-summary', 'json-summary', 'html'],
  // Floors at what was measured when they were set, rounded down. They only
  // ratchet — see the root vitest.config.ts.
  coverageThreshold: {
    global: { lines: 42, branches: 42, functions: 45, statements: 41 },
  },
};
