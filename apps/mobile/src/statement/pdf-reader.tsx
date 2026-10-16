import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { pageFromOcr } from '@budget/extract';
import type { OcrEngine, PdfDocument, PdfPage } from '@budget/extract';
import { loadOcrEngine } from '../capture/ocr';
import pdfLibrary from '../../assets/pdfjs/pdf.min.mjs.txt';
import pdfWorker from '../../assets/pdfjs/pdf.worker.min.mjs.txt';
import jbig2Decoder from '../../assets/pdfjs/jbig2.wasm.txt';
import openjpegDecoder from '../../assets/pdfjs/openjpeg.wasm.txt';

/**
 * Reading a PDF on the phone: its text layer, or, for a scan, its pictures.
 *
 * The web app reads statements with pdf.js, and a browser engine is exactly
 * what Android already has in its WebView. So this is the same reader, the same
 * library version, run in a WebView the user never sees — producing the same
 * `PdfDocument` the web app's does, which then goes through the same rule sets
 * and the same column layout.
 *
 * A scanned statement has no text layer. Where a page has none, the WebView
 * draws it to a canvas and hands back the picture, ML Kit reads it as it reads
 * a receipt, and `pageFromOcr` turns the words back into page positions. The
 * layout downstream cannot tell the difference, except that it is told the
 * pages were scanned and reads them with a scan's tolerance.
 *
 * Nothing leaves the phone. pdf.js ships inside the app (see
 * scripts/vendor-pdfjs.mjs), the page's content policy allows no network
 * request of any kind, and the PDF arrives as bytes passed in, not as a URL.
 * OCR is on-device, and each page's picture is deleted once it is read.
 */

export const PDF_ENGINE_NAME = 'pdfjs-webview';

/** The engine name when some pages were read by OCR. */
export const SCANNED_PDF_ENGINE_NAME = 'pdfjs-webview+mlkit';

/**
 * How long the WebView may go without progress before it is given up on. Each
 * scanned page drawn restarts the clock, so a long scan is not cut off — only a
 * hang is.
 */
const TIMEOUT_MS = 60_000;

/**
 * Pages drawn for OCR, at most. A statement is a few pages; a hundred-page scan
 * is something else, and drawing it all would hold the screen for minutes.
 */
const MAX_SCANNED_PAGES = 30;

interface Scan {
  readonly number: number;
  /** Pixels in the picture per PDF point. */
  readonly scale: number;
  /** The page as a JPEG, base64. */
  readonly image: string;
}

interface Job {
  readonly id: number;
  readonly script: string;
  readonly scanned: (scan: Scan) => void;
  readonly resolve: (document: PdfDocument) => void;
  readonly reject: (error: Error) => void;
}

type Reply =
  | { readonly ready: true }
  | { readonly id: number; readonly scan: Scan }
  | { readonly id: number; readonly ok: true; readonly document: PdfDocument }
  | { readonly id: number; readonly ok: false; readonly error: string };

interface Library {
  readonly lib: string;
  readonly worker: string;
  /** The image decoders pdf.js needs for scans, base64, by the name it asks for. */
  readonly decoders: Readonly<Record<string, string>>;
}

let library: Promise<Library> | undefined;

/** pdf.js and its decoders, read from the app's own assets once per launch. */
function loadLibrary(): Promise<Library> {
  library ??= (async () => {
    const [lib, worker, jbig2, openjpeg] = await Promise.all([
      readAsset(pdfLibrary),
      readAsset(pdfWorker),
      readAsset(jbig2Decoder, FileSystem.EncodingType.Base64),
      readAsset(openjpegDecoder, FileSystem.EncodingType.Base64),
    ]);
    return { lib, worker, decoders: { 'jbig2.wasm': jbig2, 'openjpeg.wasm': openjpeg } };
  })();

  // A failed load should be retried next time, not remembered.
  library.catch(() => {
    library = undefined;
  });
  return library;
}

