/* global console, process */
// Copies pdf.js into the app's assets, as text, for the PDF reader's WebView.
//
// The reader cannot fetch pdf.js from anywhere — a statement is not something
// to load a script from a CDN next to, and the reader must work offline — so
// the two built files travel inside the app. They are copied with a `.txt`
// extension so Metro ships them as assets to be read as text, rather than
// trying to bundle a browser library into Hermes.
//
// Generated, not committed: run on install, so the copy always matches the
// pdfjs-dist version in the lockfile.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const build = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'build');
const out = path.join(here, '..', 'assets', 'pdfjs');

mkdirSync(out, { recursive: true });
copyFileSync(path.join(build, 'pdf.min.mjs'), path.join(out, 'pdf.min.mjs.txt'));
copyFileSync(path.join(build, 'pdf.worker.min.mjs'), path.join(out, 'pdf.worker.min.mjs.txt'));

// The decoders for the image formats scanners favour — CCITT fax and JBIG2
// for black and white, JPEG 2000 for colour. pdf.js would fetch these from a
// URL; the reader hands it the bytes instead. `.txt` only so Metro ships them:
// they are read back as base64, never as text.
const wasm = path.join(path.dirname(build), 'wasm');
copyFileSync(path.join(wasm, 'jbig2.wasm'), path.join(out, 'jbig2.wasm.txt'));
copyFileSync(path.join(wasm, 'openjpeg.wasm'), path.join(out, 'openjpeg.wasm.txt'));

console.log(`pdf.js copied to ${path.relative(process.cwd(), out)}`);
