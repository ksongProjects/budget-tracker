import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDriver } from '@budget/db';

/**
 * The storage a test "device" has: named databases and a keystore.
 *
 * Databases are kept by name so that a second opener of `budget.db` — the
 * backup service, the scratch ledger's cleanup — sees the same rows the
 * screen wrote, as it would on a phone. `resetDevice` is a fresh install.
 */

const databases = new Map<string, SqliteDriver>();

export const secureStore = new Map<string, string>();

type CreateDriver = (options?: { readonly path?: string }) => SqliteDriver;

/**
 * Open a database the way expo-sqlite would. By name alone it is the app's own
 * (shared, in memory); with a directory it is a file in the sandbox — a
 * restored snapshot — loaded from the bytes the app wrote there.
 */
export function openDatabase(name: string, create: CreateDriver, directory?: string): SqliteDriver {
  if (directory !== undefined) {
    const uri = `file://${directory.endsWith('/') ? directory : `${directory}/`}${name}`;
    const bytes = files.get(uri)?.bytes;
    if (bytes === undefined) throw new Error(`unable to open database: ${uri}`);
    const real = realTempFile();
    writeFileSync(real, bytes);
    const driver = create({ path: real });
    return {
      ...driver,
      close: async () => {
        await driver.close();
        rmSync(real, { force: true });
      },
    };
  }

  let driver = databases.get(name);
  if (driver === undefined) {
    driver = shared(create());
    databases.set(name, driver);
  }
  return driver;
}

export function deleteDatabase(name: string): void {
  databases.delete(name);
}

let temporaries = 0;
function realTempFile(): string {
  temporaries += 1;
  return join(tmpdir(), `txns-test-${String(process.pid)}-${String(temporaries)}.db`);
}

/**
 * A shared connection: closing is a no-op, because it outlives any one opener.
 * `VACUUM INTO` a sandbox path goes through a real file — SQLite can only write
 * to a disk — and lands in the sandbox as bytes, where the backup reads it.
 */
function shared(driver: SqliteDriver): SqliteDriver {
  return {
    ...driver,
    async exec(sql) {
      const vacuum = /^VACUUM INTO '(.+)'$/.exec(sql.trim());
      if (vacuum?.[1] === undefined) return driver.exec(sql);
      const real = realTempFile();
      await driver.exec(`VACUUM INTO '${real.replace(/'/g, "''")}'`);
      putFile(`file://${vacuum[1]}`, readFileSync(real));
      rmSync(real, { force: true });
    },
    close: () => Promise.resolve(),
  };
}

// --- The system file picker ---------------------------------------------

type Picked =
  | { readonly canceled: true; readonly assets: null }
  | {
      readonly canceled: false;
      readonly assets: { uri: string; name: string; mimeType: string; size: number }[];
    };

let picked: Picked = { canceled: true, assets: null };

/**
 * The file the user will choose next. It is copied into the cache, as
 * `copyToCacheDirectory` does, and the picker hands back that copy.
 */
export function pickFile(name: string, mimeType: string, contents: Buffer | string): void {
  const uri = `${CACHE}DocumentPicker/${name}`;
  putFile(uri, contents);
  picked = {
    canceled: false,
    assets: [{ uri, name, mimeType, size: Buffer.byteLength(contents) }],
  };
}

export function takePicked(): Picked {
  const next = picked;
  picked = { canceled: true, assets: null };
  return next;
}

// --- ML Kit, replaying what it read --------------------------------------

interface Frame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
interface MlKitLine {
  readonly text: string;
  readonly frame: Frame;
}

let ocrLines: readonly MlKitLine[] = [];

/** What ML Kit will read from the next image, as [text, left, top, width] rows. */
export function ocrWillRead(lines: readonly (readonly [string, number, number, number])[]): void {
  ocrLines = lines.map(([text, left, top, width]) => ({
    text,
    frame: { left, top, width, height: 28 },
  }));
}

export const mlKit = {
  recognize: () =>
    Promise.resolve({
      text: ocrLines.map((line) => line.text).join('\n'),
      blocks: [{ text: '', lines: ocrLines.map((line) => ({ ...line, elements: [] })) }],
    }),
};