async function readAsset(
  module: number,
  encoding: FileSystem.EncodingType = FileSystem.EncodingType.UTF8,
): Promise<string> {
  const asset = Asset.fromModule(module);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  return FileSystem.readAsStringAsync(uri, { encoding });
}

/**
 * A PDF reader, and the invisible WebView it runs in. Render `host` anywhere on
 * the screen that reads PDFs; it mounts only while a file is being read.
 */
export function usePdfReader(): {
  readonly host: ReactNode;
  readonly read: (uri: string) => Promise<PdfDocument>;
} {
  const [job, setJob] = useState<Job | undefined>(undefined);
  const view = useRef<WebView>(null);
  const counter = useRef(0);

  const read = useCallback(async (uri: string): Promise<PdfDocument> => {
    const [{ lib, worker, decoders }, data] = await Promise.all([
      loadLibrary(),
      FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
    ]);

    // Without OCR (Expo Go) a scanned page's picture could not be read, so it
    // is not drawn: the page stays empty and the screen says why.
    const ocr = loadOcrEngine();

    counter.current += 1;
    const id = counter.current;
    const scans: Scan[] = [];

    const document = await new Promise<PdfDocument>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish();
          reject(new Error('Reading the PDF took too long and was stopped.'));
        }, TIMEOUT_MS);
      };

      const finish = (): void => {
        clearTimeout(timer);
        setJob((current) => (current?.id === id ? undefined : current));
      };

      const options = ocr === null ? null : { decoders, maxPages: MAX_SCANNED_PAGES };

      wait();
      setJob({
        id,
        // JSON.stringify makes each value a safe JavaScript string literal,
        // however many quotes, backslashes or line breaks the library holds.
        script: `window.__read(${String(id)}, ${JSON.stringify(lib)}, ${JSON.stringify(worker)}, ${JSON.stringify(data)}, ${JSON.stringify(options)}); true;`,
        scanned: (scan) => {
          scans.push(scan);
          wait();
        },
        resolve: (document) => {
          finish();
          resolve(document);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
    });

    if (ocr === null || scans.length === 0) return { ...document, engine: PDF_ENGINE_NAME };

    const pages = [...document.pages];
    for (const scan of scans) {
      const index = pages.findIndex((page) => page.number === scan.number);
      const page = pages[index];
      if (page === undefined) continue;
      pages[index] = await readScan(ocr, id, page, scan);
    }

    return { pages, engine: SCANNED_PDF_ENGINE_NAME, scannedPages: scans.length };
  }, []);

  const onMessage = (event: WebViewMessageEvent): void => {
    if (job === undefined) return;

    let reply: Reply;
    try {
      reply = JSON.parse(event.nativeEvent.data) as Reply;
    } catch {
      return;
    }

    if ('ready' in reply) {
      view.current?.injectJavaScript(job.script);
      return;
    }
    if (reply.id !== job.id) return;

    if ('scan' in reply) job.scanned(reply.scan);
    else if (reply.ok) job.resolve(reply.document);
    else job.reject(new Error(`The PDF could not be read: ${reply.error}`));
  };

  const host =
    job === undefined ? null : (
      <View style={styles.hidden} pointerEvents="none" accessibilityElementsHidden>
        <WebView
          key={job.id}
          ref={view}
          // A made-up https origin for an inline page: it gives blob: URLs an
          // origin to belong to, and nothing is ever loaded from it.
          source={{ html: PAGE, baseUrl: 'https://pdf-reader.invalid/' }}
          originWhitelist={['https://pdf-reader.invalid']}
          onMessage={onMessage}
          onError={() => {
            job.reject(new Error('The PDF reader could not start.'));
          }}
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          cacheEnabled={false}
          incognito
        />
      </View>
    );

  return { host, read };
}

/**
 * One scanned page, read by OCR. The picture goes to a file only because ML
 * Kit reads files; it is deleted whether or not the read succeeds.
 */
