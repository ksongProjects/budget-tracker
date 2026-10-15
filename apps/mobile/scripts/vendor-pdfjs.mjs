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

console.log(`pdf.js copied to ${path.relative(process.cwd(), out)}`);