export function resetDevice(): void {
  picked = { canceled: true, assets: null };
  ocrLines = [];
  databases.clear();
  secureStore.clear();
  files.clear();
  directories.clear();
  for (const root of [DOCUMENTS, CACHE]) directories.add(root);
}

// --- The app's sandbox: expo-file-system/legacy over a map ---------------

export const DOCUMENTS = 'file:///data/user/0/com.ksongprojects.txns/files/';
export const CACHE = 'file:///data/user/0/com.ksongprojects.txns/cache/';

const files = new Map<string, { bytes: Buffer; modified: number }>();
const directories = new Set<string>([DOCUMENTS, CACHE]);

const asDirectory = (path: string): string => (path.endsWith('/') ? path : `${path}/`);

function missing(path: string): Error {
  return new Error(`File '${path}' could not be found`);
}

/** Put a file on the device, as if the user had downloaded or shared it. */
export function putFile(path: string, contents: Buffer | string): void {
  files.set(path, { bytes: Buffer.from(contents), modified: Date.now() / 1000 });
}

export function readFile(path: string): Buffer | undefined {
  return files.get(path)?.bytes;
}

export function listFiles(prefix: string): string[] {
  return [...files.keys()].filter((path) => path.startsWith(prefix)).sort();
}

type Encoding = 'utf8' | 'base64';
interface EncodingOption {
  readonly encoding?: Encoding;
}

export const fileSystem = {
  documentDirectory: DOCUMENTS,
  cacheDirectory: CACHE,
  EncodingType: { UTF8: 'utf8', Base64: 'base64' } as const,

  getInfoAsync(path: string) {
    const file = files.get(path);
    if (file !== undefined) {
      return Promise.resolve({
        exists: true,
        isDirectory: false,
        uri: path,
        size: file.bytes.length,
        modificationTime: file.modified,
      });
    }
    if (directories.has(asDirectory(path))) {
      return Promise.resolve({ exists: true, isDirectory: true, uri: path, size: 0, modificationTime: 0 });
    }
    return Promise.resolve({ exists: false, isDirectory: false, uri: path });
  },

  makeDirectoryAsync(path: string) {
    directories.add(asDirectory(path));
    return Promise.resolve();
  },

  readDirectoryAsync(path: string) {
    const directory = asDirectory(path);
    if (!directories.has(directory)) return Promise.reject(missing(path));
    const children = new Set<string>();
    for (const entry of [...files.keys(), ...directories]) {
      if (entry === directory || !entry.startsWith(directory)) continue;
      const name = entry.slice(directory.length).split('/')[0];
      if (name) children.add(name);
    }
    return Promise.resolve([...children].sort());
  },

  readAsStringAsync(path: string, options: EncodingOption = {}) {
    const file = files.get(path);
    if (file === undefined) return Promise.reject(missing(path));
    return Promise.resolve(file.bytes.toString(options.encoding ?? 'utf8'));
  },

  writeAsStringAsync(path: string, contents: string, options: EncodingOption = {}) {
    files.set(path, {
      bytes: Buffer.from(contents, options.encoding ?? 'utf8'),
      modified: Date.now() / 1000,
    });
    return Promise.resolve();
  },

  deleteAsync(path: string, options: { readonly idempotent?: boolean } = {}) {
    const directory = asDirectory(path);
    const existed = files.delete(path) || directories.has(directory);
    for (const entry of [...files.keys()]) if (entry.startsWith(directory)) files.delete(entry);
    for (const entry of [...directories]) if (entry.startsWith(directory)) directories.delete(entry);
    if (!existed && options.idempotent !== true) return Promise.reject(missing(path));
    return Promise.resolve();
  },

  moveAsync({ from, to }: { readonly from: string; readonly to: string }) {
    const file = files.get(from);
    if (file === undefined) return Promise.reject(missing(from));
    files.delete(from);
    files.set(to, file);
    return Promise.resolve();
  },

  copyAsync({ from, to }: { readonly from: string; readonly to: string }) {
    const file = files.get(from);
    if (file === undefined) return Promise.reject(missing(from));
    files.set(to, { ...file });
    return Promise.resolve();
  },

  createDownloadResumable() {
    throw new Error('no network in a screen test');
  },
};

