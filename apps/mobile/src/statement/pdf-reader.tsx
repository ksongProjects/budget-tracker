import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import type { PdfDocument } from '@budget/extract';
import pdfLibrary from '../../assets/pdfjs/pdf.min.mjs.txt';
import pdfWorker from '../../assets/pdfjs/pdf.worker.min.mjs.txt';

/**
 * Reading a PDF's text layer on the phone.
 *
 * The web app reads statements with pdf.js, and a browser engine is exactly
 * what Android already has in its WebView. So this is the same reader, the same
 * library version, run in a WebView the user never sees — producing the same
 * `PdfDocument` the web app's does, which then goes through the same rule sets
 * and the same column layout.
 *
 * Nothing leaves the phone. pdf.js ships inside the app (see
 * scripts/vendor-pdfjs.mjs), the page's content policy allows no network
 * request of any kind, and the PDF arrives as bytes passed in, not as a URL.
 */

export const PDF_ENGINE_NAME = 'pdfjs-webview';

/** Long enough for a fifty-page statement on a slow phone; short enough to give up on a hang. */
const TIMEOUT_MS = 60_000;

interface Job {
  readonly id: number;
  readonly script: string;
  readonly resolve: (document: PdfDocument) => void;
  readonly reject: (error: Error) => void;
}

type Reply =
  | { readonly ready: true }
  | { readonly id: number; readonly ok: true; readonly document: PdfDocument }
  | { readonly id: number; readonly ok: false; readonly error: string };

let library: Promise<{ lib: string; worker: string }> | undefined;

/** pdf.js as text, read from the app's own assets once per launch. */
function loadLibrary(): Promise<{ lib: string; worker: string }> {
  library ??= (async () => {
    const [lib, worker] = await Promise.all([readAsset(pdfLibrary), readAsset(pdfWorker)]);
    return { lib, worker };
  })();

  // A failed load should be retried next time, not remembered.
  library.catch(() => {
    library = undefined;
  });
  return library;
}

async function readAsset(module: number): Promise<string> {
  const asset = Asset.fromModule(module);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  return FileSystem.readAsStringAsync(uri);
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
    const [{ lib, worker }, data] = await Promise.all([
      loadLibrary(),
      FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
    ]);

    counter.current += 1;
    const id = counter.current;

    return new Promise<PdfDocument>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(new Error('Reading the PDF took too long and was stopped.'));
      }, TIMEOUT_MS);

      const finish = (): void => {
        clearTimeout(timer);
        setJob((current) => (current?.id === id ? undefined : current));
      };

      setJob({
        id,
        // JSON.stringify makes each value a safe JavaScript string literal,
        // however many quotes, backslashes or line breaks the library holds.
        script: `window.__read(${String(id)}, ${JSON.stringify(lib)}, ${JSON.stringify(worker)}, ${JSON.stringify(data)}); true;`,
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

    if (reply.ok) job.resolve({ ...reply.document, engine: PDF_ENGINE_NAME });
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
 * The page pdf.js runs in.
 *
 * The content policy is the privacy guarantee in code: no `connect-src`, no
 * `img-src`, nothing that could carry a byte off the phone. Scripts may come
 * only from the page itself and from blob: URLs it makes out of the text
 * handed in.
 *
 * Positions are flipped to top-left here, as the web reader does, so the
 * layout code downstream sees identical input from both.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:">
</head><body><script>
(function () {
  function post(message) { window.ReactNativeWebView.postMessage(JSON.stringify(message)); }
  function blobUrl(source) { return URL.createObjectURL(new Blob([source], { type: 'text/javascript' })); }

  window.__read = async function (id, lib, worker, data) {
    try {
      const pdfjs = await import(blobUrl(lib));
      pdfjs.GlobalWorkerOptions.workerSrc = blobUrl(worker);

      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

      const task = pdfjs.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false });
      const loaded = await task.promise;

      const pages = [];
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
