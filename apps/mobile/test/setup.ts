import { beforeEach, jest } from '@jest/globals';
import type * as Device from './device';
import type * as NodeDriver from '@budget/db/drivers/node';
import type * as Libsodium from '@budget/crypto/libsodium';
import type * as ReactNative from 'react-native';
import type * as NodeCrypto from 'node:crypto';

/**
 * Stand-ins for what only exists on a device. Each keeps the contract the app
 * relies on, so a screen test exercises the same code path it does on a phone:
 * a SQLite ledger that really stores and queries, a keystore that really keeps
 * what is put in it, and the same libsodium the backup format is tested with.
 */

// expo-sqlite → node:sqlite. Every opener gets its own in-memory database,
// reset between tests by `resetDevice` below.
jest.mock('../src/db/driver', () => {
  const { createNodeDriver } = jest.requireActual<typeof NodeDriver>(
    '@budget/db/drivers/node',
  );
  const device = jest.requireActual<typeof Device>('./device');
  return {
    DATABASE_NAME: 'budget.db',
    createExpoDriver: (name = 'budget.db', options: { directory?: string } = {}) =>
      Promise.resolve(device.openDatabase(name, createNodeDriver, options.directory)),
    deleteExpoDatabase: (name: string) => {
      device.deleteDatabase(name);
      return Promise.resolve();
    },
    expoScratchStorage: {
      open: (name: string) => Promise.resolve(device.openDatabase(name, createNodeDriver)),
      remove: (name: string) => {
        device.deleteDatabase(name);
        return Promise.resolve();
      },
    },
  };
});

// Native libsodium → the WASM build. Same library, same primitives.
jest.mock('../src/crypto/backend', () => ({
  createNativeSodiumBackend: () =>
    jest
      .requireActual<typeof Libsodium>('@budget/crypto/libsodium')
      .createLibsodiumBackend(),
}));

// The OS keystore → a map that lives as long as the "install" does.
jest.mock('expo-secure-store', () => {
  const device = jest.requireActual<typeof Device>('./device');
  return {
    getItemAsync: (key: string) => Promise.resolve(device.secureStore.get(key) ?? null),
    setItemAsync: (key: string, value: string) => {
      device.secureStore.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key: string) => {
      device.secureStore.delete(key);
      return Promise.resolve();
    },
    AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    WHEN_UNLOCKED: 'WHEN_UNLOCKED',
  };
});

// The app's sandbox, in memory. Files written by one screen are there for the
// next, and gone after the test.
jest.mock('expo-file-system/legacy', () =>
  jest.requireActual<typeof Device>('./device').fileSystem,
);

// The system file picker: whatever the test last handed to `pickFile`.
jest.mock('expo-document-picker', () => {
  const device = jest.requireActual<typeof Device>('./device');
  return { getDocumentAsync: () => Promise.resolve(device.takePicked()) };
});

// The background schedule is the OS's; a screen test only needs it not to fail.
jest.mock('expo-background-task', () => ({
  registerTaskAsync: () => Promise.resolve(),
  unregisterTaskAsync: () => Promise.resolve(),
  getStatusAsync: () => Promise.resolve(2),
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));
jest.mock('expo-task-manager', () => ({
  defineTask: () => undefined,
  isTaskRegisteredAsync: () => Promise.resolve(false),
}));

// ML Kit replays what the test says it read (`ocrWillRead`), through the app's
// real adapter in src/capture/ocr.ts. Its accuracy is the Maestro flows' job.
jest.mock('@react-native-ml-kit/text-recognition', () => ({
  __esModule: true,
  default: jest.requireActual<typeof Device>('./device').mlKit,
}));

// Downscaling a photo: the bytes pass through unchanged, to a new cache file,
// which is what the app then moves into its documents folder.
jest.mock('expo-image-manipulator', () => {
  const device = jest.requireActual<typeof Device>('./device');
  let saved = 0;
  return {
    SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
    ImageManipulator: {
      manipulate: (uri: string) => ({
        resize: () => undefined,
        renderAsync: () =>
          Promise.resolve({
            saveAsync: () => {
              saved += 1;
              const to = `${device.CACHE}ImageManipulator/${String(saved)}.jpg`;
              device.putFile(to, device.readFile(uri) ?? Buffer.alloc(0));
              return Promise.resolve({ uri: to, width: 1600, height: 2000 });
            },
          }),
      }),
    },
  };
});

jest.mock('expo-crypto', () => {
  const { createHash, randomUUID } = jest.requireActual<typeof NodeCrypto>('node:crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    digestStringAsync: (_algorithm: string, data: string) =>
      Promise.resolve(createHash('sha256').update(data).digest('hex')),
    randomUUID,
  };
});

// Native engines a screen test never reaches. Present so importing a screen
// that offers them does not fail; the Maestro flows exercise the real ones.
jest.mock('whisper.rn/index', () => ({ initWhisper: jest.fn() }));
jest.mock('@fugood/react-native-audio-pcm-stream', () => ({ default: { init: jest.fn() } }));
jest.mock('react-native-libsodium', () => ({ default: {} }));
// The PDF reader's hidden page. Mounted, never loaded: pdf.js is a browser's.
jest.mock('react-native-webview', () => {
  const { View } = jest.requireActual<typeof ReactNative>('react-native');
  return { WebView: View };
});

beforeEach(() => {
  jest.requireActual<typeof Device>('./device').resetDevice();
});