async function readScan(ocr: OcrEngine, id: number, page: PdfPage, scan: Scan): Promise<PdfPage> {
  const file = `${FileSystem.cacheDirectory ?? ''}pdf-scan-${String(id)}-${String(scan.number)}.jpg`;

  try {
    await FileSystem.writeAsStringAsync(file, scan.image, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const result = await ocr.recognize(file);
    return pageFromOcr(result, page, scan.scale);
  } finally {
    await FileSystem.deleteAsync(file, { idempotent: true });
  }
}

/**
 * The page pdf.js runs in.
 *
 * The content policy is the privacy guarantee in code: no `connect-src`, no
 * `img-src`, nothing that could carry a byte off the phone. Scripts may come
 * only from the page itself and from blob: URLs it makes out of the text
 * handed in; `wasm-unsafe-eval` lets it compile the image decoders handed in
 * the same way.
 *
 * Positions are flipped to top-left here, as the web reader does, so the
 * layout code downstream sees identical input from both.
 *
 * A page with no text is drawn at about 180 dpi — enough for ML Kit to read a
 * statement's small print — capped so a large page does not make a picture
 * too big to pass back.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:">
</head><body><script>
(function () {
  var SCAN_SCALE = 2.5;
  var MAX_SCAN_PIXELS = 2600;

  function post(message) { window.ReactNativeWebView.postMessage(JSON.stringify(message)); }
  function blobUrl(source) { return URL.createObjectURL(new Blob([source], { type: 'text/javascript' })); }
  function bytesOf(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // pdf.js asks for its decoders by file name. They are here already; there
  // is nowhere to fetch them from, and nothing else is ever handed out.
  function decoderFactory(decoders) {
    return class {
      async fetch(request) {
        const data = request.kind === 'wasmUrl' && decoders && decoders[request.filename];
        if (!data) throw new Error('Not available offline: ' + request.filename);
        return bytesOf(data);
      }
    };
  }

  async function drawPage(page, viewport) {
    const scale = Math.min(SCAN_SCALE, MAX_SCAN_PIXELS / Math.max(viewport.width, viewport.height));
    const scaled = page.getViewport({ scale: scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(scaled.width);
    canvas.height = Math.ceil(scaled.height);
    await page.render({ canvas: canvas, viewport: scaled, background: '#ffffff' }).promise;

    const image = canvas.toDataURL('image/jpeg', 0.9).split(',')[1] || '';
    canvas.width = 0;
    canvas.height = 0;
    return { scale: scale, image: image };
  }

  window.__read = async function (id, lib, worker, data, scan) {
    try {
      const pdfjs = await import(blobUrl(lib));
      pdfjs.GlobalWorkerOptions.workerSrc = blobUrl(worker);

      const task = pdfjs.getDocument({
        data: bytesOf(data),
        disableFontFace: true,
        isEvalSupported: false,
        useWorkerFetch: false,
        BinaryDataFactory: decoderFactory(scan && scan.decoders),
      });
      const loaded = await task.promise;

      const pages = [];
      let drawn = 0;
      for (let number = 1; number <= loaded.numPages; number += 1) {
        const page = await loaded.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();

        const items = [];
        for (const entry of content.items) {
          if (!('str' in entry) || entry.str.trim() === '') continue;
          items.push({
            text: entry.str.trim(),
            x: entry.transform[4] || 0,
            y: viewport.height - (entry.transform[5] || 0),
            width: entry.width,
            height: entry.height,
          });
        }
        pages.push({ number: number, width: viewport.width, height: viewport.height, items: items });

        if (items.length === 0 && scan && drawn < scan.maxPages) {
          drawn += 1;
          const picture = await drawPage(page, viewport);
          post({ id: id, scan: { number: number, scale: picture.scale, image: picture.image } });
        }
        page.cleanup();
      }

      await task.destroy();
      post({ id: id, ok: true, document: { pages: pages, engine: 'pdfjs' } });
    } catch (error) {
      post({ id: id, ok: false, error: String((error && error.message) || error) });
    }
  };

  post({ ready: true });
})();
</script></body></html>`;

const styles = StyleSheet.create({
  // On screen but invisible: a WebView with no size may never run its page.
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, left: 0, top: 0 },
});
