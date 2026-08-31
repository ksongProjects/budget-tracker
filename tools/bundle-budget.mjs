#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

/**
 * What the web bundle is allowed to weigh, and what it is allowed to fetch.
 *
 * Both are promises the app makes rather than preferences: a page holding
 * someone's spending should ship no third-party code, and a local-first app
 * that takes ten seconds to load is not local-first in any way the user
 * experiences. Enforced in CI so the day it stops being true is the day it is
 * noticed, rather than a release later.
 */

const DIST = 'apps/web/dist';

const BUDGETS = {
  /**
   * What every visit pays: the entry chunk and the worker that opens the
   * database. Kept small deliberately — this is the number a user feels.
   */
  eagerScriptGzipBytes: 120 * 1024,
  /**
   * Code fetched only when a particular thing is done, and never otherwise.
   *
   * Two dependencies account for nearly all of it, both by choice: libsodium
   * (~183 KB) for opening a backup, and pdf.js (~594 KB, mostly its worker) for
   * reading a statement's text layer. The alternative to the second is sending
   * the PDF somewhere to be read, which this app does not do.
   */
  lazyScriptGzipBytes: 850 * 1024,
  /** SQLite itself, which dominates and earns its weight. */
  wasmGzipBytes: 450 * 1024,
};

const failures = [];
const html = readFileSync(join(DIST, 'index.html'), 'utf8');

// Third-party code is the thing being ruled out, and a CDN link in the HTML is
// how it would arrive.
for (const match of html.matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+)"/g)) {
  const url = match[1];
  if (/^https?:|^\/\//.test(url)) {
    failures.push(`index.html loads ${url} from another origin`);
  }
}

if (!/Content-Security-Policy/i.test(html)) {
  failures.push('index.html ships without a Content-Security-Policy');
}

const lazy = lazyChunks();

let eagerGzip = 0;
let lazyGzip = 0;
let wasmGzip = 0;

for (const name of walk(DIST)) {
  const gzipped = gzipSync(readFileSync(name)).length;

  // `.mjs` counts as JavaScript. It did not, once, and pdf.js's 2 MB worker
  // ships with that extension — so the budget was measuring around the largest
  // thing in the bundle.
  if (name.endsWith('.js') || name.endsWith('.mjs')) {
    if (lazy.has(posix(name))) lazyGzip += gzipped;
    else eagerGzip += gzipped;
  }
  if (name.endsWith('.wasm')) wasmGzip += gzipped;
}

report('JavaScript on every visit', eagerGzip, BUDGETS.eagerScriptGzipBytes);
report('JavaScript loaded on demand', lazyGzip, BUDGETS.lazyScriptGzipBytes);
report('WebAssembly', wasmGzip, BUDGETS.wasmGzipBytes);

if (failures.length > 0) {
  console.error('bundle budget failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('bundle budget met');

/**
 * Chunks reachable only through a dynamic import.
 *
 * Read from Vite's manifest rather than guessed at from filenames: the point of
 * the eager budget is that it cannot be met by renaming something.
 */
function lazyChunks() {
  const manifest = JSON.parse(readFileSync(join(DIST, '.vite', 'manifest.json'), 'utf8'));
  const eager = new Set();

  const walkEager = (key) => {
    const entry = manifest[key];
    if (entry === undefined || eager.has(key)) return;
    eager.add(key);
    for (const imported of entry.imports ?? []) walkEager(imported);
  };

  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.isEntry) walkEager(key);
  }

  const lazy = new Set();
  for (const [key, entry] of Object.entries(manifest)) {
    if (!eager.has(key)) lazy.add(`${DIST}/${entry.file}`);
  }

  return lazy;
}

function report(what, actual, budget) {
  const line = `${what}: ${kb(actual)} of ${kb(budget)} gzipped`;
  if (actual > budget) failures.push(line);
  else console.log(`  ${line}`);
}

/** Manifest paths use forward slashes; the filesystem here may not. */
function posix(path) {
  return path.split('\\').join('/');
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}
